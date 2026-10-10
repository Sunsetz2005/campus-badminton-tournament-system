import { createHash } from "node:crypto";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { normalizeReason } from "@/domain/registration/registration-rules";
import { RUBBER_LABEL, type RubberKind } from "@/domain/registration/team-roster";
import { checkSchedule, warningDigest, type ScheduleCheckResult } from "@/domain/schedule/check";
import { delayCauseText } from "@/domain/schedule/delay";
import { MINUTE, isMovable, type Placement } from "@/domain/schedule/model";
import { suggestSchedule, UNPLACED_TEXT, type UnplacedReason } from "@/domain/schedule/suggest";
import { isValidTimeZone, utcToZonedLocal, zonedLocalToUtc } from "@/domain/time/zoned-time";
import { requireManagedTournament, TOURNAMENT_MANAGER_ROLES } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import { lockTournamentRow } from "@/server/services/registration-service";
import {
  dayWindow,
  defaultDurationOf,
  loadScheduleConfig,
  loadPublishedDelays,
  loadScheduleFacts,
  minuteText,
  samePlacement,
  type ScheduleFacts,
} from "@/server/services/schedule-facts";

/**
 * 赛程与裁判排班的服务端命令（阶段 4-C）。
 *
 * 流程：设置场地/比赛日/预计时长 → 自动建议或手工编辑「草稿」→ 每次改动后立即复检 →
 * 没有硬冲突、且逐项确认过警告后「发布」。发布同时：写入比赛的计划时间/场地、
 * 同步主裁判指派（即「我的执裁」）、让已排定的比赛进入公开赛程，并保存版本与差异。
 *
 * 已开始的比赛不会被移动：草稿不能改它，发布也不会改它（数据库触发器兜底）。
 * 临时更换裁判走裁判长命令，与设备接管规则衔接（吊销旧控制会话）。
 */

type Tx = Prisma.TransactionClient;

export const SCHEDULE_MANAGER_ROLES = TOURNAMENT_MANAGER_ROLES;

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function audit(client: Tx, tournamentId: string, actorUserId: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) {
  await client.auditLog.create({
    data: { tournamentId, actorUserId, action, targetType, targetId, outcome: "SUCCESS", metadata: asJson(metadata) },
  });
}

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown, message = "输入无效。"): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new AppError(400, "invalid_input", issue?.message && issue.message !== "Invalid input" ? issue.message : message);
  }
  return result.data;
}

async function managedTournament(actorUserId: string, slug: string) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, [...SCHEDULE_MANAGER_ROLES]);
  if (!isValidTimeZone(tournament.timezone)) throw new AppError(409, "invalid_timezone", "赛事时区配置无效，不能排赛程。");
  return tournament;
}

function assertNotFinished(phase: string) {
  if (phase === "FINISHED") throw new AppError(409, "tournament_finished", "赛事已结束，不能再调整赛程。");
}

function localToUtc(local: string, timeZone: string, label: string) {
  const value = zonedLocalToUtc(local, timeZone);
  if (!value) throw new AppError(400, "invalid_time", `${label}不是赛事时区（${timeZone}）下的有效时间。`);
  return value;
}

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------

/** 草稿里改过、但之后已经开始的比赛。 */
function lockedChanges(facts: ScheduleFacts) {
  return facts.rows
    .filter((row) => row.scheduleSlot && !isMovable(facts.factById.get(row.id)!))
    .filter((row) => !samePlacement(facts.draft.get(row.id)!, facts.published.get(row.id)!))
    .map((row) => row.id);
}

export function checkDraft(facts: ScheduleFacts, focus?: ReadonlySet<string>): ScheduleCheckResult {
  return checkSchedule({
    matches: facts.facts,
    placements: facts.draft,
    courts: facts.courts,
    referees: facts.referees,
    refereesRequired: facts.refereeMode === "PER_MATCH",
    windows: facts.windows,
    names: facts.names,
    focus,
    lockedChanges: lockedChanges(facts),
  });
}

export function checkPublished(facts: ScheduleFacts): ScheduleCheckResult {
  return checkSchedule({
    matches: facts.facts,
    placements: facts.published,
    courts: facts.courts,
    referees: facts.referees,
    refereesRequired: facts.refereeMode === "PER_MATCH",
    windows: facts.windows,
    names: facts.names,
  });
}

export function hashWarnings(result: ScheduleCheckResult) {
  return createHash("sha256").update(warningDigest(result.issues)).digest("hex");
}

export function draftChanges(facts: ScheduleFacts) {
  return facts.rows.filter((row) => row.scheduleSlot && !samePlacement(facts.draft.get(row.id)!, facts.published.get(row.id)!)).map((row) => row.id);
}

async function checkResponse(tournamentId: string, focusMatchIds?: string[]) {
  const facts = await loadScheduleFacts(prisma, tournamentId);
  const all = checkDraft(facts);
  const focus = focusMatchIds ? checkDraft(facts, new Set(focusMatchIds)) : null;
  return {
    hardCount: all.hardCount,
    warningCount: all.warningCount,
    scheduledCount: all.scheduledCount,
    unscheduledCount: all.unscheduledCount,
    draftChangeCount: draftChanges(facts).length,
    focusIssues: focus?.issues ?? [],
  };
}

// ---------------------------------------------------------------------------
// 设置：预计时长、名单截止、场地、比赛日
// ---------------------------------------------------------------------------

const configSchema = z.object({
  matchMinutes: z.number().int().min(5, "个人项目预计时长至少 5 分钟").max(300),
  rubberMinutes: z.number().int().min(5, "团体小场预计时长至少 5 分钟").max(300),
  changeoverMinutes: z.number().int().min(0).max(60, "换场时间最多 60 分钟"),
  knockoutTieCourts: z.number().int().min(1).max(9),
  lineupDeadlineMinutes: z.number().int().min(0).max(1440),
});

export async function updateScheduleConfig(actorUserId: string, slug: string, rawInput: unknown) {
  const tournament = await managedTournament(actorUserId, slug);
  const input = parseOrThrow(configSchema, rawInput, "赛程设置无效。");
  return prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    await transaction.scheduleConfig.upsert({ where: { tournamentId: tournament.id }, create: { tournamentId: tournament.id, ...input }, update: input });
    await audit(transaction, tournament.id, actorUserId, "SCHEDULE_CONFIG_UPDATED", "Tournament", tournament.id, input);
    return input;
  });
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const daysSchema = z.object({
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD"),
        start: z.string().regex(HH_MM, "开始时间格式应为 HH:mm"),
        end: z.string().regex(HH_MM, "结束时间格式应为 HH:mm"),
      }),
    )
    .max(31, "最多设置 31 个比赛日"),
});

function minutesOf(text: string) {
  const [hour, minute] = text.split(":").map(Number);
  return hour * 60 + minute;
}

/** 整体替换比赛日列表。只影响之后的自动建议与「超出开放时段」提示，不移动已排比赛。 */
export async function replaceScheduleDays(actorUserId: string, slug: string, rawInput: unknown) {
  const tournament = await managedTournament(actorUserId, slug);
  const { days } = parseOrThrow(daysSchema, rawInput, "比赛日设置无效。");
  const rows = days.map((day) => ({ day: day.date, startMinute: minutesOf(day.start), endMinute: minutesOf(day.end) }));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.day)) throw new AppError(400, "duplicate_day", `${row.day} 重复设置。`);
    seen.add(row.day);
    if (row.startMinute >= row.endMinute) throw new AppError(400, "invalid_window", `${row.day} 的开始时间必须早于结束时间。`);
    if (!dayWindow(row.day, row.startMinute, row.endMinute, tournament.timezone)) {
      throw new AppError(400, "invalid_window", `${row.day} 不是赛事时区下的有效日期或时段。`);
    }
  }
  return prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    await transaction.scheduleDay.deleteMany({ where: { tournamentId: tournament.id } });
    if (rows.length) {
      await transaction.scheduleDay.createMany({
        data: rows.map((row) => ({ tournamentId: tournament.id, day: new Date(`${row.day}T00:00:00Z`), startMinute: row.startMinute, endMinute: row.endMinute })),
      });
    }
    await audit(transaction, tournament.id, actorUserId, "SCHEDULE_DAYS_REPLACED", "Tournament", tournament.id, { days });
    return { days: rows.length };
  });
}

const courtsSchema = z.object({ count: z.number().int().min(1).max(40), namePrefix: z.string().trim().max(12).nullish() });

/** 按数量追加场地（编号接着已有场地往后排）。 */
export async function addCourts(actorUserId: string, slug: string, rawInput: unknown) {
  const tournament = await managedTournament(actorUserId, slug);
  const input = parseOrThrow(courtsSchema, rawInput, "场地数量须为 1—40。");
  return prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    const existing = await transaction.court.findMany({ where: { tournamentId: tournament.id }, select: { code: true, sortOrder: true } });
    if (existing.length + input.count > 40) throw new AppError(400, "too_many_courts", "一个赛事最多 40 块场地。");
    const used = new Set(existing.map((court) => court.code));
    let order = existing.reduce((max, court) => Math.max(max, court.sortOrder), 0);
    let number = 1;
    const created: string[] = [];
    while (created.length < input.count) {
      const code = `C${number}`;
      number += 1;
      if (used.has(code)) continue;
      order += 1;
      await transaction.court.create({
        data: { tournamentId: tournament.id, code, name: `${input.namePrefix || "场地"} ${number - 1}`, sortOrder: order },
      });
      created.push(code);
    }
    await audit(transaction, tournament.id, actorUserId, "COURTS_ADDED", "Tournament", tournament.id, { codes: created });
    return { created };
  });
}

const courtUpdateSchema = z.object({
  name: z.string().trim().min(1, "场地名称不能为空").max(20).optional(),
  active: z.boolean().optional(),
});

/** 改场地名称或关闭/重新开放场地。关闭不会移动已排比赛，而是在检查中显示为硬冲突，需要调整后重新发布。 */
export async function updateCourt(actorUserId: string, slug: string, courtCode: string, rawInput: unknown) {
  const tournament = await managedTournament(actorUserId, slug);
  const input = parseOrThrow(courtUpdateSchema, rawInput, "场地设置无效。");
  return prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    const court = await transaction.court.findUnique({ where: { tournamentId_code: { tournamentId: tournament.id, code: courtCode } } });
    if (!court) throw new AppError(404, "court_not_found", "场地不存在。");
    const updated = await transaction.court.update({ where: { id: court.id }, data: input, select: { code: true, name: true, active: true } });
    const affected = input.active === false
      ? await transaction.match.count({ where: { courtId: court.id, scheduledAt: { not: null }, version: 0, lifecycleStatus: { in: ["SCHEDULED", "READY"] } } })
      : 0;
    await audit(transaction, tournament.id, actorUserId, input.active === false ? "COURT_CLOSED" : "COURT_UPDATED", "Court", court.id, {
      code: court.code,
      ...input,
      affectedPublishedMatches: affected,
    });
    return { ...updated, affectedPublishedMatches: affected };
  });
}

// ---------------------------------------------------------------------------
// 草稿编辑
// ---------------------------------------------------------------------------

async function loadMatchInTournament(transaction: Tx, tournamentId: string, matchCode: string) {
  const match = await transaction.match.findFirst({
    where: { code: matchCode, stage: { competition: { tournamentId } } },
    select: { id: true, code: true, version: true, lifecycleStatus: true, notPlayedAt: true, rubberKind: true },
  });
  if (!match) throw new AppError(404, "match_not_found", "比赛不存在。");
  return match;
}

function assertMatchMovable(match: { version: number; lifecycleStatus: string; notPlayedAt: Date | null }) {
  if (match.notPlayedAt) throw new AppError(409, "rubber_not_played", "该小场已记为未进行，不需要排时间。");
  if (match.version > 0 || !["SCHEDULED", "READY"].includes(match.lifecycleStatus)) {
    throw new AppError(409, "match_started", "比赛已经开始，不能再调整时间和场地；临时换裁判请由裁判长操作。");
  }
}

async function assertReferee(transaction: Tx, tournamentId: string, userId: string) {
  const role = await transaction.roleAssignment.findFirst({
    where: { tournamentId, userId, role: "REFEREE", user: { status: "ACTIVE" } },
    select: { id: true },
  });
  if (!role) throw new AppError(400, "not_referee", "只能指派本赛事的裁判员。");
}

const slotSchema = z.object({
  courtCode: z.string().trim().max(16).nullable(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "开始时间格式无效").nullable(),
  durationMinutes: z.number().int().min(5, "预计时长至少 5 分钟").max(300, "预计时长最多 300 分钟"),
  refereeUserId: z.string().uuid().nullable(),
  estimated: z.boolean().optional(),
});

/**
 * 手工调整一场比赛的草稿安排（场地、开始时间、预计时长、主裁判）。
 * 场地与开始时间要么都填、要么都清空（清空表示本场暂不排时间）。改完立即返回复检结果。
 */
export async function saveDraftSlot(actorUserId: string, slug: string, matchCode: string, rawInput: unknown) {
  const tournament = await managedTournament(actorUserId, slug);
  const input = parseOrThrow(slotSchema, rawInput, "赛程调整内容无效。");
  if ((input.courtCode === null) !== (input.start === null)) {
    throw new AppError(400, "court_and_time_required", "场地和开始时间要一起填写，或一起清空。");
  }
  const matchId = await prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    const detail = await transaction.tournament.findUniqueOrThrow({ where: { id: tournament.id }, select: { phase: true } });
    assertNotFinished(detail.phase);
    const match = await loadMatchInTournament(transaction, tournament.id, matchCode);
    assertMatchMovable(match);
    let courtId: string | null = null;
    if (input.courtCode) {
      const court = await transaction.court.findUnique({ where: { tournamentId_code: { tournamentId: tournament.id, code: input.courtCode } } });
      if (!court) throw new AppError(404, "court_not_found", "场地不存在。");
      courtId = court.id;
    }
    if (input.refereeUserId) await assertReferee(transaction, tournament.id, input.refereeUserId);
    const startsAt = input.start ? localToUtc(input.start, tournament.timezone, "开始时间") : null;
    const data = {
      courtId,
      startsAt,
      durationMinutes: input.durationMinutes,
      refereeUserId: input.refereeUserId,
      estimated: startsAt ? input.estimated ?? false : false,
      updatedByUserId: actorUserId,
    };
    await transaction.scheduleSlot.upsert({
      where: { matchId: match.id },
      create: { tournamentId: tournament.id, matchId: match.id, ...data },
      update: data,
    });
    return match.id;
  });
  return checkResponse(tournament.id, [matchId]);
}

/** 放弃一场比赛的草稿改动，恢复为已发布的安排。 */
export async function discardDraftSlot(actorUserId: string, slug: string, matchCode: string) {
  const tournament = await managedTournament(actorUserId, slug);
  await prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    const match = await loadMatchInTournament(transaction, tournament.id, matchCode);
    await transaction.scheduleSlot.deleteMany({ where: { matchId: match.id } });
  });
  return checkResponse(tournament.id);
}

/** 放弃全部草稿改动。 */
export async function discardDraft(actorUserId: string, slug: string) {
  const tournament = await managedTournament(actorUserId, slug);
  const removed = await prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    const result = await transaction.scheduleSlot.deleteMany({ where: { tournamentId: tournament.id } });
    await audit(transaction, tournament.id, actorUserId, "SCHEDULE_DRAFT_DISCARDED", "Tournament", tournament.id, { removed: result.count });
    return result.count;
  });
  return { removed, ...(await checkResponse(tournament.id)) };
}

const relayoutSchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "开始时间格式无效"),
  courtCodes: z.array(z.string().trim().max(16)).min(1, "至少选择 1 块场地").max(9),
});

/**
 * 整场团体对抗重排：给定第一个小场的开始时间和使用的场地，未开始的小场按顺序轮流分配到这些场地、依次往后排。
 * 裁判沿用草稿中的指派。
 */
export async function relayoutTie(actorUserId: string, slug: string, fixtureId: string, rawInput: unknown) {
  const tournament = await managedTournament(actorUserId, slug);
  const input = parseOrThrow(relayoutSchema, rawInput, "整场重排内容无效。");
  if (new Set(input.courtCodes).size !== input.courtCodes.length) throw new AppError(400, "duplicate_court", "场地不能重复选择。");
  const start = localToUtc(input.start, tournament.timezone, "开始时间").getTime();
  const matchIds = await prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    const facts = await loadScheduleFacts(transaction, tournament.id);
    const fixture = facts.fixtureById.get(fixtureId);
    if (!fixture) throw new AppError(404, "fixture_not_found", "对抗不存在。");
    const courts = input.courtCodes.map((code) => {
      const court = facts.courts.find((item) => item.code === code);
      if (!court) throw new AppError(404, "court_not_found", `场地 ${code} 不存在。`);
      return court;
    });
    const rows = facts.rows
      .filter((row) => row.fixtureId === fixtureId && row.rubberOrder)
      .sort((left, right) => (left.rubberOrder ?? 0) - (right.rubberOrder ?? 0));
    const movable = rows.filter((row) => isMovable(facts.factById.get(row.id)!));
    if (!movable.length) throw new AppError(409, "match_started", "这场对抗的小场都已开始或结束，不能整场重排。");
    const changeover = facts.config.changeoverMinutes * MINUTE;
    const courtFree = new Map(courts.map((court) => [court.id, start]));
    for (const [index, row] of movable.entries()) {
      const court = courts[index % courts.length];
      const begin = courtFree.get(court.id) as number;
      const draft = facts.draft.get(row.id)!;
      const duration = draft.start !== null ? draft.durationMinutes : defaultDurationOf(row, facts.config);
      courtFree.set(court.id, begin + duration * MINUTE + changeover);
      const data = {
        courtId: court.id,
        startsAt: new Date(begin),
        durationMinutes: duration,
        refereeUserId: draft.refereeId,
        estimated: begin !== start,
        updatedByUserId: actorUserId,
      };
      await transaction.scheduleSlot.upsert({ where: { matchId: row.id }, create: { tournamentId: tournament.id, matchId: row.id, ...data }, update: data });
    }
    return movable.map((row) => row.id);
  });
  return checkResponse(tournament.id, matchIds);
}

const suggestSchema = z.object({
  competitionCode: z.string().trim().max(16).nullish(),
  stage: z.enum(["ALL", "GROUPS", "KNOCKOUT"]).default("ALL"),
  notBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullish(),
  assignReferees: z.boolean().default(true),
});

/**
 * 自动建议：对选定范围内尚未开始的比赛重新生成草稿安排（场地、时间、裁判）。
 * 范围外的比赛和已经开始的比赛保持不动并视为占用。排不下的比赛在草稿中撤下时间并列出原因。
 */
export async function suggestDraft(actorUserId: string, slug: string, rawInput: unknown) {
  const tournament = await managedTournament(actorUserId, slug);
  const input = parseOrThrow(suggestSchema, rawInput ?? {}, "自动建议的范围无效。");
  const now = new Date();
  const outcome = await prisma.$transaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const detail = await transaction.tournament.findUniqueOrThrow({ where: { id: tournament.id }, select: { phase: true } });
      assertNotFinished(detail.phase);
      const facts = await loadScheduleFacts(transaction, tournament.id);
      const scope = new Set(
        facts.facts
          .filter((fact) => isMovable(fact))
          .filter((fact) => !input.competitionCode || fact.competitionCode === input.competitionCode)
          .filter((fact) => input.stage === "ALL" || (input.stage === "GROUPS" ? fact.stageOrder === 1 : fact.stageOrder > 1))
          .map((fact) => fact.id),
      );
      if (!scope.size) throw new AppError(409, "nothing_to_schedule", "所选范围内没有尚未开始的比赛。");
      const activeCourts = facts.courts.filter((court) => court.active).map((court) => court.id);
      // 缺场地或比赛日时整批都排不下：直接拒绝，不写一份全空的草稿让人误以为排过了。
      if (!activeCourts.length) throw new AppError(409, "no_courts", "还没有可用的场地。请先在「场地与时段」里添加场地，再生成赛程。");
      if (!facts.windows.length) {
        throw new AppError(409, "no_schedule_days", "还没有设置比赛日与开放时段。请先在「场地与时段」里填写每个比赛日的开始和结束时间，再生成赛程。");
      }
      const notBefore = input.notBefore ? localToUtc(input.notBefore, tournament.timezone, "最早开始时间") : now;
      const suggestInput = {
        matches: facts.facts,
        scope,
        current: facts.draft,
        courtIds: activeCourts,
        // 共用裁判账号模式不逐场指派主裁判。
        refereeIds: input.assignReferees && facts.refereeMode === "PER_MATCH" ? facts.referees.map((referee) => referee.id) : [],
        windows: facts.windows,
        notBefore: Math.max(notBefore.getTime(), now.getTime()),
        config: facts.config,
      };
      const result = suggestSchedule(suggestInput);
      const shortfall = result.unplaced.some((item) => item.reason === "DOES_NOT_FIT")
        ? estimateLastDayShortfall(facts, suggestInput)
        : null;
      const placed = new Map(result.placements.map((placement) => [placement.matchId, placement]));
      for (const matchId of scope) {
        const placement = placed.get(matchId);
        const row = facts.rowById.get(matchId)!;
        const data = placement
          ? {
              courtId: placement.courtId,
              startsAt: new Date(placement.start as number),
              durationMinutes: placement.durationMinutes,
              refereeUserId: input.assignReferees ? placement.refereeId : facts.draft.get(matchId)!.refereeId,
              estimated: placement.estimated,
              updatedByUserId: actorUserId,
            }
          : {
              courtId: null,
              startsAt: null,
              durationMinutes: defaultDurationOf(row, facts.config),
              refereeUserId: facts.draft.get(matchId)!.refereeId,
              estimated: false,
              updatedByUserId: actorUserId,
            };
        await transaction.scheduleSlot.upsert({ where: { matchId }, create: { tournamentId: tournament.id, matchId, ...data }, update: data });
      }
      const reasons = new Map<UnplacedReason, number>();
      for (const item of result.unplaced) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
      await audit(transaction, tournament.id, actorUserId, "SCHEDULE_SUGGESTED", "Tournament", tournament.id, {
        competitionCode: input.competitionCode ?? null,
        stage: input.stage,
        scope: scope.size,
        placed: result.placements.length,
        unplaced: result.unplaced.length,
      });
      return {
        scope: scope.size,
        placed: result.placements.length,
        unplaced: [...reasons.entries()].map(([reason, count]) => ({ reason, text: UNPLACED_TEXT[reason], count })),
        shortfall,
      };
    },
    { timeout: 60_000 },
  );
  return { ...outcome, ...(await checkResponse(tournament.id)) };
}

/**
 * 排不下时估算还差多少时间：把最后一个比赛日的结束时间放宽到当天 24:00 重算一遍，
 * 取全部比赛排下所需的最晚结束时刻（向上取整到 5 分钟）。放宽到 24:00 仍排不下，说明需要增加比赛日。
 * 只用于提示，不写入任何安排。
 */
function estimateLastDayShortfall(facts: ScheduleFacts, input: Parameters<typeof suggestSchedule>[0]): ScheduleShortfall | null {
  const lastDay = facts.days.at(-1);
  if (!lastDay) return null;
  const extended = dayWindow(lastDay.day, lastDay.startMinute, 1440, facts.timeZone);
  if (!extended) return null;
  // 最后一个比赛日与其放宽后的时段起点相同：替换那一段，其余比赛日不变。
  const windows = [...input.windows.filter((window) => window.start !== extended.start), extended];
  const retry = suggestSchedule({ ...input, windows });
  const base = { date: lastDay.day, currentEnd: minuteText(lastDay.endMinute) };
  if (retry.unplaced.some((item) => item.reason === "DOES_NOT_FIT")) return { ...base, requiredEnd: null };
  const latest = Math.max(...retry.placements.map((placement) => (placement.start as number) + placement.durationMinutes * MINUTE));
  const rounded = Math.ceil(latest / (5 * MINUTE)) * 5 * MINUTE;
  const local = utcToZonedLocal(new Date(rounded), facts.timeZone);
  // 恰好到午夜时本地日期会跳到次日，按 24:00 表示。
  const requiredEnd = local.slice(0, 10) === lastDay.day ? local.slice(11, 16) : "24:00";
  return { ...base, requiredEnd };
}

export interface ScheduleShortfall {
  /** 最后一个比赛日（赛事时区，YYYY-MM-DD）。 */
  date: string;
  currentEnd: string;
  /** 全部排下需要的结束时间（HH:mm）；null 表示当天放宽到 24:00 也排不下，需要增加比赛日。 */
  requiredEnd: string | null;
}

/**
 * 抽签发布后自动生成该项目的赛程草稿（不发布）。
 * 只在已有可用场地与比赛日、且该项目的比赛还没有任何安排时执行；条件不满足或失败都不影响抽签发布本身。
 */
export async function autoScheduleAfterDraw(actorUserId: string, slug: string, competitionCode: string) {
  const tournament = await managedTournament(actorUserId, slug);
  const [courts, days, arranged] = await Promise.all([
    prisma.court.count({ where: { tournamentId: tournament.id, active: true } }),
    prisma.scheduleDay.count({ where: { tournamentId: tournament.id } }),
    prisma.match.count({
      where: {
        stage: { competition: { tournamentId: tournament.id, code: competitionCode } },
        OR: [{ scheduledAt: { not: null } }, { scheduleSlot: { startsAt: { not: null } } }],
      },
    }),
  ]);
  if (!courts || !days) return { status: "SKIPPED_NOT_CONFIGURED" as const };
  if (arranged) return { status: "SKIPPED_ALREADY_ARRANGED" as const };
  const result = await suggestDraft(actorUserId, slug, { competitionCode, stage: "ALL" });
  return { status: "GENERATED" as const, ...result };
}

// ---------------------------------------------------------------------------
// 发布
// ---------------------------------------------------------------------------

const publishSchema = z.object({
  warningDigest: z.string().max(128),
  note: z.string().max(400).nullish(),
});

interface SnapshotItem {
  code: string;
  court: string | null;
  start: string | null;
  end: string | null;
  referee: string | null;
  estimated: boolean;
}

/**
 * 发布草稿赛程。存在任何硬冲突时拒绝；警告必须与发布者确认时看到的完全一致（摘要比对）。
 * 同一事务内：写入计划时间/场地/预计标记，同步主裁判指派并吊销被换下裁判的控制会话，
 * 让已排定时间的比赛进入公开赛程，保存版本快照与差异，清空草稿。
 */
export async function publishSchedule(actorUserId: string, slug: string, rawInput: unknown) {
  const tournament = await managedTournament(actorUserId, slug);
  const input = parseOrThrow(publishSchema, rawInput, "发布请求无效。");
  const note = input.note ? normalizeReason(input.note) : null;

  return prisma.$transaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const detail = await transaction.tournament.findUniqueOrThrow({ where: { id: tournament.id }, select: { phase: true } });
      assertNotFinished(detail.phase);
      const facts = await loadScheduleFacts(transaction, tournament.id);
      const check = checkDraft(facts);
      if (check.hardCount > 0) {
        throw new AppError(409, "schedule_has_conflicts", `草稿还有 ${check.hardCount} 个硬冲突，不能发布。`, {
          issues: check.issues.filter((issue) => issue.severity === "HARD").slice(0, 50),
        });
      }
      if (hashWarnings(check) !== input.warningDigest) {
        throw new AppError(409, "warnings_changed", "需要确认的警告已经变化，请刷新后重新核对再发布。");
      }

      const now = new Date();
      const courtCode = new Map(facts.courts.map((court) => [court.id, court.code]));
      const refereeName = new Map(facts.referees.map((referee) => [referee.id, referee.name]));
      const describe = (placement: Placement) => ({
        court: placement.courtId ? courtCode.get(placement.courtId) ?? null : null,
        start: placement.start !== null ? new Date(placement.start).toISOString() : null,
        referee: placement.refereeId ? refereeName.get(placement.refereeId) ?? placement.refereeId : null,
      });
      const changes = { added: [] as string[], moved: [] as { code: string; from: unknown; to: unknown }[], removed: [] as string[], referee: [] as { code: string; from: string | null; to: string | null }[] };
      let revokedSessions = 0;

      for (const matchId of draftChanges(facts)) {
        const row = facts.rowById.get(matchId)!;
        const next = facts.draft.get(matchId)!;
        const previous = facts.published.get(matchId)!;
        if (!isMovable(facts.factById.get(matchId)!)) continue; // 已由硬冲突拦截，这里只是防御。
        const timeChanged = previous.courtId !== next.courtId || previous.start !== next.start || previous.durationMinutes !== next.durationMinutes || previous.estimated !== next.estimated;
        if (timeChanged) {
          const scheduledAt = next.start !== null ? new Date(next.start) : null;
          // 行锁后再确认仍未开始；数据库触发器也会拒绝移动已开始的比赛。
          await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${matchId}::uuid FOR UPDATE`;
          const current = await transaction.match.findUniqueOrThrow({ where: { id: matchId }, select: { version: true, lifecycleStatus: true } });
          if (current.version > 0 || !["SCHEDULED", "READY"].includes(current.lifecycleStatus)) {
            throw new AppError(409, "match_started", `${row.code} 在发布过程中已经开始，已取消本次发布，请刷新后重试。`);
          }
          await transaction.match.update({
            where: { id: matchId },
            data: {
              courtId: next.start !== null ? next.courtId : null,
              scheduledAt,
              scheduledEndAt: scheduledAt ? new Date(scheduledAt.getTime() + next.durationMinutes * MINUTE) : null,
              scheduleEstimated: scheduledAt ? next.estimated : false,
            },
          });
          if (previous.start === null && next.start !== null) changes.added.push(row.code);
          else if (previous.start !== null && next.start === null) changes.removed.push(row.code);
          else if (previous.courtId !== next.courtId || previous.start !== next.start) changes.moved.push({ code: row.code, from: describe(previous), to: describe(next) });
        }
        if (previous.refereeId !== next.refereeId) {
          await transaction.officialAssignment.updateMany({
            where: { matchId, role: "MAIN_REFEREE", active: true, ...(next.refereeId ? { userId: { not: next.refereeId } } : {}) },
            data: { active: false },
          });
          if (next.refereeId) {
            await transaction.officialAssignment.upsert({
              where: { matchId_userId_role: { matchId, userId: next.refereeId, role: "MAIN_REFEREE" } },
              create: { matchId, userId: next.refereeId, role: "MAIN_REFEREE", active: true },
              update: { active: true },
            });
          }
          // 被换下的裁判如果已经打开了这场的工作台，立即吊销其控制会话（比赛尚未开始，不丢任何计分）。
          const revoked = await transaction.scoringSession.updateMany({
            where: { matchId, status: "ACTIVE", ...(next.refereeId ? { userId: { not: next.refereeId } } : {}) },
            data: { status: "REVOKED", revokedAt: now, revokedReason: "REFEREE_REASSIGNED" },
          });
          revokedSessions += revoked.count;
          changes.referee.push({
            code: row.code,
            from: previous.refereeId ? refereeName.get(previous.refereeId) ?? previous.refereeId : null,
            to: next.refereeId ? refereeName.get(next.refereeId) ?? next.refereeId : null,
          });
        }
      }

      // 已排定时间的比赛一并进入公开赛程（2026-09-25 用户决定）；公开内容仍受姓名公开策略约束。
      const madePublic = await transaction.match.updateMany({
        where: { stage: { competition: { tournamentId: tournament.id } }, scheduledAt: { not: null }, publishedAt: null },
        data: { publishedAt: now },
      });

      const latest = await transaction.schedulePublication.findFirst({ where: { tournamentId: tournament.id }, orderBy: { version: "desc" }, select: { version: true } });
      const version = (latest?.version ?? 0) + 1;
      const scheduled = await transaction.match.findMany({
        where: { stage: { competition: { tournamentId: tournament.id } }, scheduledAt: { not: null } },
        select: {
          code: true,
          courtId: true,
          scheduledAt: true,
          scheduledEndAt: true,
          scheduleEstimated: true,
          officialAssignments: { where: { active: true, role: "MAIN_REFEREE" }, select: { userId: true }, take: 1 },
        },
        orderBy: [{ scheduledAt: "asc" }, { code: "asc" }],
      });
      const snapshot: SnapshotItem[] = scheduled.map((match) => ({
        code: match.code,
        court: match.courtId ? courtCode.get(match.courtId) ?? null : null,
        start: match.scheduledAt?.toISOString() ?? null,
        end: match.scheduledEndAt?.toISOString() ?? null,
        referee: match.officialAssignments[0]?.userId ?? null,
        estimated: match.scheduleEstimated,
      }));
      const warnings = check.issues.filter((issue) => issue.severity === "WARNING").map((issue) => ({ code: issue.code, message: issue.message }));
      const publication = await transaction.schedulePublication.create({
        data: {
          tournamentId: tournament.id,
          version,
          publishedAt: now,
          publishedByUserId: actorUserId,
          matchCount: snapshot.length,
          snapshot: asJson(snapshot),
          changes: asJson({ ...changes, madePublic: madePublic.count, revokedSessions }),
          warnings: asJson(warnings),
          note,
        },
        select: { id: true },
      });
      await transaction.scheduleSlot.deleteMany({ where: { tournamentId: tournament.id } });
      await audit(transaction, tournament.id, actorUserId, "SCHEDULE_PUBLISHED", "SchedulePublication", publication.id, {
        version,
        added: changes.added.length,
        moved: changes.moved.length,
        removed: changes.removed.length,
        refereeChanged: changes.referee.length,
        madePublic: madePublic.count,
        revokedSessions,
        acknowledgedWarnings: warnings.length,
      });
      return {
        version,
        added: changes.added.length,
        moved: changes.moved.length,
        removed: changes.removed.length,
        refereeChanged: changes.referee.length,
        madePublic: madePublic.count,
        acknowledgedWarnings: warnings.length,
      };
    },
    { timeout: 60_000 },
  );
}

// ---------------------------------------------------------------------------
// 临时更换裁判（裁判长）
// ---------------------------------------------------------------------------

const replaceSchema = z.object({ refereeUserId: z.string().uuid(), reason: z.string().max(400) });

/**
 * 裁判长临时更换一场比赛的主裁判（含已开始的比赛）。必须写原因。
 * 同一事务内：停用原指派、启用新指派、吊销该场全部活动控制会话；新裁判进入工作台后按接管规则取得控制（控制代次递增），
 * 旧设备之后的任何写入都会因指派与会话失效而被拒绝。已结束并提交的比赛不能再换裁判。
 */
export async function replaceMatchReferee(actorUserId: string, slug: string, matchCode: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["CHIEF_REFEREE"]);
  const parsed = replaceSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "更换裁判的请求无效。");
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "临时更换裁判必须写明原因。");
  const newRefereeId = parsed.data.refereeUserId;

  return prisma.$transaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const match = await transaction.match.findFirst({
        where: { code: matchCode, stage: { competition: { tournamentId: tournament.id } } },
        select: {
          id: true,
          code: true,
          lifecycleStatus: true,
          notPlayedAt: true,
          scheduledAt: true,
          scheduledEndAt: true,
          startedAt: true,
          rubberKind: true,
          officialAssignments: { where: { active: true, role: "MAIN_REFEREE" }, select: { userId: true } },
        },
      });
      if (!match) throw new AppError(404, "match_not_found", "比赛不存在。");
      await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${match.id}::uuid FOR UPDATE`;
      if (match.notPlayedAt || match.lifecycleStatus === "SUBMITTED") {
        throw new AppError(409, "match_finished", "比赛已结束提交或记为未进行，不能再更换裁判。");
      }
      await assertReferee(transaction, tournament.id, newRefereeId);
      const previous = match.officialAssignments.map((item) => item.userId);
      if (previous.length === 1 && previous[0] === newRefereeId) {
        throw new AppError(409, "same_referee", "新裁判与当前裁判相同。");
      }
      const busy = await transaction.match.findFirst({
        where: {
          id: { not: match.id },
          lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] },
          officialAssignments: { some: { userId: newRefereeId, active: true, role: "MAIN_REFEREE" } },
        },
        select: { code: true },
      });
      if (busy) throw new AppError(409, "referee_busy", `该裁判正在执裁 ${busy.code}，不能同时执裁两场。`);

      const now = new Date();
      await transaction.officialAssignment.updateMany({
        where: { matchId: match.id, role: "MAIN_REFEREE", active: true, userId: { not: newRefereeId } },
        data: { active: false },
      });
      await transaction.officialAssignment.upsert({
        where: { matchId_userId_role: { matchId: match.id, userId: newRefereeId, role: "MAIN_REFEREE" } },
        create: { matchId: match.id, userId: newRefereeId, role: "MAIN_REFEREE", active: true },
        update: { active: true },
      });
      const revoked = await transaction.scoringSession.updateMany({
        where: { matchId: match.id, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now, revokedReason: "REFEREE_REPLACED" },
      });
      // 新裁判在已发布赛程里与这场时间重叠的其他比赛：临场换人不因此拒绝，但如实返回，由裁判长决定是否再调整。
      const config = await loadScheduleConfig(transaction, tournament.id);
      const begin = match.startedAt ?? match.scheduledAt;
      const finish = begin
        ? match.scheduledEndAt && !match.startedAt
          ? match.scheduledEndAt
          : new Date(begin.getTime() + (match.rubberKind ? config.rubberMinutes : config.matchMinutes) * MINUTE)
        : null;
      const overlapping = begin && finish
        ? await transaction.match.findMany({
            where: {
              id: { not: match.id },
              notPlayedAt: null,
              lifecycleStatus: { notIn: ["SUBMITTED"] },
              scheduledAt: { lt: finish },
              OR: [{ scheduledEndAt: { gt: begin } }, { scheduledEndAt: null, scheduledAt: { gt: new Date(begin.getTime() - config.matchMinutes * MINUTE) } }],
              officialAssignments: { some: { userId: newRefereeId, active: true, role: "MAIN_REFEREE" } },
            },
            select: { code: true, scheduledAt: true },
            orderBy: { scheduledAt: "asc" },
          })
        : [];
      // 草稿里如有这场的安排，裁判一并改成新裁判，避免下次发布把人换回去。
      await transaction.scheduleSlot.updateMany({ where: { matchId: match.id }, data: { refereeUserId: newRefereeId } });
      await audit(transaction, tournament.id, actorUserId, "MATCH_REFEREE_REPLACED", "Match", match.id, {
        matchCode: match.code,
        from: previous,
        to: newRefereeId,
        lifecycleStatus: match.lifecycleStatus,
        revokedSessions: revoked.count,
        overlapping: overlapping.map((item) => item.code),
        reason,
      });
      return {
        matchCode: match.code,
        revokedSessions: revoked.count,
        overlapping: overlapping.map((item) => ({ code: item.code, scheduledAt: item.scheduledAt?.toISOString() ?? null })),
      };
    },
  );
}

// ---------------------------------------------------------------------------
// 工作台视图（管理端页面与裁判长看板共用的只读投影）
// ---------------------------------------------------------------------------

export interface SlotView {
  courtId: string | null;
  courtCode: string | null;
  courtName: string | null;
  start: string | null;
  startLocal: string | null;
  end: string | null;
  durationMinutes: number;
  refereeId: string | null;
  refereeName: string | null;
  estimated: boolean;
}

export interface ScheduleRowView {
  id: string;
  code: string;
  label: string;
  competitionCode: string;
  stageName: string;
  fixtureId: string | null;
  fixtureLabel: string | null;
  rubber: string | null;
  isTeam: boolean;
  sideA: string;
  sideB: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "ENDED" | "NOT_PLAYED";
  lifecycleStatus: string;
  movable: boolean;
  tentative: boolean;
  changed: boolean;
  draft: SlotView;
  published: SlotView;
  issueCodes: { code: string; severity: "HARD" | "WARNING" }[];
  delay: { minutes: number; projectedStart: string; cause: string | null; overrun: boolean } | null;
}

export interface ScheduleWorkspaceFilters {
  day?: string | null;
  court?: string | null;
  competition?: string | null;
  problemsOnly?: boolean;
}

function slotView(placement: Placement, facts: ScheduleFacts, courtIndex: Map<string, ScheduleFacts["courts"][number]>, refereeIndex: Map<string, string>): SlotView {
  const court = placement.courtId ? courtIndex.get(placement.courtId) : undefined;
  const start = placement.start !== null ? new Date(placement.start) : null;
  return {
    courtId: placement.courtId,
    courtCode: court?.code ?? null,
    courtName: court?.name ?? null,
    start: start?.toISOString() ?? null,
    startLocal: start ? utcLocal(start, facts.timeZone) : null,
    end: start ? new Date(start.getTime() + placement.durationMinutes * MINUTE).toISOString() : null,
    durationMinutes: placement.durationMinutes,
    refereeId: placement.refereeId,
    refereeName: placement.refereeId ? refereeIndex.get(placement.refereeId) ?? "（已无裁判员角色）" : null,
    estimated: placement.estimated,
  };
}

function utcLocal(instant: Date, timeZone: string) {
  return utcToZonedLocal(instant, timeZone);
}

/**
 * 工作台数据：所有比赛的草稿与已发布安排、复检结果、警告摘要、延误推算与发布记录。
 * 行可按日期/场地/项目/只看问题过滤（统计数字始终针对全部比赛）。
 */
export async function loadScheduleWorkspace(tournamentId: string, now: Date, filters: ScheduleWorkspaceFilters = {}) {
  const facts = await loadScheduleFacts(prisma, tournamentId);
  const draftCheck = checkDraft(facts);
  const publishedCheck = checkPublished(facts);
  const delays = await loadPublishedDelays(prisma, tournamentId, now);
  const publications = await prisma.schedulePublication.findMany({
    where: { tournamentId },
    orderBy: { version: "desc" },
    take: 20,
    select: { version: true, publishedAt: true, matchCount: true, changes: true, warnings: true, note: true, publishedBy: { select: { name: true } } },
  });

  const courtIndex = new Map(facts.courts.map((court) => [court.id, court]));
  const refereeIndex = new Map(facts.referees.map((referee) => [referee.id, referee.name]));
  const issuesByMatch = new Map<string, { code: string; severity: "HARD" | "WARNING" }[]>();
  for (const issue of draftCheck.issues) {
    for (const matchId of issue.matchIds) {
      const list = issuesByMatch.get(matchId) ?? [];
      if (!list.some((item) => item.code === issue.code)) list.push({ code: issue.code, severity: issue.severity });
      issuesByMatch.set(matchId, list);
    }
  }
  const tentative = new Set(draftCheck.tentativeMatchIds);
  const changed = new Set(draftChanges(facts));

  const rows: ScheduleRowView[] = facts.rows.map((row) => {
    const fact = facts.factById.get(row.id)!;
    const fixture = row.fixtureId ? facts.fixtureById.get(row.fixtureId) : undefined;
    const sides = facts.sideLabels.get(row.id) ?? { A: "待定", B: "待定" };
    const delay = delays.get(row.id);
    return {
      id: row.id,
      code: row.code,
      label: fact.label,
      competitionCode: row.stage.competition.code,
      stageName: row.stage.name,
      fixtureId: row.fixtureId,
      fixtureLabel: fixture?.label ?? null,
      rubber: row.rubberKind && row.rubberOrder ? `第 ${row.rubberOrder} 场${RUBBER_LABEL[row.rubberKind as RubberKind] ?? row.rubberKind}` : null,
      isTeam: fact.isTeam,
      sideA: sides.A,
      sideB: sides.B,
      status: fact.status,
      lifecycleStatus: row.lifecycleStatus,
      movable: isMovable(fact),
      tentative: tentative.has(row.id),
      changed: changed.has(row.id),
      draft: slotView(facts.draft.get(row.id)!, facts, courtIndex, refereeIndex),
      published: slotView(facts.published.get(row.id)!, facts, courtIndex, refereeIndex),
      issueCodes: issuesByMatch.get(row.id) ?? [],
      delay:
        delay && (delay.delayed || delay.overrun)
          ? { minutes: delay.delayMinutes, projectedStart: new Date(delay.projectedStart).toISOString(), cause: delayCauseText(delay), overrun: delay.overrun }
          : null,
    };
  });

  const dayOf = (slot: SlotView) => slot.startLocal?.slice(0, 10) ?? "";
  const byTime = (view: "draft" | "published") => (left: ScheduleRowView, right: ScheduleRowView) => {
    const a = left[view].start ?? "9999";
    const b = right[view].start ?? "9999";
    if (a !== b) return a < b ? -1 : 1;
    const courtA = left[view].courtCode ?? "~";
    const courtB = right[view].courtCode ?? "~";
    if (courtA !== courtB) return courtA < courtB ? -1 : 1;
    return left.code.localeCompare(right.code);
  };
  const filterRows = (view: "draft" | "published") =>
    rows
      .filter((row) => !filters.day || dayOf(row[view]) === (filters.day === "none" ? "" : filters.day))
      .filter((row) => !filters.court || row[view].courtCode === filters.court)
      .filter((row) => !filters.competition || row.competitionCode === filters.competition)
      .filter((row) => !filters.problemsOnly || row.issueCodes.length > 0 || row.changed || (view === "published" && row.delay))
      .sort(byTime(view));

  return {
    timeZone: facts.timeZone,
    config: facts.config,
    courts: facts.courts,
    referees: facts.referees,
    refereeMode: facts.refereeMode,
    days: facts.days.map((day) => ({ date: day.day, start: minuteText(day.startMinute), end: minuteText(day.endMinute) })),
    competitions: [...new Set(rows.map((row) => row.competitionCode))].sort(),
    draftDays: [...new Set(rows.map((row) => dayOf(row.draft)).filter(Boolean))].sort(),
    publishedDays: [...new Set(rows.map((row) => dayOf(row.published)).filter(Boolean))].sort(),
    draftRows: filterRows("draft"),
    publishedRows: filterRows("published"),
    totalMatches: rows.length,
    draftCheck: {
      ...draftCheck,
      issues: draftCheck.issues.slice(0, 200),
      truncated: draftCheck.issues.length > 200,
    },
    warningDigest: hashWarnings(draftCheck),
    publishedCheck: {
      hardCount: publishedCheck.hardCount,
      warningCount: publishedCheck.warningCount,
      issues: publishedCheck.issues.filter((issue) => issue.severity === "HARD").slice(0, 50),
    },
    draftChangeCount: changed.size,
    delayedCount: rows.filter((row) => row.delay && row.status === "NOT_STARTED").length,
    publications: publications.map((item) => ({
      version: item.version,
      publishedAt: item.publishedAt.toISOString(),
      publishedBy: item.publishedBy?.name ?? null,
      matchCount: item.matchCount,
      changes: item.changes as Record<string, unknown>,
      warnings: item.warnings as { code: string; message: string }[],
      note: item.note,
    })),
    teamFixtures: [...new Map(
      rows
        .filter((row) => row.isTeam && row.fixtureId && row.movable)
        .map((row) => [row.fixtureId as string, { id: row.fixtureId as string, label: `${row.competitionCode} ${row.fixtureLabel ?? ""} ${row.sideA} vs ${row.sideB}` }]),
    ).values()],
  };
}

export type ScheduleWorkspace = Awaited<ReturnType<typeof loadScheduleWorkspace>>;

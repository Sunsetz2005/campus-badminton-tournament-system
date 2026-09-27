import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { Prisma, type DrawFormat, type EntryType } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import {
  applyAdjustments,
  DRAW_ALGORITHM_VERSION,
  replayDraw,
  runDraw,
  type DrawAdjustment,
  type DrawEntryInput,
  type DrawInput,
  type DrawResult,
  type DrawSettings,
  type PlannedFixture,
  type SlotSource,
} from "@/domain/draw/draw-engine";
import { normalizeReason, type RegistrationCompetitionKind } from "@/domain/registration/registration-rules";
import { stableStringify } from "@/domain/rules/match-engine";
import { validateRuleConfig } from "@/domain/rules/rule-profile";
import { requireManagedTournament } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import { lockTournamentRow, REGISTRATION_EDITABLE_PHASES } from "@/server/services/registration-service";

/**
 * 抽签编排的服务端命令。
 *
 * - 草稿：每次生成或调签都是一个新版本（旧草稿标记为被替代），保存输入名单快照、设置、随机种子、算法版本与调签记录；
 * - 发布：只在报名已截止、无待审核报名、名单与草稿一致、且结果能从保存的参数完整复现时才允许；
 *   发布在一个事务里生成阶段、小组、对阵和比赛（团体项目每场对抗生成若干小场占位），并冻结全部报名单位；
 * - 撤销：只有裁判长可以在「一场都还没开始」时撤销已发布的抽签，必须写原因，历史版本保留。
 */

type Tx = Prisma.TransactionClient;

export const DRAW_MANAGER_ROLES = ["ADMIN", "ORGANIZER"] as const;

const seedSchema = z.object({
  entryId: z.string().uuid(),
  seedNo: z.number().int().min(1).max(16),
  basis: z
    .string()
    .transform((value) => value.normalize("NFKC").trim().replace(/\s+/g, " "))
    .refine((value) => [...value].length >= 2 && [...value].length <= 100, "设种依据应为 2—100 个字符"),
});

export const drawSettingsSchema = z.object({
  format: z.enum(["ROUND_ROBIN", "GROUPS_KNOCKOUT", "KNOCKOUT"]),
  groupCount: z.number().int().min(2).max(16).nullish().transform((value) => value ?? null),
  qualifiersPerGroup: z.union([z.literal(1), z.literal(2)]).default(2),
  thirdPlaceMatch: z.boolean().default(true),
  avoidSameUnit: z.boolean().default(true),
  seeds: z.array(seedSchema).max(16).default([]),
});

const adjustmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SWAP"), entryA: z.string().uuid(), entryB: z.string().uuid(), reason: z.string().max(400) }),
  z.object({ type: z.literal("MOVE"), entryId: z.string().uuid(), toGroup: z.string().regex(/^[A-P]$/), reason: z.string().max(400) }),
]);

// ---------------------------------------------------------------------------
// 输入名单
// ---------------------------------------------------------------------------

interface CompetitionRow {
  id: string;
  code: string;
  name: string;
  entryType: EntryType;
  teamRubbers: string[];
  ruleProfileRevisionId: string | null;
}

async function loadCompetition(client: Tx | typeof prisma, tournamentId: string, competitionCode: string): Promise<CompetitionRow> {
  const competition = await client.competition.findUnique({
    where: { tournamentId_code: { tournamentId, code: competitionCode.toUpperCase() } },
    select: { id: true, code: true, name: true, entryType: true, teamRubbers: true, ruleProfileRevisionId: true },
  });
  if (!competition) throw new AppError(404, "competition_not_found", "项目不存在。");
  return competition;
}

/**
 * 当前已审核通过的报名单位，按编号规范排序。回避单位：团体取队伍名称，个人取成员登记的代表队/单位。
 * 返回的 `inputHash` 覆盖报名单位、编号与回避单位；名单任一变化都会让已生成的草稿失效。
 */
export async function loadDrawEntries(client: Tx | typeof prisma, competitionId: string) {
  const rows = await client.entry.findMany({
    where: { competitionId },
    select: {
      id: true,
      code: true,
      displayName: true,
      team: { select: { name: true } },
      members: { select: { participant: { select: { teamName: true } } }, orderBy: { slot: "asc" } },
    },
    orderBy: { code: "asc" },
  });
  const entries: DrawEntryInput[] = rows.map((row) => {
    const units = row.team
      ? [row.team.name]
      : [...new Set(row.members.map((member) => member.participant.teamName?.trim()).filter((value): value is string => Boolean(value)))].sort();
    return { entryId: row.id, code: row.code, label: row.displayName, units };
  });
  const inputHash = createHash("sha256").update(stableStringify(entries)).digest("hex");
  return { entries, inputHash };
}

function toSettings(input: z.output<typeof drawSettingsSchema>): DrawSettings {
  return {
    format: input.format,
    groupCount: input.format === "GROUPS_KNOCKOUT" ? input.groupCount : null,
    qualifiersPerGroup: input.qualifiersPerGroup,
    thirdPlaceMatch: input.format === "ROUND_ROBIN" ? false : input.thirdPlaceMatch,
    avoidSameUnit: input.avoidSameUnit,
    seeds: input.format === "ROUND_ROBIN" ? [] : input.seeds,
  };
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function lockCompetitionRow(transaction: Tx, competitionId: string) {
  await transaction.$queryRaw`SELECT "id" FROM "competitions" WHERE "id" = ${competitionId}::uuid FOR UPDATE`;
}

/** 项目里是否已有不是抽签生成的比赛（阶段 1—3 的演示比赛）：这类项目不接受抽签，避免两套对阵并存。 */
async function assertNoForeignMatches(client: Tx | typeof prisma, competitionId: string) {
  const foreign = await client.match.count({ where: { stage: { competitionId }, fixtureId: null } });
  if (foreign > 0) throw new AppError(409, "competition_has_matches", "该项目已有非抽签生成的比赛，不能再抽签。");
}

async function nextDrawVersion(transaction: Tx, competitionId: string) {
  const latest = await transaction.draw.findFirst({ where: { competitionId }, orderBy: { version: "desc" }, select: { version: true } });
  return (latest?.version ?? 0) + 1;
}

function drawFailure(errors: string[]): never {
  throw new AppError(400, "draw_invalid", errors.join("；"), { errors });
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

export async function generateDrawDraft(actorUserId: string, slug: string, competitionCode: string, rawSettings: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, [...DRAW_MANAGER_ROLES]);
  if (!REGISTRATION_EDITABLE_PHASES.includes(tournament.phase)) {
    throw new AppError(409, "tournament_locked", "赛事已开赛或结束，不能再抽签。");
  }
  const parsed = drawSettingsSchema.safeParse(rawSettings);
  if (!parsed.success) throw new AppError(400, "invalid_input", parsed.error.issues[0]?.message ?? "抽签设置无效。");
  const settings = toSettings(parsed.data);

  return prisma.$transaction(async (transaction) => {
    const competition = await loadCompetition(transaction, tournament.id, competitionCode);
    await lockCompetitionRow(transaction, competition.id);
    await assertNoForeignMatches(transaction, competition.id);
    const published = await transaction.draw.findFirst({ where: { competitionId: competition.id, status: "PUBLISHED" }, select: { version: true } });
    if (published) throw new AppError(409, "draw_published", `第 ${published.version} 版抽签已发布；如需重抽须先由裁判长撤销发布。`);

    const { entries, inputHash } = await loadDrawEntries(transaction, competition.id);
    // 种子只能来自当前名单。
    const randomSeed = randomBytes(16).toString("hex");
    const input: DrawInput = { entries, settings, randomSeed };
    const outcome = runDraw(input);
    if (!outcome.ok) drawFailure(outcome.errors);

    await transaction.draw.updateMany({ where: { competitionId: competition.id, status: "DRAFT" }, data: { status: "SUPERSEDED" } });
    const version = await nextDrawVersion(transaction, competition.id);
    const draw = await transaction.draw.create({
      data: {
        competitionId: competition.id,
        version,
        format: settings.format as DrawFormat,
        algorithmVersion: DRAW_ALGORITHM_VERSION,
        randomSeed,
        inputHash,
        input: asJson(entries),
        settings: asJson(settings),
        adjustments: [],
        result: asJson(outcome.result),
        conflictCount: outcome.result.conflicts.length,
        createdByUserId: actorUserId,
      },
      select: { id: true, version: true },
    });
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "DRAW_DRAFT_GENERATED",
        targetType: "Draw",
        targetId: draw.id,
        outcome: "SUCCESS",
        metadata: asJson({
          competitionCode: competition.code,
          version: draw.version,
          format: settings.format,
          entryCount: entries.length,
          seeds: settings.seeds,
          conflicts: outcome.result.conflicts.length,
        }),
      },
    });
    return { drawId: draw.id, version: draw.version, conflicts: outcome.result.conflicts.length };
  });
}

interface StoredDraw {
  id: string;
  version: number;
  status: string;
  randomSeed: string;
  inputHash: string;
  input: Prisma.JsonValue;
  settings: Prisma.JsonValue;
  adjustments: Prisma.JsonValue;
  result: Prisma.JsonValue;
}

function storedInput(draw: StoredDraw): { input: DrawInput; adjustments: DrawAdjustment[]; result: DrawResult } {
  return {
    input: {
      entries: draw.input as unknown as DrawEntryInput[],
      settings: draw.settings as unknown as DrawSettings,
      randomSeed: draw.randomSeed,
    },
    adjustments: draw.adjustments as unknown as DrawAdjustment[],
    result: draw.result as unknown as DrawResult,
  };
}

const drawSelect = {
  id: true,
  version: true,
  status: true,
  randomSeed: true,
  inputHash: true,
  input: true,
  settings: true,
  adjustments: true,
  result: true,
} as const;

async function loadCurrentDraft(transaction: Tx, competitionId: string, expectedDrawId: string) {
  const draft = await transaction.draw.findFirst({ where: { competitionId, status: "DRAFT" }, select: drawSelect });
  if (!draft) throw new AppError(409, "draft_missing", "没有可操作的抽签草稿，请先生成。");
  if (draft.id !== expectedDrawId) throw new AppError(409, "draft_stale", "草稿已被更新（可能是他人刚调签或重抽），请刷新后重试。");
  return draft;
}

async function assertInputUnchanged(transaction: Tx, competitionId: string, draft: StoredDraw) {
  const { inputHash } = await loadDrawEntries(transaction, competitionId);
  if (inputHash !== draft.inputHash) {
    throw new AppError(409, "draw_input_changed", "草稿生成后报名名单或代表队信息发生了变化，请重新抽签。");
  }
}

/** 手动调签：在当前草稿上追加一条调签记录，生成新的草稿版本。 */
export async function adjustDrawDraft(actorUserId: string, slug: string, competitionCode: string, drawId: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, [...DRAW_MANAGER_ROLES]);
  const parsed = adjustmentSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "调签请求格式无效。");
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "调签必须填写原因（200 字以内）。");
  const adjustment: DrawAdjustment = { ...parsed.data, reason };

  return prisma.$transaction(async (transaction) => {
    const competition = await loadCompetition(transaction, tournament.id, competitionCode);
    await lockCompetitionRow(transaction, competition.id);
    const draft = await loadCurrentDraft(transaction, competition.id, drawId);
    await assertInputUnchanged(transaction, competition.id, draft);
    const { input, adjustments, result } = storedInput(draft);
    const outcome = applyAdjustments(input, result.layout, [adjustment]);
    if (!outcome.ok) drawFailure(outcome.errors);

    await transaction.draw.update({ where: { id: draft.id }, data: { status: "SUPERSEDED" } });
    const version = await nextDrawVersion(transaction, competition.id);
    const next = await transaction.draw.create({
      data: {
        competitionId: competition.id,
        version,
        format: input.settings.format as DrawFormat,
        algorithmVersion: DRAW_ALGORITHM_VERSION,
        randomSeed: draft.randomSeed,
        inputHash: draft.inputHash,
        input: asJson(input.entries),
        settings: asJson(input.settings),
        adjustments: asJson([...adjustments, adjustment]),
        result: asJson(outcome.result),
        conflictCount: outcome.result.conflicts.length,
        createdByUserId: actorUserId,
      },
      select: { id: true, version: true },
    });
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "DRAW_ADJUSTED",
        targetType: "Draw",
        targetId: next.id,
        outcome: "SUCCESS",
        metadata: asJson({ competitionCode: competition.code, fromVersion: draft.version, version: next.version, adjustment }),
      },
    });
    return { drawId: next.id, version: next.version, conflicts: outcome.result.conflicts.length };
  });
}

// ---------------------------------------------------------------------------
// 发布
// ---------------------------------------------------------------------------

const TAG_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** 比赛编号是全局唯一的；用赛事 ID 的摘要生成 4 位稳定标签，避免不同赛事的同名项目撞号。 */
export function tournamentTag(tournamentId: string) {
  const digest = createHash("sha256").update(tournamentId).digest();
  return [...digest.subarray(0, 4)].map((byte) => TAG_ALPHABET[byte % TAG_ALPHABET.length]).join("");
}

export function drawMatchCode(tag: string, competitionCode: string, fixtureCode: string, rubber?: { order: number; kind: string }) {
  return [tag, competitionCode, fixtureCode, rubber ? `${rubber.order}${rubber.kind}` : null].filter(Boolean).join("-");
}

function sameResult(left: DrawResult, right: DrawResult) {
  return stableStringify(left) === stableStringify(right);
}

const publishSchema = z.object({ confirm: z.literal(true) });

export async function publishDraw(actorUserId: string, slug: string, competitionCode: string, drawId: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, [...DRAW_MANAGER_ROLES]);
  if (!publishSchema.safeParse(rawInput).success) {
    throw new AppError(400, "confirm_required", "发布前请确认：发布后将生成比赛并冻结报名单位。");
  }

  return prisma.$transaction(
    async (transaction) => {
      // 与报名审核共用赛事行锁：发布期间不会有报名被通过或撤回。
      await lockTournamentRow(transaction, tournament.id);
      const detail = await transaction.tournament.findUniqueOrThrow({
        where: { id: tournament.id },
        select: { phase: true, defaultRuleRevisionId: true },
      });
      if (detail.phase !== "REGISTRATION_CLOSED") {
        throw new AppError(409, "registration_not_closed", "请先把赛事阶段推进到「报名截止」再发布抽签。");
      }
      const competition = await loadCompetition(transaction, tournament.id, competitionCode);
      await lockCompetitionRow(transaction, competition.id);
      await assertNoForeignMatches(transaction, competition.id);
      const draft = await loadCurrentDraft(transaction, competition.id, drawId);
      const pending = await transaction.registration.count({ where: { competitionId: competition.id, status: "PENDING" } });
      if (pending > 0) throw new AppError(409, "pending_registrations", `本项目还有 ${pending} 份待审核报名，请先处理完再发布。`);
      await assertInputUnchanged(transaction, competition.id, draft);

      const { input, adjustments, result } = storedInput(draft);
      const replayed = replayDraw(input, adjustments);
      if (!replayed.ok || !sameResult(replayed.result, result)) {
        throw new AppError(409, "draw_not_reproducible", "按保存的种子与调签记录无法复现草稿结果，已拒绝发布。");
      }

      const ruleRevisionId = competition.ruleProfileRevisionId ?? detail.defaultRuleRevisionId;
      if (!ruleRevisionId) throw new AppError(409, "rule_missing", "项目和赛事都没有设置计分规则，不能生成比赛。");
      const revision = await transaction.ruleProfileRevision.findUniqueOrThrow({
        where: { id: ruleRevisionId },
        select: { id: true, config: true, configHash: true, frozenAt: true },
      });
      validateRuleConfig(revision.config);
      const now = new Date();
      if (!revision.frozenAt) await transaction.ruleProfileRevision.update({ where: { id: revision.id }, data: { frozenAt: now } });

      const counts = await materialize(transaction, {
        tournamentId: tournament.id,
        competition,
        drawId: draft.id,
        result,
        revision,
        ruleScope: competition.ruleProfileRevisionId ? "competition" : "tournament",
        now,
      });

      await transaction.entry.updateMany({ where: { competitionId: competition.id }, data: { frozenAt: now } });
      await transaction.draw.update({
        where: { id: draft.id },
        data: { status: "PUBLISHED", publishedAt: now, publishedByUserId: actorUserId },
      });
      await transaction.auditLog.create({
        data: {
          tournamentId: tournament.id,
          actorUserId,
          action: "DRAW_PUBLISHED",
          targetType: "Draw",
          targetId: draft.id,
          outcome: "SUCCESS",
          metadata: asJson({
            competitionCode: competition.code,
            version: draft.version,
            randomSeed: draft.randomSeed,
            algorithmVersion: DRAW_ALGORITHM_VERSION,
            inputHash: draft.inputHash,
            adjustments: adjustments.length,
            conflicts: result.conflicts.length,
            ...counts,
          }),
        },
      });
      return { drawId: draft.id, version: draft.version, ...counts };
    },
    { timeout: 30_000 },
  );
}

interface MaterializeInput {
  tournamentId: string;
  competition: CompetitionRow;
  drawId: string;
  result: DrawResult;
  revision: { id: string; config: Prisma.JsonValue; configHash: string };
  ruleScope: "competition" | "tournament";
  now: Date;
}

const STAGE_NAMES = { GROUP_ROUND_ROBIN: "单循环", GROUP_STAGE: "小组赛", KNOCKOUT: "淘汰赛" } as const;

async function materialize(transaction: Tx, input: MaterializeInput) {
  const { competition, result, now } = input;
  const format = result.layout.format;
  const hasGroups = result.layout.groups.length > 0;
  const hasKnockout = Boolean(result.layout.bracket);

  const stageIds: { group?: string; knockout?: string } = {};
  if (hasGroups) {
    const stage = await transaction.stage.create({
      data: {
        competitionId: competition.id,
        code: "GROUPS",
        name: format === "ROUND_ROBIN" ? STAGE_NAMES.GROUP_ROUND_ROBIN : STAGE_NAMES.GROUP_STAGE,
        type: "ROUND_ROBIN",
        order: 1,
        drawId: input.drawId,
        frozenAt: now,
      },
      select: { id: true },
    });
    stageIds.group = stage.id;
  }
  if (hasKnockout) {
    const stage = await transaction.stage.create({
      data: {
        competitionId: competition.id,
        code: "KO",
        name: STAGE_NAMES.KNOCKOUT,
        type: "KNOCKOUT",
        order: hasGroups ? 2 : 1,
        drawId: input.drawId,
        frozenAt: now,
      },
      select: { id: true },
    });
    stageIds.knockout = stage.id;
  }

  const groupIds = new Map<string, string>();
  for (const group of result.layout.groups) {
    const created = await transaction.group.create({
      data: {
        stageId: stageIds.group as string,
        code: group.code,
        name: format === "ROUND_ROBIN" ? "单循环" : `${group.code} 组`,
      },
      select: { id: true },
    });
    groupIds.set(group.code, created.id);
  }

  // 先小组后淘汰，淘汰按轮次递增插入：触发器要求来源对阵已存在且在更早的轮次。
  const ordered = [...result.fixtures].sort((left, right) => {
    const stageOrder = (fixture: PlannedFixture) => (fixture.kind === "GROUP" ? 0 : 1);
    return stageOrder(left) - stageOrder(right) || left.round - right.round || left.sequence - right.sequence;
  });
  const fixtureIds = new Map<string, string>();
  const fixtureRows: { id: string; fixture: PlannedFixture; stageId: string; groupId: string | null; sideA: string | null; sideB: string | null }[] = [];

  const sideColumns = (source: SlotSource, prefix: "sideA" | "sideB") => {
    switch (source.type) {
      case "ENTRY":
        return { [`${prefix}Source`]: "ENTRY", [`${prefix}EntryId`]: source.entryId };
      case "GROUP_RANK":
        return { [`${prefix}Source`]: "GROUP_RANK", [`${prefix}GroupId`]: groupIds.get(source.groupCode), [`${prefix}Rank`]: source.rank };
      default:
        return { [`${prefix}Source`]: source.type, [`${prefix}FixtureId`]: fixtureIds.get(source.fixtureCode) };
    }
  };

  for (const fixture of ordered) {
    const stageId = (fixture.kind === "GROUP" ? stageIds.group : stageIds.knockout) as string;
    const groupId = fixture.groupCode ? (groupIds.get(fixture.groupCode) as string) : null;
    const created = await transaction.fixture.create({
      data: {
        drawId: input.drawId,
        competitionId: competition.id,
        stageId,
        groupId,
        code: fixture.code,
        kind: fixture.kind,
        round: fixture.round,
        sequence: fixture.sequence,
        label: fixture.label,
        ...sideColumns(fixture.sideA, "sideA"),
        ...sideColumns(fixture.sideB, "sideB"),
      } as Prisma.FixtureUncheckedCreateInput,
      select: { id: true, sideAEntryId: true, sideBEntryId: true },
    });
    fixtureIds.set(fixture.code, created.id);
    fixtureRows.push({ id: created.id, fixture, stageId, groupId, sideA: created.sideAEntryId, sideB: created.sideBEntryId });
  }

  const tag = tournamentTag(input.tournamentId);
  const isTeam = competition.entryType === "TEAM";
  const rubbers = competition.teamRubbers as RegistrationCompetitionKind[];
  const matches: Prisma.MatchCreateManyInput[] = [];
  for (const row of fixtureRows) {
    if (isTeam) {
      rubbers.forEach((kind, index) => {
        matches.push({
          id: randomUUID(),
          code: drawMatchCode(tag, competition.code, row.fixture.code, { order: index + 1, kind }),
          stageId: row.stageId,
          groupId: row.groupId,
          fixtureId: row.id,
          rubberKind: kind,
          rubberOrder: index + 1,
          // 小场两侧就是对阵两侧的队伍（未决一侧为空）；上场队员由出场名单决定，名单交齐前不能计分。
          sideAEntryId: row.sideA,
          sideBEntryId: row.sideB,
        });
      });
    } else {
      matches.push({
        id: randomUUID(),
        code: drawMatchCode(tag, competition.code, row.fixture.code),
        stageId: row.stageId,
        groupId: row.groupId,
        fixtureId: row.id,
        sideAEntryId: row.sideA,
        sideBEntryId: row.sideB,
      });
    }
  }
  try {
    await transaction.match.createMany({ data: matches });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "match_code_taken", "生成的比赛编号与已有比赛冲突，已拒绝发布。");
    }
    throw error;
  }
  await transaction.matchRuleSnapshot.createMany({
    data: matches.map((match) => ({
      matchId: match.id as string,
      ruleProfileRevisionId: input.revision.id,
      config: input.revision.config as Prisma.InputJsonValue,
      configHash: input.revision.configHash,
      sourceChain: [
        { scope: input.ruleScope, ruleProfileRevisionId: input.revision.id },
        { scope: "draw", drawId: input.drawId },
        { scope: "match", snapshot: true },
      ],
    })),
  });

  return {
    stages: Object.keys(stageIds).length,
    groups: groupIds.size,
    fixtures: fixtureRows.length,
    matches: matches.length,
  };
}

// ---------------------------------------------------------------------------
// 撤销发布
// ---------------------------------------------------------------------------

const revokeSchema = z.object({ reason: z.string().max(400) });

/**
 * 撤销已发布的抽签（经裁判长）：只有本赛事的裁判长可以操作，必须写原因；
 * 只要有一场比赛已经开始、有过计分事件、控制会话或成绩修订，就拒绝，已打对阵不会被改变。
 */
export async function revokePublishedDraw(actorUserId: string, slug: string, competitionCode: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["CHIEF_REFEREE"]);
  const parsed = revokeSchema.safeParse(rawInput);
  const reason = parsed.success ? normalizeReason(parsed.data.reason) : null;
  if (!reason) throw new AppError(400, "reason_required", "撤销发布必须写明原因（漏报、错报或明确的算法错误）。");

  return prisma.$transaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const competition = await loadCompetition(transaction, tournament.id, competitionCode);
      await lockCompetitionRow(transaction, competition.id);
      const draw = await transaction.draw.findFirst({
        where: { competitionId: competition.id, status: "PUBLISHED" },
        select: { id: true, version: true },
      });
      if (!draw) throw new AppError(404, "draw_not_published", "该项目没有已发布的抽签。");
      const started = await transaction.match.count({
        where: {
          fixture: { drawId: draw.id },
          OR: [
            { lifecycleStatus: { notIn: ["SCHEDULED", "READY"] } },
            { version: { gt: 0 } },
            { events: { some: {} } },
            { scoringSessions: { some: {} } },
            { resultRevisions: { some: {} } },
          ],
        },
      });
      if (started > 0) {
        throw new AppError(409, "draw_matches_started", `已有 ${started} 场比赛开始或产生过记录，不能撤销抽签，也不会改变已打对阵。`);
      }
      const removed = await transaction.match.deleteMany({ where: { fixture: { drawId: draw.id } } });
      await transaction.fixture.deleteMany({ where: { drawId: draw.id } });
      await transaction.stage.deleteMany({ where: { drawId: draw.id } });
      await transaction.entry.updateMany({ where: { competitionId: competition.id }, data: { frozenAt: null } });
      const now = new Date();
      await transaction.draw.update({
        where: { id: draw.id },
        data: { status: "REVOKED", revokedAt: now, revokedByUserId: actorUserId, revokeReason: reason },
      });
      await transaction.auditLog.create({
        data: {
          tournamentId: tournament.id,
          actorUserId,
          action: "DRAW_REVOKED",
          targetType: "Draw",
          targetId: draw.id,
          outcome: "SUCCESS",
          metadata: asJson({ competitionCode: competition.code, version: draw.version, removedMatches: removed.count, reason }),
        },
      });
      return { drawId: draw.id, version: draw.version, removedMatches: removed.count };
    },
    { timeout: 30_000 },
  );
}

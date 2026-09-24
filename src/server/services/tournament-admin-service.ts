import { z } from "zod";

import { Prisma, type TournamentPhase } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import {
  COMPETITION_CODE_PATTERN,
  COMPETITION_KIND_ENTRY_TYPE,
  normalizeReason,
  type RegistrationCompetitionKind,
} from "@/domain/registration/registration-rules";
import {
  alternative3x15Demo,
  hashRuleConfig,
  singleGame21Demo,
  traditional21Demo,
  type RuleConfig,
} from "@/domain/rules/rule-profile";
import { isValidTimeZone, zonedLocalToUtc } from "@/domain/time/zoned-time";
import { requireManagedTournament, requireSystemAdmin } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";

/**
 * 三个内置规则都只是演示配置（见 AGENTS.md），新建赛事时如实标注来源，不写成正式规程。
 */
export const RULE_PRESETS = {
  "traditional-21": { name: "传统 21 分（演示配置）", config: traditional21Demo },
  "alternative-3x15": { name: "替代 3×15（演示配置）", config: alternative3x15Demo },
  "single-game-21": { name: "单局 21 分（演示配置）", config: singleGame21Demo },
} as const satisfies Record<string, { name: string; config: RuleConfig }>;

export type RulePresetKey = keyof typeof RULE_PRESETS;

const optionalText = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((value) => value.normalize("NFKC").trim())
    .refine((value) => [...value].length <= max, `不能超过 ${max} 个字符`)
    .transform((value) => value || null)
    .nullish()
    .transform((value) => value ?? null);

const requiredText = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFKC").trim().replace(/\s+/g, " "))
    .refine((value) => [...value].length >= min && [...value].length <= max, `长度应为 ${min}—${max} 个字符`);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD");
// 表单里未填写的时间以空字符串提交，等同于「不设置」。
const localDateTime = z
  .union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "时间格式应为 YYYY-MM-DDTHH:mm")])
  .nullish()
  .transform((value) => value || null);

const competitionInputSchema = z.object({
  kind: z.enum(["MS", "WS", "MD", "WD", "XD"]),
  code: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .refine((value) => COMPETITION_CODE_PATTERN.test(value), "项目代码只能是大写字母开头的字母、数字或连字符，最多 16 位"),
  name: requiredText(2, 30),
});

export const createTournamentSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "访问路径只能由小写字母、数字和连字符组成，长度 3—50，且不能以连字符开头或结尾"),
  name: requiredText(2, 60),
  subtitle: optionalText(80),
  organizer: optionalText(60),
  venue: optionalText(60),
  summary: optionalText(500),
  regulations: optionalText(5000),
  startDate: isoDate,
  endDate: isoDate,
  timezone: z.string().trim().refine(isValidTimeZone, "时区无效"),
  namePolicy: z.enum(["CODES_ONLY", "DISPLAY_NAMES"]),
  rulePreset: z.enum(Object.keys(RULE_PRESETS) as [RulePresetKey, ...RulePresetKey[]]),
  registrationOpensAt: localDateTime,
  registrationClosesAt: localDateTime,
  competitions: z.array(competitionInputSchema).min(1, "至少需要一个比赛项目").max(20, "一次最多创建 20 个项目"),
});

export type CreateTournamentInput = z.input<typeof createTournamentSchema>;

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".");
    throw new AppError(400, "invalid_input", issue ? `${path ? `${path}：` : ""}${issue.message}` : "输入无效。", {
      issues: result.error.issues.map((item) => ({ path: item.path.join("."), message: item.message })),
    });
  }
  return result.data;
}

function registrationWindow(
  opensLocal: string | null,
  closesLocal: string | null,
  timeZone: string,
): { registrationOpensAt: Date | null; registrationClosesAt: Date | null } {
  const registrationOpensAt = opensLocal ? zonedLocalToUtc(opensLocal, timeZone) : null;
  const registrationClosesAt = closesLocal ? zonedLocalToUtc(closesLocal, timeZone) : null;
  if (opensLocal && !registrationOpensAt) throw new AppError(400, "invalid_input", "报名开始时间在该时区不存在。");
  if (closesLocal && !registrationClosesAt) throw new AppError(400, "invalid_input", "报名截止时间在该时区不存在。");
  if (registrationOpensAt && registrationClosesAt && registrationOpensAt >= registrationClosesAt) {
    throw new AppError(400, "invalid_input", "报名截止时间必须晚于开始时间。");
  }
  return { registrationOpensAt, registrationClosesAt };
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * 新建赛事（草稿、筹备阶段）。创建者自动成为该赛事的 ADMIN；
 * 规则来自三个内置演示配置之一，生成赛事自己的 RuleProfile/Revision，不与其他赛事共享。
 */
export async function createTournament(actorUserId: string, rawInput: unknown) {
  await requireSystemAdmin(actorUserId);
  const input = parseOrThrow(createTournamentSchema, rawInput);
  if (input.startDate > input.endDate) throw new AppError(400, "invalid_input", "结束日期不能早于开始日期。");
  const codes = input.competitions.map((competition) => competition.code);
  if (new Set(codes).size !== codes.length) throw new AppError(400, "invalid_input", "项目代码不能重复。");
  const window = registrationWindow(input.registrationOpensAt, input.registrationClosesAt, input.timezone);
  const preset = RULE_PRESETS[input.rulePreset];

  try {
    return await prisma.$transaction(async (transaction) => {
      const tournament = await transaction.tournament.create({
        data: {
          slug: input.slug,
          name: input.name,
          subtitle: input.subtitle,
          organizer: input.organizer,
          venue: input.venue,
          summary: input.summary,
          regulations: input.regulations,
          startDate: new Date(`${input.startDate}T00:00:00.000Z`),
          endDate: new Date(`${input.endDate}T00:00:00.000Z`),
          timezone: input.timezone,
          namePolicy: input.namePolicy,
          ...window,
        },
        select: { id: true, slug: true },
      });
      const profile = await transaction.ruleProfile.create({
        data: { tournamentId: tournament.id, key: input.rulePreset, name: preset.name },
      });
      const revision = await transaction.ruleProfileRevision.create({
        data: {
          ruleProfileId: profile.id,
          revision: 1,
          sourceLabel: "项目演示配置（未经赛事组织者正式采纳）",
          sourceVersion: `builtin:${input.rulePreset}`,
          config: preset.config,
          configHash: hashRuleConfig(preset.config),
        },
      });
      await transaction.tournament.update({
        where: { id: tournament.id },
        data: { defaultRuleRevisionId: revision.id },
      });
      for (const competition of input.competitions) {
        await transaction.competition.create({
          data: {
            tournamentId: tournament.id,
            code: competition.code,
            name: competition.name,
            kind: competition.kind,
            entryType: COMPETITION_KIND_ENTRY_TYPE[competition.kind],
          },
        });
      }
      await transaction.roleAssignment.create({
        data: { userId: actorUserId, tournamentId: tournament.id, role: "ADMIN" },
      });
      await transaction.auditLog.create({
        data: {
          tournamentId: tournament.id,
          actorUserId,
          action: "TOURNAMENT_CREATED",
          targetType: "Tournament",
          targetId: tournament.id,
          outcome: "SUCCESS",
          metadata: { slug: input.slug, rulePreset: input.rulePreset, competitions: codes },
        },
      });
      return tournament;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "slug_taken", "该访问路径已被其他赛事使用。");
    throw error;
  }
}

const settingsSchema = z.object({
  registrationOpensAt: localDateTime,
  registrationClosesAt: localDateTime,
  regulations: optionalText(5000),
});

const EDITABLE_PHASES: TournamentPhase[] = ["PREPARING", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"];

export async function updateTournamentSettings(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  if (!EDITABLE_PHASES.includes(tournament.phase)) {
    throw new AppError(409, "tournament_locked", "赛事已开赛或结束，不能再修改报名设置。");
  }
  const input = parseOrThrow(settingsSchema, rawInput);
  const window = registrationWindow(input.registrationOpensAt, input.registrationClosesAt, tournament.timezone);
  await prisma.$transaction(async (transaction) => {
    await transaction.tournament.update({
      where: { id: tournament.id },
      data: { ...window, regulations: input.regulations },
    });
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "TOURNAMENT_SETTINGS_UPDATED",
        targetType: "Tournament",
        targetId: tournament.id,
        outcome: "SUCCESS",
        metadata: {
          registrationOpensAt: window.registrationOpensAt?.toISOString() ?? null,
          registrationClosesAt: window.registrationClosesAt?.toISOString() ?? null,
        },
      },
    });
  });
}

/**
 * 阶段 4-A 只开放报名相关的三段推进。进入 RUNNING/FINISHED 属于后续阶段，这里如实拒绝。
 * phase 由组织者显式推进并审计，不按服务器当前时间自动推导。
 */
const PHASE_TRANSITIONS: Partial<Record<TournamentPhase, TournamentPhase[]>> = {
  PREPARING: ["REGISTRATION_OPEN"],
  REGISTRATION_OPEN: ["REGISTRATION_CLOSED"],
  REGISTRATION_CLOSED: ["REGISTRATION_OPEN"],
};

const phaseSchema = z.object({
  to: z.enum(["PREPARING", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "RUNNING", "FINISHED"]),
  reason: z.string().nullish(),
});

export async function transitionTournamentPhase(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const input = parseOrThrow(phaseSchema, rawInput);
  const allowed = PHASE_TRANSITIONS[tournament.phase] ?? [];
  if (!allowed.includes(input.to)) {
    throw new AppError(409, "phase_transition_not_allowed", "当前阶段不能直接推进到目标阶段；开赛与结束属于后续阶段功能。");
  }
  const reopening = tournament.phase === "REGISTRATION_CLOSED" && input.to === "REGISTRATION_OPEN";
  const reason = input.reason ? normalizeReason(input.reason) : null;
  if (reopening && !reason) throw new AppError(400, "reason_required", "重新开放报名必须填写原因。");
  if (input.to === "REGISTRATION_OPEN") {
    const competitions = await prisma.competition.count({ where: { tournamentId: tournament.id } });
    if (competitions === 0) throw new AppError(409, "no_competitions", "至少设置一个比赛项目后才能开放报名。");
  }

  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.tournament.updateMany({
      where: { id: tournament.id, phase: tournament.phase },
      data: { phase: input.to },
    });
    if (updated.count !== 1) throw new AppError(409, "version_conflict", "赛事阶段已被他人修改，请刷新后重试。");
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "TOURNAMENT_PHASE_CHANGED",
        targetType: "Tournament",
        targetId: tournament.id,
        outcome: "SUCCESS",
        metadata: { from: tournament.phase, to: input.to, reason },
      },
    });
  });
  return { phase: input.to };
}

/**
 * 发布赛事门户（DRAFT → PUBLISHED）。只影响赛事级公开可见性；
 * 比赛仍受逐场 `Match.publishedAt` 约束，报名名单不会因此公开。
 */
export async function publishTournament(actorUserId: string, slug: string) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  if (tournament.status !== "DRAFT") throw new AppError(409, "already_published", "赛事已发布或已归档。");
  const detail = await prisma.tournament.findUniqueOrThrow({
    where: { id: tournament.id },
    select: { startDate: true, endDate: true, _count: { select: { competitions: true } } },
  });
  if (!detail.startDate || !detail.endDate) throw new AppError(409, "incomplete_tournament", "发布前必须填写赛事日期。");
  if (detail._count.competitions === 0) throw new AppError(409, "no_competitions", "发布前至少需要一个比赛项目。");

  const publishedAt = new Date();
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.tournament.updateMany({
      where: { id: tournament.id, status: "DRAFT" },
      data: { status: "PUBLISHED", publishedAt },
    });
    if (updated.count !== 1) throw new AppError(409, "already_published", "赛事已发布或已归档。");
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "TOURNAMENT_PUBLISHED",
        targetType: "Tournament",
        targetId: tournament.id,
        outcome: "SUCCESS",
        metadata: { publishedAt: publishedAt.toISOString() },
      },
    });
  });
  return { publishedAt };
}

export async function addCompetition(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  if (!EDITABLE_PHASES.includes(tournament.phase)) {
    throw new AppError(409, "tournament_locked", "赛事已开赛或结束，不能再新增项目。");
  }
  const input = parseOrThrow(competitionInputSchema, rawInput);
  try {
    return await prisma.$transaction(async (transaction) => {
      const competition = await transaction.competition.create({
        data: {
          tournamentId: tournament.id,
          code: input.code,
          name: input.name,
          kind: input.kind,
          entryType: COMPETITION_KIND_ENTRY_TYPE[input.kind as RegistrationCompetitionKind],
        },
        select: { id: true, code: true },
      });
      await transaction.auditLog.create({
        data: {
          tournamentId: tournament.id,
          actorUserId,
          action: "COMPETITION_CREATED",
          targetType: "Competition",
          targetId: competition.id,
          outcome: "SUCCESS",
          metadata: { code: input.code, kind: input.kind },
        },
      });
      return competition;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, "competition_code_taken", "本赛事已有相同代码的项目。");
    throw error;
  }
}

export { parseOrThrow };

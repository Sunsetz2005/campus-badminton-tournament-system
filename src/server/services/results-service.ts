import { createHash } from "node:crypto";

import { z } from "zod";

import { Prisma, type MatchSide, type TournamentRole } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { normalizeReason } from "@/domain/registration/registration-rules";
import {
  factFromRecord,
  factFromState,
  NOT_STARTED_FACT,
  validateResultOnly,
  type MatchResultFact,
  type ResultOnlyRecord,
} from "@/domain/results/match-result";
import { computePlacements, type Placement, type PlacementFixtureFact } from "@/domain/results/placements";
import { applyRankingDecision, CAMPUS_DEMO_RANKING, computeGroupRanking, type GroupRanking, type RankingMatch } from "@/domain/results/ranking";
import { stableStringify, type MatchState } from "@/domain/rules/match-engine";
import { validateRuleConfig } from "@/domain/rules/rule-profile";
import { requireManagedTournament } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import { lockTournamentRow } from "@/server/services/registration-service";
import {
  isStarted,
  loadTieFixture,
  lockFixtureRow,
  propagateFixtureResult,
  revokeGroupRankingInternal,
  setFixtureSide,
  settleTeamFixture,
  summarizeTie,
} from "@/server/services/team-tie-service";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;

/** 补录仅结果记录：赛事管理员/编排员。复核、重开、名次确认、排除与人工处置：裁判长。 */
const RESULT_ENTRY_ROLES: TournamentRole[] = ["ADMIN", "ORGANIZER"];
const CHIEF_ROLES: TournamentRole[] = ["CHIEF_REFEREE"];
/** 发布名次榜单：赛事管理员或裁判长。 */
const PUBLISH_ROLES: TournamentRole[] = ["ADMIN", "CHIEF_REFEREE"];
/** 成绩与名次页面：管理员、编排员与裁判长都可以查看。 */
export const RESULTS_VIEW_ROLES: TournamentRole[] = ["ADMIN", "ORGANIZER", "CHIEF_REFEREE"];

const SIDES: MatchSide[] = ["A", "B"];

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function audit(
  client: Tx,
  tournamentId: string,
  actorUserId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
) {
  await client.auditLog.create({
    data: { tournamentId, actorUserId, action, targetType, targetId, outcome: "SUCCESS", metadata: asJson(metadata) },
  });
}

async function lockMatchRow(transaction: Tx, matchId: string) {
  await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${matchId}::uuid FOR UPDATE`;
}

// ---------------------------------------------------------------------------
// 结果事实：逐分记分读权威状态，仅结果记录读最新有效修订
// ---------------------------------------------------------------------------

export const matchFactSelect = {
  id: true,
  code: true,
  version: true,
  resultSource: true,
  verificationStatus: true,
  lifecycleStatus: true,
  notPlayedAt: true,
  snapshot: { select: { state: true } },
  resultRevisions: {
    orderBy: { revision: "desc" },
    take: 1,
    select: { revision: true, status: true, source: true, result: true, actorUserId: true, reason: true, createdAt: true },
  },
} satisfies Prisma.MatchSelect;

type FactRow = Prisma.MatchGetPayload<{ select: typeof matchFactSelect }>;

export function matchFactOf(row: FactRow): MatchResultFact {
  if (row.resultSource === "RESULT_ONLY") {
    const latest = row.resultRevisions[0];
    if (!latest || latest.source !== "RESULT_ONLY" || (latest.status !== "PENDING" && latest.status !== "LOCKED")) {
      return { ...NOT_STARTED_FACT, source: "RESULT_ONLY" };
    }
    return factFromRecord(latest.result as unknown as ResultOnlyRecord, latest.status === "LOCKED" ? "CONFIRMED" : "PENDING_REVIEW");
  }
  return factFromState(row.snapshot ? (row.snapshot.state as unknown as MatchState) : null);
}

// ---------------------------------------------------------------------------
// 结算：个人项目比赛结果锁定/重开后推导胜者与后续签位
// ---------------------------------------------------------------------------

/**
 * 按事实重新推导一场个人项目对阵：胜者、后续对阵的胜者/负者签位；
 * 小组名次已确认而本组比赛结果被重开时撤回确认并清空由它回填的签位。
 * 幂等：重复调用不产生变化。后续对阵已开始或已有结果时拒绝（调用方整个事务回滚）。
 */
export async function settleIndividualFixture(transaction: Tx, fixtureId: string, actorUserId: string | null) {
  await lockFixtureRow(transaction, fixtureId);
  const fixture = await transaction.fixture.findUnique({
    where: { id: fixtureId },
    select: {
      id: true,
      code: true,
      groupId: true,
      sideAEntryId: true,
      sideBEntryId: true,
      winnerEntryId: true,
      group: { select: { code: true, rankingConfirmedAt: true } },
      competition: { select: { code: true, entryType: true, tournamentId: true } },
      matches: { select: matchFactSelect },
    },
  });
  if (!fixture || fixture.competition.entryType === "TEAM" || fixture.matches.length !== 1) return null;
  const tournamentId = fixture.competition.tournamentId;
  const fact = matchFactOf(fixture.matches[0]);
  const winnerSide = fact.stage === "CONFIRMED" ? fact.winner : null;
  const winnerEntryId = winnerSide ? (winnerSide === "A" ? fixture.sideAEntryId : fixture.sideBEntryId) : null;

  if (winnerEntryId !== fixture.winnerEntryId) {
    await transaction.fixture.update({
      where: { id: fixture.id },
      data: { winnerEntryId, decidedAt: winnerEntryId ? new Date() : null },
    });
    await propagateFixtureResult(transaction, tournamentId, actorUserId, fixture, winnerEntryId);
    await audit(transaction, tournamentId, actorUserId, winnerEntryId ? "RESULT_ADVANCED" : "RESULT_ADVANCE_WITHDRAWN", "Fixture", fixture.id, {
      competitionCode: fixture.competition.code,
      fixtureCode: fixture.code,
      winnerEntryId,
      previousWinnerEntryId: fixture.winnerEntryId,
      outcome: fact.outcome,
    });
  }
  if (fixture.groupId && fixture.group?.rankingConfirmedAt && fact.stage !== "CONFIRMED") {
    await revokeGroupRankingInternal(transaction, tournamentId, actorUserId, fixture.groupId, `比赛 ${fixture.code} 的结果被重开`);
  }
  return { fact, winnerEntryId };
}

/** 结果锁定、退回或重开后调用：团体小场结算对抗，个人项目结算对阵与晋级。同一事务内完成。 */
export async function settleAfterResultChange(transaction: Tx, matchId: string, actorUserId: string) {
  const match = await transaction.match.findUnique({ where: { id: matchId }, select: { fixtureId: true, rubberKind: true } });
  if (!match?.fixtureId) return null;
  if (match.rubberKind) return settleTeamFixture(transaction, match.fixtureId, actorUserId);
  return settleIndividualFixture(transaction, match.fixtureId, actorUserId);
}

// ---------------------------------------------------------------------------
// 个人项目小组名次
// ---------------------------------------------------------------------------

const groupSelect = {
  id: true,
  code: true,
  name: true,
  ranking: true,
  rankingConfirmedAt: true,
  rankingConfirmedBy: { select: { name: true } },
  stage: { select: { competition: { select: { id: true, code: true, entryType: true, tournamentId: true } } } },
  exclusions: {
    orderBy: { decidedAt: "asc" },
    select: { entryId: true, reason: true, decidedAt: true, decidedBy: { select: { name: true } } },
  },
  fixtures: {
    orderBy: [{ round: "asc" }, { sequence: "asc" }],
    select: { id: true, code: true, sideAEntryId: true, sideBEntryId: true, matches: { select: matchFactSelect } },
  },
} satisfies Prisma.GroupSelect;

export interface ConfirmedGroupRanking {
  profile: GroupRanking["profile"];
  order: string[];
  lots: string[][];
  reason: string | null;
  excluded: { entryId: string; reason: string }[];
  countedMatchCodes: string[];
}

export async function loadIndividualGroupRanking(client: Client, groupId: string) {
  const group = await client.group.findUniqueOrThrow({ where: { id: groupId }, select: groupSelect });
  const entryIds = new Set<string>();
  for (const fixture of group.fixtures) {
    if (fixture.sideAEntryId) entryIds.add(fixture.sideAEntryId);
    if (fixture.sideBEntryId) entryIds.add(fixture.sideBEntryId);
  }
  const entries = await client.entry.findMany({
    where: { id: { in: [...entryIds] } },
    orderBy: { code: "asc" },
    select: { id: true, code: true, displayName: true },
  });
  const matches: RankingMatch[] = group.fixtures
    .filter((fixture) => fixture.sideAEntryId && fixture.sideBEntryId && fixture.matches.length === 1)
    .map((fixture) => ({
      id: fixture.matches[0].id,
      code: fixture.code,
      sideA: fixture.sideAEntryId as string,
      sideB: fixture.sideBEntryId as string,
      fact: matchFactOf(fixture.matches[0]),
    }));
  const ranking = computeGroupRanking({
    entryIds: entries.map((entry) => entry.id),
    matches,
    excluded: group.exclusions.map((item) => ({ entryId: item.entryId, reason: item.reason })),
  });
  const confirmed = group.rankingConfirmedAt ? (group.ranking as unknown as ConfirmedGroupRanking) : null;
  return { group, entries, matches, ranking, confirmed };
}

async function findIndividualGroup(transaction: Tx, tournamentId: string, competitionCode: string, groupCode: string) {
  const group = await transaction.group.findFirst({
    where: {
      code: groupCode.toUpperCase(),
      stage: { competition: { tournamentId, code: competitionCode.toUpperCase() }, draw: { status: "PUBLISHED" } },
    },
    select: { id: true, code: true, rankingConfirmedAt: true, stage: { select: { competition: { select: { code: true, entryType: true } } } } },
  });
  if (!group) throw new AppError(404, "group_not_found", "小组不存在或所属抽签未发布。");
  if (group.stage.competition.entryType === "TEAM") {
    throw new AppError(400, "team_competition", "团体项目的小组名次在「团体对抗」页面确认。");
  }
  await transaction.$queryRaw`SELECT "id" FROM "competition_groups" WHERE "id" = ${group.id}::uuid FOR UPDATE`;
  return group;
}

const confirmSchema = z.object({
  order: z.array(z.string().uuid()).max(32).nullish(),
  reason: z.string().max(400).nullish(),
});

/**
 * 裁判长确认个人项目小组名次，并把「某组第几名」回填进淘汰签位。
 * 只有全部比赛经复核锁定、没有未处理特殊结果时才能确认；并列待裁定时须给出抽签/裁定后的完整顺序并写明依据。
 */
export async function confirmIndividualGroupRanking(
  actorUserId: string,
  slug: string,
  competitionCode: string,
  groupCode: string,
  rawInput: unknown,
) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, CHIEF_ROLES);
  const parsed = confirmSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "确认请求格式无效。");

  return prisma.$transaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const group = await findIndividualGroup(transaction, tournament.id, competitionCode, groupCode);
      if (group.rankingConfirmedAt) throw new AppError(409, "ranking_confirmed", "本组名次已经确认。");
      const { ranking } = await loadIndividualGroupRanking(transaction, group.id);
      const { order, error } = applyRankingDecision(ranking, parsed.data.order);
      if (!order) throw new AppError(409, "ranking_not_confirmable", `${error}。`, { status: ranking.status });
      const reason = parsed.data.reason ? normalizeReason(parsed.data.reason) : null;
      if (ranking.unresolved.length && !reason) {
        throw new AppError(400, "reason_required", "有名次并列待裁定，请写明抽签或裁定的时间、方式与见证人。");
      }
      const record: ConfirmedGroupRanking = {
        profile: ranking.profile,
        order,
        lots: ranking.unresolved,
        reason,
        excluded: ranking.excluded,
        countedMatchCodes: ranking.countedMatchCodes,
      };
      await transaction.group.update({
        where: { id: group.id },
        data: { ranking: asJson(record), rankingConfirmedAt: new Date(), rankingConfirmedByUserId: actorUserId },
      });
      const targets = await transaction.fixture.findMany({
        where: { OR: [{ sideAGroupId: group.id }, { sideBGroupId: group.id }] },
        select: { id: true, sideAGroupId: true, sideARank: true, sideBGroupId: true, sideBRank: true },
      });
      for (const fixture of targets) {
        for (const side of SIDES) {
          const sourceGroup = side === "A" ? fixture.sideAGroupId : fixture.sideBGroupId;
          const rank = side === "A" ? fixture.sideARank : fixture.sideBRank;
          if (sourceGroup !== group.id || !rank) continue;
          await setFixtureSide(transaction, tournament.id, actorUserId, fixture.id, side, order[rank - 1] ?? null, `${group.code} 组名次`);
        }
      }
      await audit(transaction, tournament.id, actorUserId, "GROUP_RANKING_CONFIRMED", "Group", group.id, {
        competitionCode: group.stage.competition.code,
        groupCode: group.code,
        profile: ranking.profile,
        order,
        lots: ranking.unresolved,
        excluded: ranking.excluded,
        reason,
      });
      return { order, filled: targets.length };
    },
    { timeout: 20_000 },
  );
}

const exclusionSchema = z.object({
  entryId: z.string().uuid(),
  action: z.enum(["ADD", "REMOVE"]),
  reason: z.string().max(400).nullish(),
});

/**
 * 裁判长处理特殊结果：排除（或取消排除）某个不能完成本组比赛的报名单位。
 * 排除只影响名次统计，原比赛、比分和审计历史全部保留。名次确认后不能再改。
 */
export async function setRankingExclusion(
  actorUserId: string,
  slug: string,
  competitionCode: string,
  groupCode: string,
  rawInput: unknown,
) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, CHIEF_ROLES);
  const parsed = exclusionSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "请求格式无效。");
  const { entryId, action } = parsed.data;

  return prisma.$transaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const group = await findIndividualGroup(transaction, tournament.id, competitionCode, groupCode);
      if (group.rankingConfirmedAt) throw new AppError(409, "ranking_confirmed", "本组名次已经确认，不能再改变排除决定。");
      const inGroup = await transaction.fixture.count({
        where: { groupId: group.id, OR: [{ sideAEntryId: entryId }, { sideBEntryId: entryId }] },
      });
      if (!inGroup) throw new AppError(404, "entry_not_in_group", "该报名单位不在本组。");
      if (action === "ADD") {
        const reason = normalizeReason(parsed.data.reason);
        if (!reason) throw new AppError(400, "reason_required", "排除须写明原因（例如赛前弃权、伤病退赛、取消资格）。");
        const existing = await transaction.rankingExclusion.findUnique({ where: { groupId_entryId: { groupId: group.id, entryId } } });
        if (existing) throw new AppError(409, "already_excluded", "该报名单位已被排除。");
        await transaction.rankingExclusion.create({ data: { groupId: group.id, entryId, reason, decidedByUserId: actorUserId } });
        await audit(transaction, tournament.id, actorUserId, "RANKING_EXCLUSION_ADDED", "Group", group.id, {
          competitionCode: group.stage.competition.code,
          groupCode: group.code,
          entryId,
          reason,
        });
      } else {
        const removed = await transaction.rankingExclusion.deleteMany({ where: { groupId: group.id, entryId } });
        if (!removed.count) throw new AppError(404, "exclusion_not_found", "该报名单位没有被排除。");
        await audit(transaction, tournament.id, actorUserId, "RANKING_EXCLUSION_REMOVED", "Group", group.id, {
          competitionCode: group.stage.competition.code,
          groupCode: group.code,
          entryId,
        });
      }
      return { entryId, action };
    },
    { timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------
// 仅结果记录：管理员补录逐局结果，裁判长独立复核；不伪造回合与发接发过程
// ---------------------------------------------------------------------------

const gameSchema = z.object({ a: z.number().int().min(0).max(99), b: z.number().int().min(0).max(99) });
const resultOnlySchema = z.object({
  outcome: z.enum(["NORMAL", "WO", "RET", "DSQ", "ABANDONED"]),
  winnerSide: z.enum(["A", "B"]).nullish(),
  games: z.array(gameSchema).max(9).default([]),
  partial: gameSchema.nullish(),
  reason: z.string().max(400),
});

async function loadResultMatch(transaction: Tx, tournamentId: string, matchCode: string) {
  const found = await transaction.match.findUnique({ where: { code: matchCode }, select: { id: true } });
  if (!found) throw new AppError(404, "match_not_found", "比赛不存在。");
  await lockMatchRow(transaction, found.id);
  const match = await transaction.match.findUniqueOrThrow({
    where: { id: found.id },
    select: {
      ...matchFactSelect,
      rubberKind: true,
      fixtureId: true,
      sideAEntryId: true,
      sideBEntryId: true,
      ruleSnapshot: { select: { config: true } },
      fixture: { select: { code: true, draw: { select: { status: true } } } },
      stage: { select: { competition: { select: { code: true, tournamentId: true } } } },
    },
  });
  if (match.stage.competition.tournamentId !== tournamentId) throw new AppError(404, "match_not_found", "比赛不存在。");
  return match;
}

async function writeGames(transaction: Tx, matchId: string, record: ResultOnlyRecord | null) {
  await transaction.game.deleteMany({ where: { matchId } });
  if (!record) return;
  const rows = record.games.map((game, index) => ({ matchId, number: index + 1, scoreA: game.a, scoreB: game.b, completed: true }));
  if (record.partial) rows.push({ matchId, number: rows.length + 1, scoreA: record.partial.a, scoreB: record.partial.b, completed: false });
  if (rows.length) await transaction.game.createMany({ data: rows });
}

/** 退回或重开后：比赛回到「未开始、逐分记分」状态，可以重新补录或在裁判台记分。修订历史全部保留。 */
async function resetResultOnlyMatch(transaction: Tx, matchId: string) {
  await transaction.match.update({
    where: { id: matchId },
    data: { resultSource: "LIVE", lifecycleStatus: "SCHEDULED", verificationStatus: "UNVERIFIED", outcomeType: null, endedAt: null },
  });
  await writeGames(transaction, matchId, null);
}

/** 管理员/编排员补录一场个人项目比赛的逐局结果（仅结果记录），提交后等待裁判长独立复核。 */
export async function recordResultOnly(actorUserId: string, slug: string, matchCode: string, rawInput: unknown) {
  const { tournament, role } = await requireManagedTournament(actorUserId, slug, RESULT_ENTRY_ROLES);
  const parsed = resultOnlySchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "结果格式无效。");
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "请写明补录依据（例如纸质记分表编号、线下比赛时间）。");

  return prisma.$transaction(
    async (transaction) => {
      const match = await loadResultMatch(transaction, tournament.id, matchCode);
      if (match.rubberKind) throw new AppError(400, "team_rubber", "团体小场须在裁判台逐分记分，不接受仅结果补录。");
      if (match.fixture && match.fixture.draw.status !== "PUBLISHED") throw new AppError(409, "draw_not_published", "该比赛所属的抽签未发布或已撤销。");
      if (!match.sideAEntryId || !match.sideBEntryId || !match.ruleSnapshot) {
        throw new AppError(409, "match_not_ready", "对阵双方尚未确定，不能补录结果。");
      }
      if (match.resultSource === "RESULT_ONLY" && matchFactOf(match).stage !== "NOT_STARTED") {
        throw new AppError(409, "result_exists", "该比赛已有仅结果记录；如需修改请先由裁判长退回或重开。");
      }
      const events = await transaction.matchEvent.count({ where: { matchId: match.id } });
      if (match.version > 0 || events > 0) {
        throw new AppError(409, "match_scored_live", "该比赛已在裁判台产生记分记录，不能改为仅结果记录。");
      }
      const active = await transaction.scoringSession.count({ where: { matchId: match.id, status: "ACTIVE", expiresAt: { gt: new Date() } } });
      if (active) throw new AppError(409, "controller_exists", "该比赛当前有裁判持有计分控制，请先让裁判释放控制。");

      const validated = validateResultOnly(
        {
          outcome: parsed.data.outcome,
          winnerSide: parsed.data.winnerSide ?? null,
          games: parsed.data.games,
          partial: parsed.data.partial ?? null,
        },
        validateRuleConfig(match.ruleSnapshot.config),
      );
      if (!validated.ok) throw new AppError(400, "invalid_result", validated.errors.join("；"), { errors: validated.errors });

      const revision = (await transaction.resultRevision.count({ where: { matchId: match.id } })) + 1;
      await transaction.resultRevision.create({
        data: {
          matchId: match.id,
          revision,
          status: "PENDING",
          source: "RESULT_ONLY",
          result: asJson(validated.record),
          reason,
          actorUserId,
          submittedRole: role,
        },
      });
      await transaction.match.update({
        where: { id: match.id },
        data: {
          resultSource: "RESULT_ONLY",
          lifecycleStatus: "SUBMITTED",
          verificationStatus: "PENDING_REVIEW",
          outcomeType: validated.record.outcome,
        },
      });
      await writeGames(transaction, match.id, validated.record);
      await audit(transaction, tournament.id, actorUserId, "RESULT_ONLY_RECORDED", "Match", match.id, {
        matchCode: match.code,
        fixtureCode: match.fixture?.code ?? null,
        revision,
        result: validated.record,
        reason,
      });
      return { matchCode: match.code, revision };
    },
    { timeout: 20_000 },
  );
}

const reviewSchema = z.object({
  action: z.enum(["CONFIRM", "RETURN", "REOPEN"]),
  expectedRevision: z.number().int().positive(),
  reason: z.string().max(400),
});

/**
 * 裁判长处理仅结果记录：
 * - CONFIRM：独立复核锁定（补录人不能自己复核），并在同一事务里推进晋级；
 * - RETURN：退回待复核的补录，比赛回到未开始；
 * - REOPEN：重开已锁定的结果（更正），旧版本标记为被替代并保留；后续对阵已开始时整体拒绝。
 */
export async function reviewResultOnly(actorUserId: string, slug: string, matchCode: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, CHIEF_ROLES);
  const parsed = reviewSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "请求格式无效。");
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "请写明复核意见或更正原因。");
  const { action, expectedRevision } = parsed.data;

  return prisma.$transaction(
    async (transaction) => {
      const match = await loadResultMatch(transaction, tournament.id, matchCode);
      const latest = match.resultRevisions[0];
      if (match.resultSource !== "RESULT_ONLY" || !latest || latest.source !== "RESULT_ONLY") {
        throw new AppError(409, "not_result_only", "该比赛没有待处理的仅结果记录。");
      }
      if (latest.revision !== expectedRevision) throw new AppError(409, "revision_conflict", "结果已被修改，请刷新后重试。");
      const now = new Date();
      if (action === "CONFIRM" || action === "RETURN") {
        if (latest.status !== "PENDING") throw new AppError(409, "not_pending", "该结果不在待复核状态。");
        if (latest.actorUserId === actorUserId) {
          throw new AppError(409, "independent_review_required", "补录人不能同时作为独立复核人。");
        }
      } else if (latest.status !== "LOCKED") {
        throw new AppError(409, "not_locked", "只有已锁定的结果需要重开更正。");
      }
      const status = action === "CONFIRM" ? "LOCKED" : action === "RETURN" ? "RETURNED" : "SUPERSEDED";
      const updated = await transaction.resultRevision.updateMany({
        where: { matchId: match.id, revision: latest.revision, status: latest.status },
        data: {
          status,
          reviewedByUserId: actorUserId,
          reviewedRole: "CHIEF_REFEREE",
          reviewedAt: now,
          ...(action === "CONFIRM" ? {} : { returnedAt: now }),
          reason: action === "CONFIRM" ? reason : `${latest.reason ?? ""}｜${action === "RETURN" ? "退回" : "重开"}：${reason}`,
        },
      });
      if (updated.count !== 1) throw new AppError(409, "revision_conflict", "结果已被修改，请刷新后重试。");
      if (action === "CONFIRM") {
        await transaction.match.update({ where: { id: match.id }, data: { verificationStatus: "LOCKED" } });
      } else {
        await resetResultOnlyMatch(transaction, match.id);
      }
      await settleAfterResultChange(transaction, match.id, actorUserId);
      await audit(transaction, tournament.id, actorUserId, `RESULT_ONLY_${action === "CONFIRM" ? "CONFIRMED" : action === "RETURN" ? "RETURNED" : "REOPENED"}`, "Match", match.id, {
        matchCode: match.code,
        fixtureCode: match.fixture?.code ?? null,
        revision: latest.revision,
        previous: latest.result,
        reason,
      });
      return { matchCode: match.code, revision: latest.revision, status };
    },
    { timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------
// 更正影响预览：重开前先展示对晋级、名次与已发布榜单的影响
// ---------------------------------------------------------------------------

export interface ResultImpact {
  action: "CONFIRM" | "REOPEN";
  blocked: boolean;
  effects: string[];
  blockers: string[];
}

/**
 * 计算确认或重开一场比赛结果会带来的变化，不写入任何数据。
 * 后续对阵已经开始或已有结果时列为阻止项：系统不会自动换人、抹分或覆盖历史，须裁判长人工处置。
 */
export async function computeResultImpact(client: Client, matchId: string, action: "CONFIRM" | "REOPEN"): Promise<ResultImpact> {
  const match = await client.match.findUniqueOrThrow({
    where: { id: matchId },
    select: { ...matchFactSelect, fixtureId: true, rubberKind: true },
  });
  const effects: string[] = [];
  const blockers: string[] = [];
  if (!match.fixtureId) return { action, blocked: false, effects, blockers };
  const fixture = await client.fixture.findUniqueOrThrow({
    where: { id: match.fixtureId },
    select: {
      id: true,
      code: true,
      competitionId: true,
      groupId: true,
      sideAEntryId: true,
      sideBEntryId: true,
      winnerEntryId: true,
      group: { select: { code: true, rankingConfirmedAt: true } },
    },
  });

  let after: string | null;
  if (match.rubberKind) {
    const tie = await loadTieFixture(client, { id: fixture.id });
    if (!tie) return { action, blocked: false, effects, blockers };
    const hypothetical = {
      ...tie,
      matches: tie.matches.map((item) =>
        item.id === match.id ? { ...item, verificationStatus: action === "CONFIRM" ? ("LOCKED" as const) : ("UNVERIFIED" as const) } : item,
      ),
    };
    const summary = summarizeTie(hypothetical);
    after = summary.winner ? (summary.winner === "A" ? fixture.sideAEntryId : fixture.sideBEntryId) : null;
  } else {
    const fact = matchFactOf(match);
    after = action === "CONFIRM" && fact.winner ? (fact.winner === "A" ? fixture.sideAEntryId : fixture.sideBEntryId) : null;
  }

  const names = new Map<string, string>();
  const nameOf = async (entryId: string | null) => {
    if (!entryId) return "待定";
    if (!names.has(entryId)) {
      const entry = await client.entry.findUnique({ where: { id: entryId }, select: { code: true, displayName: true } });
      names.set(entryId, entry ? `${entry.displayName}（${entry.code}）` : entryId);
    }
    return names.get(entryId) as string;
  };
  const touched = (target: { winnerEntryId: string | null; matches: { version: number; lifecycleStatus: Parameters<typeof isStarted>[0]["lifecycleStatus"] }[] }) =>
    Boolean(target.winnerEntryId) || target.matches.some(isStarted);

  if (after !== fixture.winnerEntryId) {
    const loserAfter = after ? (after === fixture.sideAEntryId ? fixture.sideBEntryId : fixture.sideAEntryId) : null;
    const downstream = await client.fixture.findMany({
      where: { OR: [{ sideAFixtureId: fixture.id }, { sideBFixtureId: fixture.id }] },
      orderBy: [{ round: "asc" }, { sequence: "asc" }],
      select: {
        code: true,
        sideAFixtureId: true,
        sideASource: true,
        sideAEntryId: true,
        sideBFixtureId: true,
        sideBSource: true,
        sideBEntryId: true,
        winnerEntryId: true,
        matches: { select: { version: true, lifecycleStatus: true } },
      },
    });
    for (const next of downstream) {
      for (const side of SIDES) {
        if ((side === "A" ? next.sideAFixtureId : next.sideBFixtureId) !== fixture.id) continue;
        const source = side === "A" ? next.sideASource : next.sideBSource;
        const current = side === "A" ? next.sideAEntryId : next.sideBEntryId;
        const value = source === "FIXTURE_WINNER" ? after : source === "FIXTURE_LOSER" ? loserAfter : null;
        if (current === value) continue;
        if (current && touched(next)) {
          blockers.push(`后续对阵 ${next.code} 已经开始或已有结果（${await nameOf(current)} 已在其中），不能自动改写。`);
        } else if (value) {
          effects.push(`${await nameOf(value)} 进入 ${next.code}（${source === "FIXTURE_WINNER" ? "胜者" : "负者"}签位）。`);
        } else {
          effects.push(`撤回 ${await nameOf(current)} 在 ${next.code} 的签位。`);
        }
      }
    }
    if (action === "REOPEN" && fixture.winnerEntryId && !downstream.length) {
      effects.push(`撤回 ${fixture.code} 的胜者 ${await nameOf(fixture.winnerEntryId)}。`);
    }
  }

  if (action === "REOPEN" && fixture.groupId && fixture.group?.rankingConfirmedAt) {
    effects.push(`撤回 ${fixture.group.code} 组已确认的名次（结果重新确认后须重新确认名次）。`);
    const targets = await client.fixture.findMany({
      where: { OR: [{ sideAGroupId: fixture.groupId }, { sideBGroupId: fixture.groupId }] },
      orderBy: [{ round: "asc" }, { sequence: "asc" }],
      select: {
        code: true,
        sideAGroupId: true,
        sideARank: true,
        sideAEntryId: true,
        sideBGroupId: true,
        sideBRank: true,
        sideBEntryId: true,
        winnerEntryId: true,
        matches: { select: { version: true, lifecycleStatus: true } },
      },
    });
    for (const target of targets) {
      for (const side of SIDES) {
        if ((side === "A" ? target.sideAGroupId : target.sideBGroupId) !== fixture.groupId) continue;
        const current = side === "A" ? target.sideAEntryId : target.sideBEntryId;
        if (!current) continue;
        const rank = side === "A" ? target.sideARank : target.sideBRank;
        if (touched(target)) {
          blockers.push(`淘汰赛 ${target.code} 已经开始或已有结果（${fixture.group.code} 组第 ${rank} 名 ${await nameOf(current)} 已在其中），不能自动改写。`);
        } else {
          effects.push(`清空 ${target.code} 中「${fixture.group.code} 组第 ${rank} 名」签位（当前为 ${await nameOf(current)}）。`);
        }
      }
    }
  }
  if (action === "CONFIRM" && fixture.groupId) effects.push(`${fixture.group?.code ?? ""} 组积分榜将计入这场结果。`);

  const published = await client.standingsPublication.count({ where: { competitionId: fixture.competitionId } });
  if (published && action === "REOPEN") effects.push("本项目已发布的名次榜单若因此变化，将标记为「需重新发布」；历史发布版本保留。");
  return { action, blocked: blockers.length > 0, effects, blockers };
}

/** 裁判台与成绩管理页共用：裁判长查看确认/重开某场比赛的影响。 */
export async function getResultImpact(actorUserId: string, matchCode: string, action: "CONFIRM" | "REOPEN") {
  const match = await prisma.match.findUnique({
    where: { code: matchCode },
    select: { id: true, stage: { select: { competition: { select: { tournamentId: true } } } } },
  });
  if (!match) throw new AppError(404, "match_not_found", "比赛不存在。");
  const role = await prisma.roleAssignment.findFirst({
    where: { userId: actorUserId, tournamentId: match.stage.competition.tournamentId, role: "CHIEF_REFEREE" },
    select: { id: true },
  });
  if (!role) throw new AppError(403, "chief_referee_required", "只有裁判长可以查看结果更正影响。");
  return computeResultImpact(prisma, match.id, action);
}

const dispositionSchema = z.object({
  decision: z.enum(["MAINTAIN", "OFFLINE_RULING"]),
  reason: z.string().max(400),
});

/**
 * 已确认结果的更正被后续已开始的比赛阻止时，裁判长登记人工处置决定。
 * 只追加记录，不改动任何比赛、比分或签位。
 */
export async function recordResultDisposition(actorUserId: string, slug: string, matchCode: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, CHIEF_ROLES);
  const parsed = dispositionSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "请求格式无效。");
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "请写明处置依据与决定内容。");

  return prisma.$transaction(
    async (transaction) => {
      const match = await loadResultMatch(transaction, tournament.id, matchCode);
      if (match.verificationStatus !== "LOCKED") throw new AppError(409, "not_locked", "只有已锁定的结果才需要登记更正处置。");
      const impact = await computeResultImpact(transaction, match.id, "REOPEN");
      if (!impact.blocked) {
        throw new AppError(409, "correction_not_blocked", "后续比赛尚未开始，可以直接受控重开更正，无需人工处置。");
      }
      const created = await transaction.resultDisposition.create({
        data: { matchId: match.id, decision: parsed.data.decision, reason, blockedBy: asJson(impact.blockers), decidedByUserId: actorUserId },
        select: { id: true },
      });
      await audit(transaction, tournament.id, actorUserId, "RESULT_DISPOSITION_RECORDED", "Match", match.id, {
        matchCode: match.code,
        decision: parsed.data.decision,
        reason,
        blockedBy: impact.blockers,
      });
      return { id: created.id, decision: parsed.data.decision };
    },
    { timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------
// 项目成绩总览、最终名次与榜单发布
// ---------------------------------------------------------------------------

const resultsFixtureSelect = {
  id: true,
  code: true,
  kind: true,
  round: true,
  sequence: true,
  label: true,
  groupId: true,
  winnerEntryId: true,
  sideASource: true,
  sideARank: true,
  sideBSource: true,
  sideBRank: true,
  group: { select: { code: true } },
  sideAGroup: { select: { code: true } },
  sideBGroup: { select: { code: true } },
  sideAFixture: { select: { code: true } },
  sideBFixture: { select: { code: true } },
  sideAEntry: { select: { id: true, code: true, displayName: true } },
  sideBEntry: { select: { id: true, code: true, displayName: true } },
  matches: {
    select: {
      ...matchFactSelect,
      scheduledAt: true,
      court: { select: { name: true } },
      ruleSnapshot: { select: { config: true } },
      resultDispositions: {
        orderBy: { decidedAt: "desc" },
        select: { decision: true, reason: true, decidedAt: true, decidedBy: { select: { name: true } } },
      },
    },
  },
} satisfies Prisma.FixtureSelect;

type ResultsFixtureRow = Prisma.FixtureGetPayload<{ select: typeof resultsFixtureSelect }>;

function pendingLabel(fixture: ResultsFixtureRow, side: MatchSide) {
  const source = side === "A" ? fixture.sideASource : fixture.sideBSource;
  if (source === "GROUP_RANK") {
    const group = side === "A" ? fixture.sideAGroup : fixture.sideBGroup;
    const rank = side === "A" ? fixture.sideARank : fixture.sideBRank;
    return `${group?.code ?? "?"} 组第 ${rank} 名`;
  }
  if (source === "FIXTURE_WINNER" || source === "FIXTURE_LOSER") {
    const from = side === "A" ? fixture.sideAFixture : fixture.sideBFixture;
    return `${from?.code ?? "?"} ${source === "FIXTURE_WINNER" ? "胜者" : "负者"}`;
  }
  return "待定";
}

export interface StandingsSnapshot {
  competition: { code: string; name: string };
  profile: GroupRanking["profile"];
  groups: { code: string; order: { entryId: string; code: string; name: string; position: number }[]; excluded: { entryId: string; reason: string }[]; lots: string[][]; reason: string | null }[];
  placements: (Placement & { code: string; name: string })[];
}

function hashSnapshot(snapshot: StandingsSnapshot) {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

/** 管理端的成绩总览：比赛结果状态、小组名次（含解释）、淘汰晋级、最终名次与榜单发布状态。 */
export async function loadCompetitionResults(client: Client, tournamentId: string, competitionCode: string) {
  const competition = await client.competition.findUnique({
    where: { tournamentId_code: { tournamentId, code: competitionCode.toUpperCase() } },
    select: {
      id: true,
      code: true,
      name: true,
      entryType: true,
      draws: { where: { status: "PUBLISHED" }, select: { id: true, format: true, settings: true } },
    },
  });
  if (!competition) return null;
  const draw = competition.draws[0] ?? null;
  if (!draw || competition.entryType === "TEAM") return { competition, draw, results: null };

  const fixtures = await client.fixture.findMany({
    where: { drawId: draw.id },
    orderBy: [{ stage: { order: "asc" } }, { round: "asc" }, { sequence: "asc" }],
    select: resultsFixtureSelect,
  });
  const groupRows = await client.group.findMany({ where: { stage: { drawId: draw.id } }, orderBy: { code: "asc" }, select: { id: true } });
  // 逐组顺序读取：在事务客户端上并发查询会被驱动串行化并告警。
  const groups: Awaited<ReturnType<typeof loadIndividualGroupRanking>>[] = [];
  for (const group of groupRows) groups.push(await loadIndividualGroupRanking(client, group.id));

  const entryNames = new Map<string, { code: string; name: string }>();
  for (const fixture of fixtures) {
    for (const entry of [fixture.sideAEntry, fixture.sideBEntry]) if (entry) entryNames.set(entry.id, { code: entry.code, name: entry.displayName });
  }
  for (const group of groups) for (const entry of group.entries) entryNames.set(entry.id, { code: entry.code, name: entry.displayName });

  const matches = fixtures.map((fixture) => {
    const match = fixture.matches[0];
    const fact = match ? matchFactOf(match) : NOT_STARTED_FACT;
    const latest = match?.resultRevisions[0] ?? null;
    return {
      fixtureId: fixture.id,
      fixtureCode: fixture.code,
      kind: fixture.kind,
      round: fixture.round,
      label: fixture.label,
      groupCode: fixture.group?.code ?? null,
      matchCode: match?.code ?? null,
      scheduledAt: match?.scheduledAt?.toISOString() ?? null,
      court: match?.court?.name ?? null,
      started: match ? isStarted(match) : false,
      bestOf: (match?.ruleSnapshot?.config as { bestOf?: number } | undefined)?.bestOf ?? 3,
      resultSource: match?.resultSource ?? "LIVE",
      verificationStatus: match?.verificationStatus ?? "UNVERIFIED",
      latestRevision: latest
        ? { revision: latest.revision, status: latest.status, source: latest.source, submittedByUserId: latest.actorUserId, reason: latest.reason }
        : null,
      dispositions: match?.resultDispositions.map((item) => ({
        decision: item.decision,
        reason: item.reason,
        decidedAt: item.decidedAt.toISOString(),
        decidedBy: item.decidedBy?.name ?? null,
      })) ?? [],
      fact,
      winnerEntryId: fixture.winnerEntryId,
      sides: SIDES.map((side) => {
        const entry = side === "A" ? fixture.sideAEntry : fixture.sideBEntry;
        return { side, entry: entry ? { id: entry.id, code: entry.code, name: entry.displayName } : null, pending: entry ? null : pendingLabel(fixture, side) };
      }),
    };
  });

  const settings = (draw.settings ?? {}) as { qualifiersPerGroup?: number };
  const knockout: PlacementFixtureFact[] = fixtures
    .filter((fixture) => fixture.kind !== "GROUP")
    .map((fixture) => ({
      code: fixture.code,
      kind: fixture.kind as "KNOCKOUT" | "THIRD_PLACE",
      round: fixture.round,
      sideA: fixture.sideAEntry?.id ?? null,
      sideB: fixture.sideBEntry?.id ?? null,
      winner: fixture.winnerEntryId,
    }));
  const { placements, complete } = computePlacements({
    format: draw.format,
    qualifiersPerGroup: settings.qualifiersPerGroup ?? 2,
    knockout,
    groups: groups.map((item) => ({
      code: item.group.code,
      confirmedOrder: item.confirmed?.order ?? null,
      entryIds: item.entries.map((entry) => entry.id),
      excludedEntryIds: item.confirmed?.excluded.map((excluded) => excluded.entryId) ?? [],
    })),
  });

  const label = (entryId: string) => entryNames.get(entryId) ?? { code: "?", name: entryId };
  const snapshot: StandingsSnapshot = {
    competition: { code: competition.code, name: competition.name },
    profile: groups[0]?.ranking.profile ?? {
      key: CAMPUS_DEMO_RANKING.key,
      version: CAMPUS_DEMO_RANKING.version,
      name: CAMPUS_DEMO_RANKING.name,
      demo: CAMPUS_DEMO_RANKING.demo,
    },
    groups: groups
      .filter((item) => item.confirmed)
      .map((item) => {
        const confirmed = item.confirmed as ConfirmedGroupRanking;
        const lotsOf = new Map<string, number>();
        for (const block of confirmed.lots) for (const id of block) lotsOf.set(id, block.length);
        return {
          code: item.group.code,
          order: confirmed.order.map((entryId, index) => ({ entryId, ...label(entryId), position: index + 1 })),
          excluded: confirmed.excluded,
          lots: confirmed.lots,
          reason: confirmed.reason,
        };
      }),
    placements: placements.filter((item) => item.label !== "名次待定").map((item) => ({ ...item, ...label(item.entryId) })),
  };
  const contentHash = hashSnapshot(snapshot);
  const publications = await client.standingsPublication.findMany({
    where: { competitionId: competition.id },
    orderBy: { version: "desc" },
    select: { version: true, contentHash: true, publishedAt: true, note: true, publishedBy: { select: { name: true } } },
  });
  const latest = publications[0] ?? null;

  return {
    competition,
    draw,
    results: {
      matches,
      groups,
      placements: placements.map((item) => ({ ...item, ...label(item.entryId) })),
      placementsComplete: complete,
      snapshot,
      contentHash,
      publishable: snapshot.groups.length > 0 || snapshot.placements.length > 0,
      publications: publications.map((item) => ({
        version: item.version,
        contentHash: item.contentHash,
        publishedAt: item.publishedAt.toISOString(),
        note: item.note,
        publishedBy: item.publishedBy?.name ?? null,
      })),
      needsRepublish: Boolean(latest && latest.contentHash !== contentHash),
    },
  };
}

export type CompetitionResults = NonNullable<NonNullable<Awaited<ReturnType<typeof loadCompetitionResults>>>["results"]>;

const publishSchema = z.object({ note: z.string().max(400).nullish() });

/**
 * 发布名次榜单的一个版本（只含已确认的小组名次与已决出的最终名次）。
 * 结果被更正后内容摘要变化，界面标记需重新发布；历史版本全部保留。
 */
export async function publishStandings(actorUserId: string, slug: string, competitionCode: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, PUBLISH_ROLES);
  const parsed = publishSchema.safeParse(rawInput ?? {});
  if (!parsed.success) throw new AppError(400, "invalid_input", "请求格式无效。");
  const note = parsed.data.note ? normalizeReason(parsed.data.note) : null;

  return prisma.$transaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const loaded = await loadCompetitionResults(transaction, tournament.id, competitionCode);
      if (!loaded) throw new AppError(404, "competition_not_found", "项目不存在。");
      if (!loaded.results) throw new AppError(409, "results_unavailable", "该项目没有已发布的抽签，或是团体项目（团体积分榜在团体对抗页面确认）。");
      const { results } = loaded;
      if (!results.publishable) throw new AppError(409, "nothing_to_publish", "还没有已确认的小组名次或已决出的最终名次，不能发布榜单。");
      const latest = results.publications[0];
      if (latest && latest.contentHash === results.contentHash) {
        throw new AppError(409, "standings_unchanged", `榜单内容与第 ${latest.version} 版相同，无需重新发布。`);
      }
      const version = (latest?.version ?? 0) + 1;
      await transaction.standingsPublication.create({
        data: {
          competitionId: loaded.competition.id,
          version,
          contentHash: results.contentHash,
          snapshot: asJson(results.snapshot),
          note,
          publishedByUserId: actorUserId,
        },
      });
      await audit(transaction, tournament.id, actorUserId, "STANDINGS_PUBLISHED", "Competition", loaded.competition.id, {
        competitionCode: loaded.competition.code,
        version,
        contentHash: results.contentHash,
        previousVersion: latest?.version ?? null,
        note,
      });
      return { version, contentHash: results.contentHash };
    },
    { timeout: 20_000 },
  );
}

/** 路由：按项目类型分派小组名次确认（团体项目沿用 4-D 的团体积分榜）。 */
export async function competitionEntryType(tournamentSlug: string, competitionCode: string) {
  const competition = await prisma.competition.findFirst({
    where: { code: competitionCode.toUpperCase(), tournament: { slug: tournamentSlug } },
    select: { entryType: true },
  });
  return competition?.entryType ?? null;
}

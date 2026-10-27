import { z } from "zod";

import { Prisma, type MatchSide, type TournamentPhase } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { runTransaction } from "@/server/services/transaction";
import { normalizeReason } from "@/domain/registration/registration-rules";
import { RUBBER_LABEL, type Gender, type RubberKind } from "@/domain/registration/team-roster";
import type { MatchState } from "@/domain/rules/match-engine";
import { appearanceErrors, validateLineup, type LineupRosterMember, type TieAppearanceLimits } from "@/domain/team/lineup";
import { applyConfirmedOrder, computeStandings, type GroupStandings, type StandingTie } from "@/domain/team/standings";
import { computeTie, concededGames, tiePolicyFor, type ConcessionRules, type RubberFact, type TieSide, type TieSummary } from "@/domain/team/tie";
import { traditional21Demo } from "@/domain/rules/rule-profile";
import {
  requireManagedTournament,
  requirePasswordSettled,
  requireTeamManagerAccess,
  TOURNAMENT_MANAGER_ROLES,
} from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import { lockTournamentRow } from "@/server/services/registration-service";
import { loadFixtureScheduleFacts, loadScheduleFacts } from "@/server/services/schedule-facts";
import { checkSchedule } from "@/domain/schedule/check";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;

/** 抽签发布之后、赛事结束之前可以排出场名单。 */
const LINEUP_PHASES: TournamentPhase[] = ["REGISTRATION_CLOSED", "RUNNING"];

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

export async function lockFixtureRow(transaction: Tx, fixtureId: string) {
  await transaction.$queryRaw`SELECT "id" FROM "fixtures" WHERE "id" = ${fixtureId}::uuid FOR UPDATE`;
}

/**
 * CON-001：锁住小组行并返回锁后的名次确认时刻。
 * 确认名次的事务全程持有小组行锁；改变本组比赛结果的结算必须先取得同一把锁再判断“名次是否已确认”，
 * 否则在默认 Read Committed 下会读到确认事务提交前的旧值、跳过撤销，留下名次与结果不一致的混合状态。
 * 锁顺序固定为“本场对阵 → 小组 → 下游签位”，与确认名次的“小组 → 下游签位”一致，不形成环。
 * 可串行化事务（裁判台命令）在此处遇到并发提交会得到序列化冲突，由调用方的有界重试整段重跑。
 */
export async function lockGroupRankingState(transaction: Tx, groupId: string) {
  const [row] = await transaction.$queryRaw<{ rankingConfirmedAt: Date | null }[]>`
    SELECT "rankingConfirmedAt" FROM "competition_groups" WHERE "id" = ${groupId}::uuid FOR UPDATE`;
  return row?.rankingConfirmedAt ?? null;
}

// ---------------------------------------------------------------------------
// 读取：对阵、小场与上场队员
// ---------------------------------------------------------------------------

const fixtureSelect = {
  id: true,
  code: true,
  kind: true,
  round: true,
  sequence: true,
  label: true,
  drawId: true,
  groupId: true,
  sideASource: true,
  sideAEntryId: true,
  sideAGroupId: true,
  sideARank: true,
  sideAFixtureId: true,
  sideBSource: true,
  sideBEntryId: true,
  sideBGroupId: true,
  sideBRank: true,
  sideBFixtureId: true,
  lineupsRevealedAt: true,
  winnerEntryId: true,
  decidedAt: true,
  draw: { select: { status: true } },
  group: { select: { code: true, rankingConfirmedAt: true } },
  sideAGroup: { select: { code: true } },
  sideBGroup: { select: { code: true } },
  sideAFixture: { select: { code: true } },
  sideBFixture: { select: { code: true } },
  sideAEntry: { select: { id: true, code: true, displayName: true, teamId: true, withdrawnAt: true } },
  sideBEntry: { select: { id: true, code: true, displayName: true, teamId: true, withdrawnAt: true } },
  competition: {
    select: { id: true, code: true, name: true, entryType: true, tournamentId: true, teamMaxRubbersMale: true, teamMaxRubbersFemale: true },
  },
  lineups: { select: { side: true, version: true, source: true, submittedAt: true, submittedLate: true, concededOrders: true } },
  matches: {
    orderBy: { rubberOrder: "asc" },
    select: {
      id: true,
      code: true,
      rubberKind: true,
      rubberOrder: true,
      version: true,
      lifecycleStatus: true,
      verificationStatus: true,
      outcomeType: true,
      notPlayedAt: true,
      scheduledAt: true,
      scheduledEndAt: true,
      scheduleEstimated: true,
      court: { select: { name: true } },
      snapshot: { select: { state: true } },
      ruleSnapshot: { select: { config: true } },
      players: {
        orderBy: [{ side: "asc" }, { slot: "asc" }],
        select: { side: true, slot: true, participantId: true, participant: { select: { displayName: true, publicCode: true, withdrawnAt: true } } },
      },
    },
  },
} satisfies Prisma.FixtureSelect;

export type TieFixtureRow = Prisma.FixtureGetPayload<{ select: typeof fixtureSelect }>;
type TieMatchRow = TieFixtureRow["matches"][number];

export function isStarted(match: Pick<TieMatchRow, "version" | "lifecycleStatus">) {
  return match.version > 0 || (match.lifecycleStatus !== "SCHEDULED" && match.lifecycleStatus !== "READY");
}

type Concession = Record<TieSide, boolean>;
const NO_CONCESSION: Concession = { A: false, B: false };
/** 退赛、弃权、取消资格：负方在本场对抗里的后续小场不再上场（GCR 13.6.2）。 */
const WITHDRAWING_OUTCOMES = new Set(["RET", "WO", "DSQ"]);

function lockedState(match: TieMatchRow) {
  return match.verificationStatus === "LOCKED" && match.snapshot ? (match.snapshot.state as unknown as MatchState) : null;
}

function concessionRules(config: unknown): ConcessionRules {
  const value = (config ?? traditional21Demo) as Partial<ConcessionRules>;
  return {
    bestOf: value.bestOf ?? traditional21Demo.bestOf,
    targetPoints: value.targetPoints ?? traditional21Demo.targetPoints,
    winBy: value.winBy ?? traditional21Demo.winBy,
    capPoints: value.capPoints ?? traditional21Demo.capPoints,
  };
}

/**
 * 每个小场的认输方（赛务口径 W-6、W-3、W-4、W-7）：
 * - 双方名单揭晓后，名单里声明认输的小场；
 * - 已锁定的小场以退赛 / 弃权 / 取消资格结束时，负方上场的队员在本场对抗里排在后面、尚未开始的小场；
 * - 已登记退出或被取消资格的队员排在里面、尚未开始的小场；
 * - 整体退出的报名单位：这一侧全部尚未开始的小场。
 */
export function tieConcessions(
  fixture: Pick<TieFixtureRow, "lineups" | "lineupsRevealedAt" | "matches"> & Partial<Pick<TieFixtureRow, "sideAEntry" | "sideBEntry">>,
): Map<number, Concession> {
  const result = new Map<number, Concession>();
  const mark = (order: number, side: TieSide) => result.set(order, { ...(result.get(order) ?? NO_CONCESSION), [side]: true });
  if (fixture.lineupsRevealedAt) {
    for (const lineup of fixture.lineups) for (const order of lineup.concededOrders) mark(order, lineup.side);
  }
  const entryWithdrawn: Record<TieSide, boolean> = { A: Boolean(fixture.sideAEntry?.withdrawnAt), B: Boolean(fixture.sideBEntry?.withdrawnAt) };
  for (const match of fixture.matches) {
    if (isStarted(match) || match.verificationStatus === "LOCKED") continue;
    for (const side of SIDES) {
      if (entryWithdrawn[side] || match.players.some((player) => player.side === side && player.participant.withdrawnAt)) mark(match.rubberOrder ?? 0, side);
    }
  }
  const ordered = [...fixture.matches].sort((left, right) => (left.rubberOrder ?? 0) - (right.rubberOrder ?? 0));
  const withdrawn: Record<TieSide, Set<string>> = { A: new Set(), B: new Set() };
  for (const match of ordered) {
    const order = match.rubberOrder ?? 0;
    if (!isStarted(match) && match.verificationStatus !== "LOCKED") {
      for (const side of SIDES) {
        if (match.players.some((player) => player.side === side && withdrawn[side].has(player.participantId))) mark(order, side);
      }
    }
    const outcome = lockedState(match)?.specialOutcome;
    if (outcome?.winnerSide && WITHDRAWING_OUTCOMES.has(outcome.type)) {
      const loser: TieSide = outcome.winnerSide === "A" ? "B" : "A";
      for (const player of match.players) if (player.side === loser) withdrawn[loser].add(player.participantId);
    }
  }
  return result;
}

/** 从已锁定小场的权威快照读取胜方与各局比分；未锁定的小场不给结果。认输的小场按 GCR 16.3.8 直接给出结果。 */
function rubberFact(match: TieMatchRow, concession: Concession = NO_CONCESSION): RubberFact {
  const order = match.rubberOrder ?? 0;
  const kind = match.rubberKind as RubberKind;
  if ((concession.A || concession.B) && !isStarted(match) && match.verificationStatus !== "LOCKED") {
    if (concession.A && concession.B) return { order, kind, started: false, final: true, winner: null, games: [], countedGames: [] };
    const winner: TieSide = concession.A ? "B" : "A";
    return { order, kind, started: false, final: true, winner, games: [], countedGames: concededGames([], null, winner, concessionRules(match.ruleSnapshot?.config)) };
  }
  const final = match.verificationStatus === "LOCKED";
  const state = lockedState(match);
  let winner: RubberFact["winner"] = null;
  if (state) {
    if (state.specialOutcome) winner = state.specialOutcome.winnerSide;
    else if (state.gamesWon.A !== state.gamesWon.B) winner = state.gamesWon.A > state.gamesWon.B ? "A" : "B";
  }
  const games = state ? state.completedGames.map((game) => ({ a: game.scoreA, b: game.scoreB })) : [];
  const outcome = state?.specialOutcome;
  const countedGames =
    state && outcome?.winnerSide && WITHDRAWING_OUTCOMES.has(outcome.type)
      ? concededGames(games, { a: state.score.A, b: state.score.B }, outcome.winnerSide, concessionRules(state.ruleConfig))
      : games;
  return { order, kind, started: isStarted(match), final, winner, games, countedGames };
}

export function summarizeTie(
  fixture: Pick<TieFixtureRow, "kind" | "matches" | "lineups" | "lineupsRevealedAt"> & Partial<Pick<TieFixtureRow, "sideAEntry" | "sideBEntry">>,
): TieSummary {
  const concessions = tieConcessions(fixture);
  return computeTie(
    fixture.matches.map((match) => rubberFact(match, concessions.get(match.rubberOrder ?? 0))),
    tiePolicyFor(fixture.kind),
  );
}

export function rubberResultOf(match: TieMatchRow, concessions: Map<number, Concession> = new Map()) {
  const concession = concessions.get(match.rubberOrder ?? 0) ?? NO_CONCESSION;
  const fact = rubberFact(match, concession);
  return { final: fact.final, winner: fact.winner, games: fact.games, started: fact.started, conceded: concession.A ? ("A" as const) : concession.B ? ("B" as const) : null };
}

export async function loadTieFixture(client: Client, where: Prisma.FixtureWhereInput) {
  return client.fixture.findFirst({ where, select: fixtureSelect });
}

function sideEntryId(fixture: Pick<TieFixtureRow, "sideAEntryId" | "sideBEntryId">, side: MatchSide) {
  return side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId;
}

// ---------------------------------------------------------------------------
// 出场名单：负责人盲交，管理员代交；双方交齐同时公开并锁定
// ---------------------------------------------------------------------------

const lineupSchema = z.object({
  side: z.enum(["A", "B"]).nullish(),
  expectedVersion: z.number().int().nonnegative().nullish(),
  rubbers: z
    .array(z.object({ order: z.number().int().min(1).max(9), participantIds: z.array(z.string().uuid()).max(2), conceded: z.boolean().optional() }))
    .max(9),
});

export interface LineupActor {
  userId: string;
  mode: "TEAM_MANAGER" | "ADMIN";
}

async function loadRoster(client: Client, entryId: string): Promise<LineupRosterMember[]> {
  const members = await client.entryMember.findMany({
    // 已退出或被取消资格的队员不再出现在可选名单里（赛务口径 W-4，GCR 13.6.3）。
    where: { entryId, participant: { withdrawnAt: null } },
    orderBy: { slot: "asc" },
    select: { participantId: true, rubberKinds: true, participant: { select: { displayName: true, publicCode: true, gender: true } } },
  });
  return members.map((member) => ({
    participantId: member.participantId,
    label: member.participant.displayName,
    gender: member.participant.gender as Gender,
    rubberKinds: member.rubberKinds as RubberKind[],
  }));
}

function limitsOf(fixture: TieFixtureRow): TieAppearanceLimits {
  return { MALE: fixture.competition.teamMaxRubbersMale, FEMALE: fixture.competition.teamMaxRubbersFemale };
}

function assertLineupPhase(phase: TournamentPhase) {
  if (!LINEUP_PHASES.includes(phase)) {
    throw new AppError(409, "lineup_phase_closed", "只有抽签发布后、赛事结束前可以提交出场名单。");
  }
}

function assertTeamFixture(fixture: TieFixtureRow | null, tournamentId: string): asserts fixture is TieFixtureRow {
  if (!fixture || fixture.competition.tournamentId !== tournamentId) throw new AppError(404, "fixture_not_found", "对抗不存在。");
  if (fixture.competition.entryType !== "TEAM") throw new AppError(400, "not_team_fixture", "该对阵不是团体对抗。");
  if (fixture.draw.status !== "PUBLISHED") throw new AppError(409, "draw_not_published", "该对阵所属的抽签尚未发布或已撤销。");
}

/**
 * 提交或修改一方的出场名单。
 * - 负责人只能提交本队所在的一侧，看不到对方名单；管理员代交时须指定一侧。
 * - 双方都交齐后同时公开并锁定；锁定后只有裁判长可以写明原因修改尚未开始的小场。
 */
export async function submitLineup(actor: LineupActor, slug: string, fixtureId: string, rawInput: unknown) {
  let tournamentId: string;
  let managedTeamIds: string[] = [];
  if (actor.mode === "TEAM_MANAGER") {
    const access = await requireTeamManagerAccess(actor.userId, slug);
    await requirePasswordSettled(actor.userId);
    tournamentId = access.tournament.id;
    managedTeamIds = access.teams.map((team) => team.id);
  } else {
    const access = await requireManagedTournament(actor.userId, slug, TOURNAMENT_MANAGER_ROLES);
    tournamentId = access.tournament.id;
  }
  const parsed = lineupSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "出场名单格式无效。");
  const input = parsed.data;

  return runTransaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournamentId);
      await lockFixtureRow(transaction, fixtureId);
      const tournament = await transaction.tournament.findUniqueOrThrow({ where: { id: tournamentId }, select: { phase: true } });
      assertLineupPhase(tournament.phase);
      const fixture = await loadTieFixture(transaction, { id: fixtureId });
      assertTeamFixture(fixture, tournamentId);

      let side: MatchSide;
      if (actor.mode === "TEAM_MANAGER") {
        const own = SIDES.filter((candidate) => {
          const entry = candidate === "A" ? fixture.sideAEntry : fixture.sideBEntry;
          return entry?.teamId && managedTeamIds.includes(entry.teamId);
        });
        if (own.length !== 1) throw new AppError(403, "not_fixture_team", "你负责的队伍不在这场对抗中。");
        side = own[0];
      } else {
        if (!input.side) throw new AppError(400, "side_required", "代交出场名单须指定是哪一方。");
        side = input.side;
      }
      const entryId = sideEntryId(fixture, side);
      if (!entryId) throw new AppError(409, "side_not_resolved", "这一方的队伍尚未确定（待前序结果产生）。");
      if ((side === "A" ? fixture.sideAEntry : fixture.sideBEntry)?.withdrawnAt) {
        throw new AppError(409, "entry_withdrawn", "这支队伍已登记退出比赛，不再提交出场名单。");
      }
      if (fixture.lineupsRevealedAt) {
        throw new AppError(409, "lineup_locked", "双方出场名单已公开并锁定；如需调整请联系裁判长。");
      }

      // 出场名单截止：首个小场计划开始前若干分钟（赛程发布后才有）。截止后负责人不能再交或改，只能由管理员代交并标记逾期。
      const schedule = await loadFixtureScheduleFacts(transaction, tournamentId, fixtureId);
      const now = new Date();
      const late = schedule.deadline !== null && now >= schedule.deadline;
      if (late && actor.mode === "TEAM_MANAGER") {
        throw new AppError(409, "lineup_deadline_passed", "已过出场名单截止时间，请联系赛事管理员代交。", {
          deadline: schedule.deadline?.toISOString(),
        });
      }

      const rubbers = fixture.matches.map((match) => ({ order: match.rubberOrder as number, kind: match.rubberKind as RubberKind }));
      const roster = await loadRoster(transaction, entryId);
      const { lineup, errors } = validateLineup(rubbers, roster, input.rubbers, {
        limits: limitsOf(fixture),
        overlappingOrders: schedule.overlappingOrders,
      });
      if (!lineup) throw new AppError(400, "invalid_lineup", errors.join("；"), { errors });

      const existing = await transaction.fixtureLineup.findUnique({
        where: { fixtureId_side: { fixtureId, side } },
        select: { id: true, version: true },
      });
      if (existing) {
        if (input.expectedVersion !== existing.version) {
          throw new AppError(409, "version_conflict", "出场名单已被修改，请刷新后重试。");
        }
      } else if (input.expectedVersion !== null && input.expectedVersion !== undefined) {
        throw new AppError(409, "version_conflict", "出场名单状态已变化，请刷新后重试。");
      }

      const matchByOrder = new Map(fixture.matches.map((match) => [match.rubberOrder as number, match]));
      await transaction.matchPlayer.deleteMany({ where: { matchId: { in: fixture.matches.map((match) => match.id) }, side } });
      const concededOrders = lineup.filter((rubber) => rubber.conceded).map((rubber) => rubber.order);
      await transaction.matchPlayer.createMany({
        data: lineup.flatMap((rubber) =>
          rubber.participantIds.map((participantId, index) => ({
            matchId: (matchByOrder.get(rubber.order) as TieMatchRow).id,
            side,
            slot: index + 1,
            entryId,
            participantId,
          })),
        ),
      });
      const scheduleWarnings = await individualOverlapWarnings(transaction, tournamentId, fixture.matches.map((match) => match.id));
      const version = existing ? existing.version + 1 : 1;
      await transaction.fixtureLineup.upsert({
        where: { fixtureId_side: { fixtureId, side } },
        create: { fixtureId, side, entryId, source: actor.mode, submittedLate: late, version, submittedByUserId: actor.userId, submittedAt: now, concededOrders },
        update: { entryId, source: actor.mode, submittedLate: late, version, submittedByUserId: actor.userId, submittedAt: now, concededOrders },
      });
      await audit(transaction, tournamentId, actor.userId, existing ? "LINEUP_UPDATED" : "LINEUP_SUBMITTED", "Fixture", fixtureId, {
        competitionCode: fixture.competition.code,
        fixtureCode: fixture.code,
        side,
        version,
        via: actor.mode,
        late,
        deadline: schedule.deadline?.toISOString() ?? null,
        rubbers: lineup.map((rubber) => ({ order: rubber.order, participantIds: rubber.participantIds, ...(rubber.conceded ? { conceded: true } : {}) })),
      });

      const otherSide: MatchSide = side === "A" ? "B" : "A";
      const other = await transaction.fixtureLineup.findUnique({ where: { fixtureId_side: { fixtureId, side: otherSide } }, select: { id: true } });
      let revealed = false;
      if (other) {
        await transaction.fixture.update({ where: { id: fixtureId }, data: { lineupsRevealedAt: now } });
        await audit(transaction, tournamentId, actor.userId, "LINEUPS_REVEALED", "Fixture", fixtureId, {
          competitionCode: fixture.competition.code,
          fixtureCode: fixture.code,
        });
        revealed = true;
        // 名单里有认输的小场时，揭晓即生效：结算对抗（可能因此已决出胜负）并把认输的小场记为未进行。
        await settleTeamFixture(transaction, fixtureId, actor.userId);
      }
      return { side, version, revealed, late, scheduleWarnings };
    },
    { timeout: 20_000 },
  );
}

/**
 * 赛务口径 S-3（2026-10-27，P-09）：出场名单里的队员如果有个人项目比赛与这场对抗的小场时间重叠，只提示、不拒绝。
 * 同一时刻真正上场由开赛检查（S-4）拦截；这里让负责人在提交时就知道，可以换人或请管理员改期。
 * 只看已发布的安排，只报「小场 × 个人比赛」的选手重叠；消息不含对方名单。
 */
async function individualOverlapWarnings(transaction: Prisma.TransactionClient, tournamentId: string, rubberIds: string[]) {
  const facts = await loadScheduleFacts(transaction, tournamentId);
  const rubbers = new Set(rubberIds);
  const check = checkSchedule({
    matches: facts.facts,
    placements: facts.published,
    courts: facts.courts,
    referees: facts.referees,
    refereesRequired: false,
    windows: [],
    names: facts.names,
    focus: rubbers,
  });
  return check.issues
    .filter((issue) => issue.code === "PERSON_OVERLAP" && issue.matchIds.some((id) => !rubbers.has(id) && !facts.factById.get(id)?.isTeam))
    .map((issue) => {
      const [rubberId, otherId] = rubbers.has(issue.matchIds[0]) ? issue.matchIds : [...issue.matchIds].reverse();
      return `${facts.factById.get(rubberId)?.label ?? "本场小场"} 与个人项目 ${facts.factById.get(otherId)?.label ?? "另一场比赛"} 计划时间重叠，有队员同时出场；可以换人，或请管理员调整时间。`;
    });
}

const amendSchema = z.object({
  side: z.enum(["A", "B"]),
  order: z.number().int().min(1).max(9),
  participantIds: z.array(z.string().uuid()).max(2),
  reason: z.string().max(400),
});

/**
 * 名单公开后由裁判长修改某个尚未开始的小场（如伤病换人），必须写原因，前后名单都进审计。
 */
export async function amendLineup(actorUserId: string, slug: string, fixtureId: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["CHIEF_REFEREE"]);
  const parsed = amendSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "修改请求格式无效。");
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "修改已公开的出场名单必须写明原因。");
  const { side, order, participantIds } = parsed.data;

  return runTransaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      await lockFixtureRow(transaction, fixtureId);
      const current = await transaction.tournament.findUniqueOrThrow({ where: { id: tournament.id }, select: { phase: true } });
      assertLineupPhase(current.phase);
      const fixture = await loadTieFixture(transaction, { id: fixtureId });
      assertTeamFixture(fixture, tournament.id);
      if (!fixture.lineupsRevealedAt) throw new AppError(409, "lineup_not_revealed", "双方名单尚未交齐，应由负责人自行修改。");
      const match = fixture.matches.find((item) => item.rubberOrder === order);
      if (!match) throw new AppError(404, "rubber_not_found", "本场对抗没有这个小场。");
      if (isStarted(match) || match.notPlayedAt) {
        throw new AppError(409, "rubber_started", "该小场已经开始或已记为未进行，不能再改上场队员。");
      }
      await transaction.$queryRaw`SELECT "id" FROM "matches" WHERE "id" = ${match.id}::uuid FOR UPDATE`;
      const events = await transaction.matchEvent.count({ where: { matchId: match.id } });
      const activeSession = await transaction.scoringSession.count({
        where: { matchId: match.id, status: "ACTIVE", expiresAt: { gt: new Date() } },
      });
      if (events > 0 || activeSession > 0) {
        throw new AppError(409, "rubber_started", "该小场已有裁判取得计分控制或产生记录，请先让裁判释放控制。");
      }
      const entryId = sideEntryId(fixture, side) as string;
      const roster = await loadRoster(transaction, entryId);
      const { lineup, errors } = validateLineup(
        [{ order, kind: match.rubberKind as RubberKind }],
        roster,
        [{ order, participantIds }],
      );
      if (!lineup) throw new AppError(400, "invalid_lineup", errors.join("；"), { errors });
      // 换人后整份名单仍须满足兼项上限，且不能让同一人出现在时间重叠的两个小场。
      const schedule = await loadFixtureScheduleFacts(transaction, tournament.id, fixtureId);
      const whole = fixture.matches
        .filter((item) => !item.notPlayedAt)
        .map((item) => ({
          order: item.rubberOrder as number,
          kind: item.rubberKind as RubberKind,
          participantIds: item.id === match.id ? lineup[0].participantIds : item.players.filter((player) => player.side === side).map((player) => player.participantId),
        }));
      const wholeErrors = appearanceErrors(whole, roster, { limits: limitsOf(fixture), overlappingOrders: schedule.overlappingOrders });
      if (wholeErrors.length) throw new AppError(400, "invalid_lineup", wholeErrors.join("；"), { errors: wholeErrors });

      const before = match.players.filter((player) => player.side === side).map((player) => player.participantId);
      await transaction.matchPlayer.deleteMany({ where: { matchId: match.id, side } });
      await transaction.matchPlayer.createMany({
        data: lineup[0].participantIds.map((participantId, index) => ({ matchId: match.id, side, slot: index + 1, entryId, participantId })),
      });
      // 快照只是由事实推导的初始状态（版本 0、没有事件），删掉后下次读取按新名单重建。
      await transaction.matchSnapshot.deleteMany({ where: { matchId: match.id } });
      await transaction.fixtureLineup.update({
        where: { fixtureId_side: { fixtureId, side } },
        data: { version: { increment: 1 } },
      });
      await audit(transaction, tournament.id, actorUserId, "LINEUP_AMENDED", "Match", match.id, {
        competitionCode: fixture.competition.code,
        fixtureCode: fixture.code,
        matchCode: match.code,
        side,
        before,
        after: lineup[0].participantIds,
        reason,
      });
      return { matchCode: match.code };
    },
    { timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------
// 结算：小场结果锁定或重开后推导对抗胜负、未进行的小场，并回填下一轮
// ---------------------------------------------------------------------------

export async function assertFixtureUntouched(transaction: Tx, fixtureId: string, what: string) {
  const fixture = await transaction.fixture.findUniqueOrThrow({
    where: { id: fixtureId },
    select: { code: true, winnerEntryId: true, vacancyDecided: true, matches: { select: { version: true, lifecycleStatus: true } } },
  });
  // 因对手空缺直接决出的对阵没有打过比赛，来源变化时可以撤回重算（见 settleVacancy）。
  if ((fixture.winnerEntryId && !fixture.vacancyDecided) || fixture.matches.some(isStarted)) {
    throw new AppError(409, "downstream_started", `${what}已用于后续对阵 ${fixture.code}，且该对阵已经开始或已有结果，不能自动改写；请由裁判长登记人工处置（维持原结果或线下裁决）。`);
  }
}

/**
 * 设置或清除对阵某一侧的队伍，同步该对阵全部比赛的同一侧；清除时一并作废该对阵已交的出场名单。
 * `vacant`：该侧来源已经确定但无人可填（K-1/K-2），与「来源尚未产生」区分；设置后立即按空位结算本对阵。
 */
export async function setFixtureSide(
  transaction: Tx,
  tournamentId: string,
  actorUserId: string | null,
  fixtureId: string,
  side: MatchSide,
  entryId: string | null,
  cause: string,
  vacant = false,
) {
  const column = side === "A" ? "sideAEntryId" : "sideBEntryId";
  const vacantColumn = side === "A" ? "sideAVacant" : "sideBVacant";
  const isVacant = vacant && entryId === null;
  const fixture = await transaction.fixture.findUniqueOrThrow({
    where: { id: fixtureId },
    select: { code: true, kind: true, sideAEntryId: true, sideBEntryId: true, sideAVacant: true, sideBVacant: true, vacancyDecided: true, lineupsRevealedAt: true, competition: { select: { code: true } } },
  });
  if (fixture[column] === entryId && fixture[vacantColumn] === (isVacant && fixture.kind !== "GROUP")) return;
  if (fixture[column]) {
    await assertFixtureUntouched(transaction, fixtureId, cause);
    const matchIds = (await transaction.match.findMany({ where: { fixtureId }, select: { id: true } })).map((match) => match.id);
    const cleared = await transaction.fixtureLineup.deleteMany({ where: { fixtureId } });
    await transaction.matchPlayer.deleteMany({ where: { matchId: { in: matchIds } } });
    await transaction.matchSnapshot.deleteMany({ where: { matchId: { in: matchIds } } });
    if (cleared.count > 0 || fixture.lineupsRevealedAt) {
      await audit(transaction, tournamentId, actorUserId, "LINEUPS_CLEARED", "Fixture", fixtureId, {
        competitionCode: fixture.competition.code,
        fixtureCode: fixture.code,
        cleared: cleared.count,
        cause,
      });
    }
  }
  // 因空位直接决出的对阵：一侧来源变化时先撤回这次决出（同一条更新，满足空位约束），再按新状态重新结算。
  const resetVacancy = fixture.vacancyDecided ? { winnerEntryId: null, decidedAt: null, vacancyDecided: false } : {};
  await transaction.fixture.update({
    where: { id: fixtureId },
    data: { [column]: entryId, [vacantColumn]: isVacant && fixture.kind !== "GROUP", ...resetVacancy, ...(fixture[column] ? { lineupsRevealedAt: null } : {}) },
  });
  await transaction.match.updateMany({ where: { fixtureId }, data: { [column]: entryId, ...(fixture.vacancyDecided ? { notPlayedAt: null } : {}) } });
  await settleVacancy(transaction, tournamentId, actorUserId, fixtureId, fixture.vacancyDecided);
}

/**
 * 赛务口径 K-1 / K-2（2026-10-27，P-03）：淘汰对阵一侧确定为空时另一侧以 WO 晋级（GCR 13.7 的同一处理）；
 * 两侧都空则本对阵无胜者，空位继续传给下一轮。该对阵的比赛记为「未进行」，不能再开赛。
 * 空位消失（来源被重开、更正）时撤回这次直接决出，比赛恢复为待进行。幂等。
 */
async function settleVacancy(transaction: Tx, tournamentId: string, actorUserId: string | null, fixtureId: string, wasDecided: boolean) {
  const fixture = await transaction.fixture.findUniqueOrThrow({
    where: { id: fixtureId },
    select: {
      id: true,
      code: true,
      kind: true,
      sideAEntryId: true,
      sideBEntryId: true,
      sideAVacant: true,
      sideBVacant: true,
      vacancyDecided: true,
      winnerEntryId: true,
      competition: { select: { code: true } },
    },
  });
  if (fixture.kind === "GROUP") return;
  const bothVacant = fixture.sideAVacant && fixture.sideBVacant;
  const walkoverEntry = fixture.sideAVacant && !fixture.sideBVacant ? fixture.sideBEntryId : fixture.sideBVacant && !fixture.sideAVacant ? fixture.sideAEntryId : null;
  const shouldDecide = bothVacant || walkoverEntry !== null;
  const winner = bothVacant ? null : walkoverEntry;
  // 调用方（setFixtureSide）已在同一条更新里撤回了旧的直接决出；这里只在需要时重新决出并通知下游。
  if (!shouldDecide && !wasDecided) return;

  if (shouldDecide) {
    const now = new Date();
    await transaction.fixture.update({ where: { id: fixture.id }, data: { winnerEntryId: winner, decidedAt: now, vacancyDecided: true } });
    await transaction.match.updateMany({ where: { fixtureId: fixture.id, notPlayedAt: null }, data: { notPlayedAt: now } });
  }
  await propagateFixtureResult(transaction, tournamentId, actorUserId, fixture, winner, shouldDecide);
  await audit(transaction, tournamentId, actorUserId, shouldDecide ? "FIXTURE_DECIDED_BY_VACANCY" : "FIXTURE_VACANCY_WITHDRAWN", "Fixture", fixture.id, {
    competitionCode: fixture.competition.code,
    fixtureCode: fixture.code,
    winnerEntryId: winner,
    bothVacant,
  });
}

async function isEntryWithdrawn(transaction: Tx, entryId: string) {
  const entry = await transaction.entry.findUnique({
    where: { id: entryId },
    select: { withdrawnAt: true, members: { where: { participant: { withdrawnAt: { not: null } } }, select: { participantId: true }, take: 1 } },
  });
  return Boolean(entry?.withdrawnAt || entry?.members.length);
}

/** 把一场对抗的胜者/负者写入以它为来源的后续对阵。 */
export async function propagateFixtureResult(
  transaction: Tx,
  tournamentId: string,
  actorUserId: string | null,
  fixture: { id: string; code: string; sideAEntryId: string | null; sideBEntryId: string | null },
  winnerEntryId: string | null,
  /** 本对阵已经决出（含无胜者）；此时下游拿不到人的一侧记为空位，而不是「待定」。 */
  decided = winnerEntryId !== null,
) {
  let loserEntryId = winnerEntryId ? (winnerEntryId === fixture.sideAEntryId ? fixture.sideBEntryId : fixture.sideAEntryId) : null;
  // 已退出或被取消资格的负方不再进入三四名赛：该侧记为空位，对手产生后以 WO 晋级（W-2、W-4、W-7）。
  if (loserEntryId && (await isEntryWithdrawn(transaction, loserEntryId))) loserEntryId = null;
  const downstream = await transaction.fixture.findMany({
    where: { OR: [{ sideAFixtureId: fixture.id }, { sideBFixtureId: fixture.id }] },
    select: { id: true, sideAFixtureId: true, sideASource: true, sideBFixtureId: true, sideBSource: true },
  });
  for (const next of downstream) {
    for (const side of SIDES) {
      const sourceFixture = side === "A" ? next.sideAFixtureId : next.sideBFixtureId;
      const source = side === "A" ? next.sideASource : next.sideBSource;
      if (sourceFixture !== fixture.id) continue;
      const value = source === "FIXTURE_WINNER" ? winnerEntryId : source === "FIXTURE_LOSER" ? loserEntryId : null;
      await setFixtureSide(transaction, tournamentId, actorUserId, next.id, side, value, `对抗 ${fixture.code} 的结果`, decided && value === null);
    }
  }
}

/**
 * 按事实重新推导一场团体对抗：未进行的小场、对抗胜负、后续对阵；小组名次已确认而本组结果被重开时撤回确认。
 * 幂等：重复调用不产生变化。后续比赛已开始时拒绝（整个命令事务回滚）。
 */
export async function settleTeamFixture(transaction: Tx, fixtureId: string, actorUserId: string | null) {
  await lockFixtureRow(transaction, fixtureId);
  const fixture = await loadTieFixture(transaction, { id: fixtureId });
  if (!fixture || fixture.competition.entryType !== "TEAM") return null;
  const tournamentId = fixture.competition.tournamentId;
  const summary = summarizeTie(fixture);
  const now = new Date();

  const conceded = tieConcessions(fixture);
  const notPlayed = new Set([...summary.notPlayedOrders, ...[...conceded.keys()].filter((order) => {
    const match = fixture.matches.find((item) => item.rubberOrder === order);
    return match && !isStarted(match) && match.verificationStatus !== "LOCKED";
  })]);
  for (const match of fixture.matches) {
    const shouldSkip = notPlayed.has(match.rubberOrder as number);
    if (shouldSkip && !match.notPlayedAt) {
      await transaction.match.update({ where: { id: match.id }, data: { notPlayedAt: now } });
    } else if (!shouldSkip && match.notPlayedAt) {
      await transaction.match.update({ where: { id: match.id }, data: { notPlayedAt: null } });
    }
  }

  const winnerEntryId = summary.winner ? sideEntryId(fixture, summary.winner) : null;
  if (winnerEntryId !== fixture.winnerEntryId) {
    await transaction.fixture.update({
      where: { id: fixture.id },
      data: { winnerEntryId, decidedAt: winnerEntryId ? now : null },
    });
    await propagateFixtureResult(transaction, tournamentId, actorUserId, fixture, winnerEntryId);
    await audit(transaction, tournamentId, actorUserId, winnerEntryId ? "TIE_DECIDED" : "TIE_UNDECIDED", "Fixture", fixture.id, {
      competitionCode: fixture.competition.code,
      fixtureCode: fixture.code,
      winnerEntryId,
      previousWinnerEntryId: fixture.winnerEntryId,
      rubbers: summary.rubbers,
      notPlayed: summary.notPlayedOrders,
    });
  }

  if (fixture.groupId && !summary.complete && (await lockGroupRankingState(transaction, fixture.groupId))) {
    await revokeGroupRankingInternal(transaction, tournamentId, actorUserId, fixture.groupId, `对抗 ${fixture.code} 的小场结果被重开`);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 小组积分榜与名次确认
// ---------------------------------------------------------------------------

export async function loadGroupStandings(client: Client, groupId: string) {
  const group = await client.group.findUniqueOrThrow({
    where: { id: groupId },
    select: {
      id: true,
      code: true,
      name: true,
      ranking: true,
      rankingConfirmedAt: true,
      rankingConfirmedBy: { select: { name: true } },
      stage: { select: { competition: { select: { entryType: true } } } },
      fixtures: { orderBy: [{ round: "asc" }, { sequence: "asc" }], select: fixtureSelect },
    },
  });
  const entryIds: string[] = [];
  for (const fixture of group.fixtures) {
    for (const id of [fixture.sideAEntryId, fixture.sideBEntryId]) if (id && !entryIds.includes(id)) entryIds.push(id);
  }
  // GCR 16.3.7（赛务口径 R-4 / W-7）：整体退出、打不完全部小组对抗的队伍，全部小组成绩删除。
  const withdrawnEntryIds = group.fixtures
    .flatMap((fixture) => [fixture.sideAEntry, fixture.sideBEntry])
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry?.withdrawnAt))
    .map((entry) => entry.id)
    .filter((id, index, list) => list.indexOf(id) === index);
  const ranked = entryIds.filter((id) => !withdrawnEntryIds.includes(id));
  const counted = group.fixtures.filter((fixture) => ranked.includes(fixture.sideAEntryId ?? "") && ranked.includes(fixture.sideBEntryId ?? ""));
  const ties: StandingTie[] = counted.map((fixture) => {
    const summary = summarizeTie(fixture);
    return {
      sideA: fixture.sideAEntryId as string,
      sideB: fixture.sideBEntryId as string,
      complete: summary.complete,
      winner: summary.winner,
      rubbers: summary.rubbers,
      games: summary.games,
      points: summary.points,
    };
  });
  const entries = await client.entry.findMany({ where: { id: { in: entryIds } }, select: { id: true, code: true, displayName: true } });
  const standings: GroupStandings = computeStandings(
    [...ranked].sort((left, right) => {
      const a = entries.find((entry) => entry.id === left)?.code ?? "";
      const b = entries.find((entry) => entry.id === right)?.code ?? "";
      return a.localeCompare(b);
    }),
    ties,
  );
  return { group, standings, entries, withdrawnEntryIds };
}

const confirmSchema = z.object({
  order: z.array(z.string().uuid()).max(16).nullish(),
  reason: z.string().max(400).nullish(),
});

/**
 * 裁判长确认小组名次，并把「某组第几名」回填进淘汰签位。
 * 有名次须抽签决定时，必须给出抽签后的完整顺序并写明抽签情况。
 */
export async function confirmGroupRanking(actorUserId: string, slug: string, competitionCode: string, groupCode: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["CHIEF_REFEREE"]);
  const parsed = confirmSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "确认请求格式无效。");

  return runTransaction(
    async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const group = await transaction.group.findFirst({
        where: {
          code: groupCode.toUpperCase(),
          stage: { competition: { tournamentId: tournament.id, code: competitionCode.toUpperCase() }, draw: { status: "PUBLISHED" } },
        },
        select: { id: true, code: true, rankingConfirmedAt: true, stage: { select: { competition: { select: { code: true, entryType: true } } } } },
      });
      if (!group) throw new AppError(404, "group_not_found", "小组不存在或所属抽签未发布。");
      if (group.stage.competition.entryType !== "TEAM") {
        throw new AppError(400, "not_team_competition", "本阶段只支持团体项目的小组名次确认。");
      }
      if (group.rankingConfirmedAt) throw new AppError(409, "ranking_confirmed", "本组名次已经确认。");
      await transaction.$queryRaw`SELECT "id" FROM "competition_groups" WHERE "id" = ${group.id}::uuid FOR UPDATE`;
      const { standings } = await loadGroupStandings(transaction, group.id);
      const { order, error } = applyConfirmedOrder(standings, parsed.data.order);
      if (!order) throw new AppError(409, "ranking_not_confirmable", `${error}。`);
      const reason = parsed.data.reason ? normalizeReason(parsed.data.reason) : null;
      if (standings.unresolved.length && !reason) {
        throw new AppError(400, "reason_required", "有名次须抽签决定，请写明抽签的时间、方式与见证人。");
      }
      const now = new Date();
      await transaction.group.update({
        where: { id: group.id },
        data: {
          ranking: asJson({ order, lots: standings.unresolved, reason }),
          rankingConfirmedAt: now,
          rankingConfirmedByUserId: actorUserId,
        },
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
          // 出线名额多于本组有效名次（有单位成绩被删除）：该签位记为空位，对手以 WO 晋级（K-1）。
          await setFixtureSide(transaction, tournament.id, actorUserId, fixture.id, side, order[rank - 1] ?? null, `${group.code} 组名次`, order[rank - 1] === undefined);
        }
      }
      await audit(transaction, tournament.id, actorUserId, "GROUP_RANKING_CONFIRMED", "Group", group.id, {
        competitionCode: group.stage.competition.code,
        groupCode: group.code,
        order,
        lots: standings.unresolved,
        reason,
      });
      return { order, filled: targets.length };
    },
    { timeout: 20_000 },
  );
}

export async function revokeGroupRankingInternal(transaction: Tx, tournamentId: string, actorUserId: string | null, groupId: string, cause: string) {
  const group = await transaction.group.findUniqueOrThrow({ where: { id: groupId }, select: { code: true, ranking: true } });
  const targets = await transaction.fixture.findMany({
    where: { OR: [{ sideAGroupId: groupId }, { sideBGroupId: groupId }] },
    select: { id: true, sideAGroupId: true, sideBGroupId: true },
  });
  for (const fixture of targets) {
    for (const side of SIDES) {
      const sourceGroup = side === "A" ? fixture.sideAGroupId : fixture.sideBGroupId;
      if (sourceGroup === groupId) await setFixtureSide(transaction, tournamentId, actorUserId, fixture.id, side, null, `${group.code} 组名次`);
    }
  }
  await transaction.group.update({
    where: { id: groupId },
    data: { ranking: Prisma.DbNull, rankingConfirmedAt: null, rankingConfirmedByUserId: null },
  });
  await audit(transaction, tournamentId, actorUserId, "GROUP_RANKING_REVOKED", "Group", groupId, {
    groupCode: group.code,
    previous: group.ranking,
    cause,
  });
}

// ---------------------------------------------------------------------------
// 视图：负责人与后台共用，按查看者裁剪（盲交期间不泄露对方名单）
// ---------------------------------------------------------------------------

export type TieViewer = { kind: "TEAM_MANAGER"; side: MatchSide } | { kind: "OFFICIAL" };

function sourceLabel(fixture: TieFixtureRow, side: MatchSide) {
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

export interface TieScheduleOptions {
  lineupDeadlineMinutes: number;
}

export function projectTie(fixture: TieFixtureRow, viewer: TieViewer, schedule?: TieScheduleOptions) {
  const summary = summarizeTie(fixture);
  const starts = fixture.matches.filter((match) => !match.notPlayedAt && match.scheduledAt).map((match) => (match.scheduledAt as Date).getTime());
  const firstStart = starts.length ? new Date(Math.min(...starts)) : null;
  const deadline = firstStart && schedule ? new Date(firstStart.getTime() - schedule.lineupDeadlineMinutes * 60_000) : null;
  const revealed = Boolean(fixture.lineupsRevealedAt);
  const canSee = (side: MatchSide) => revealed || (viewer.kind === "TEAM_MANAGER" && viewer.side === side);
  const sides = SIDES.map((side) => {
    const entry = side === "A" ? fixture.sideAEntry : fixture.sideBEntry;
    const lineup = fixture.lineups.find((item) => item.side === side) ?? null;
    return {
      side,
      entry: entry ? { id: entry.id, code: entry.code, name: entry.displayName } : null,
      pending: entry ? null : sourceLabel(fixture, side),
      lineup: lineup
        ? { version: lineup.version, source: lineup.source, submittedAt: lineup.submittedAt.toISOString(), late: lineup.submittedLate, conceded: canSee(side) ? lineup.concededOrders : [] }
        : null,
      visible: canSee(side),
    };
  });
  const concessions = tieConcessions(fixture);
  const rubbers = fixture.matches.map((match) => {
    const result = rubberResultOf(match, concessions);
    return {
      matchCode: match.code,
      order: match.rubberOrder as number,
      kind: match.rubberKind as RubberKind,
      label: RUBBER_LABEL[match.rubberKind as RubberKind],
      lifecycleStatus: match.lifecycleStatus,
      verificationStatus: match.verificationStatus,
      outcomeType: match.outcomeType,
      notPlayed: Boolean(match.notPlayedAt),
      scheduledAt: match.scheduledAt?.toISOString() ?? null,
      scheduleEstimated: match.scheduleEstimated,
      court: match.court?.name ?? null,
      started: result.started,
      final: result.final,
      winner: result.winner,
      games: result.games,
      /** 认输的一方（W-6 名单认输、W-3 队员退赛后的后续小场）；双方都认输时为 "BOTH"。 */
      conceded: (() => {
        const concession = concessions.get(match.rubberOrder ?? 0);
        if (!concession) return null;
        return concession.A && concession.B ? ("BOTH" as const) : concession.A ? ("A" as const) : concession.B ? ("B" as const) : null;
      })(),
      players: Object.fromEntries(
        SIDES.map((side) => [
          side,
          canSee(side)
            ? match.players
                .filter((player) => player.side === side)
                .map((player) => ({ participantId: player.participantId, name: player.participant.displayName, code: player.participant.publicCode }))
            : null,
        ]),
      ) as Record<MatchSide, { participantId: string; name: string; code: string }[] | null>,
    };
  });
  return {
    id: fixture.id,
    code: fixture.code,
    kind: fixture.kind,
    label: fixture.label,
    round: fixture.round,
    groupCode: fixture.group?.code ?? null,
    competition: { code: fixture.competition.code, name: fixture.competition.name },
    revealedAt: fixture.lineupsRevealedAt?.toISOString() ?? null,
    winnerEntryId: fixture.winnerEntryId,
    schedule: {
      firstStart: firstStart?.toISOString() ?? null,
      lineupDeadline: deadline?.toISOString() ?? null,
      courts: [...new Set(fixture.matches.filter((match) => !match.notPlayedAt).map((match) => match.court?.name).filter((name): name is string => Boolean(name)))],
    },
    limits: limitsOf(fixture),
    summary,
    sides,
    rubbers,
  };
}

export type TieView = ReturnType<typeof projectTie>;

/** 后台：某团体项目已发布抽签的全部对抗（名单内容按盲交规则裁剪）。 */
export async function loadCompetitionTies(client: Client, competitionId: string) {
  const fixtures = await client.fixture.findMany({
    where: { competitionId, draw: { status: "PUBLISHED" } },
    orderBy: [{ stage: { order: "asc" } }, { round: "asc" }, { sequence: "asc" }],
    select: fixtureSelect,
  });
  return fixtures;
}

export async function loadTieByCode(client: Client, competitionId: string, fixtureCode: string) {
  return loadTieFixture(client, { competitionId, code: fixtureCode.toUpperCase(), draw: { status: "PUBLISHED" } });
}

/** 负责人：本人负责的队伍在某赛事中已确定出场的全部团体对抗。 */
export async function loadManagerTies(userId: string, slug: string) {
  const access = await requireTeamManagerAccess(userId, slug);
  const teamIds = access.teams.map((team) => team.id);
  const fixtures = await prisma.fixture.findMany({
    where: {
      competition: { tournamentId: access.tournament.id, entryType: "TEAM" },
      draw: { status: "PUBLISHED" },
      OR: [{ sideAEntry: { teamId: { in: teamIds } } }, { sideBEntry: { teamId: { in: teamIds } } }],
    },
    orderBy: [{ competition: { code: "asc" } }, { stage: { order: "asc" } }, { round: "asc" }, { sequence: "asc" }],
    select: fixtureSelect,
  });
  return {
    access,
    ties: fixtures.map((fixture) => {
      const side: MatchSide = fixture.sideAEntry?.teamId && teamIds.includes(fixture.sideAEntry.teamId) ? "A" : "B";
      return { side, fixture };
    }),
  };
}

export async function loadRosterForLineup(entryId: string) {
  return loadRoster(prisma, entryId);
}

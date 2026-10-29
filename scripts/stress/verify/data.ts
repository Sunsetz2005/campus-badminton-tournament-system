/**
 * 判定阶段的只读数据装载：一个赛事的全部比赛、事件、快照、对阵、小组、名单与上场队员。
 * 只读会话（readonly-env.ts）保证这里不可能写库。
 */
import { prisma } from "../core/db";

export async function loadTournamentData(slug: string) {
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true, slug: true, refereeMode: true } });
  const competitions = await prisma.competition.findMany({
    where: { tournamentId: tournament.id },
    select: { id: true, code: true, kind: true, entryType: true, teamRubbers: true },
  });
  const matches = await prisma.match.findMany({
    where: { stage: { competition: { tournamentId: tournament.id } } },
    select: {
      id: true,
      code: true,
      stageId: true,
      groupId: true,
      fixtureId: true,
      courtId: true,
      sideAEntryId: true,
      sideBEntryId: true,
      rubberKind: true,
      rubberOrder: true,
      notPlayedAt: true,
      lifecycleStatus: true,
      outcomeType: true,
      verificationStatus: true,
      resultSource: true,
      scheduledAt: true,
      scheduledEndAt: true,
      startedAt: true,
      endedAt: true,
      version: true,
      stage: { select: { type: true, competitionId: true } },
      games: { select: { number: true, scoreA: true, scoreB: true, completed: true }, orderBy: { number: "asc" } },
      snapshot: { select: { version: true, engineVersion: true, initialState: true, initialStateHash: true, state: true, stateHash: true } },
      ruleSnapshot: { select: { config: true } },
      players: { select: { participantId: true, entryId: true, side: true } },
      sideAEntry: { select: { competitionId: true, members: { select: { participantId: true } } } },
      sideBEntry: { select: { competitionId: true, members: { select: { participantId: true } } } },
    },
  });
  const matchIds = matches.map((match) => match.id);
  const events = await prisma.matchEvent.findMany({
    where: { matchId: { in: matchIds } },
    select: {
      id: true,
      matchId: true,
      version: true,
      commandId: true,
      domainEventId: true,
      commandFingerprint: true,
      type: true,
      payload: true,
      stateBefore: true,
      stateAfter: true,
      stateBeforeHash: true,
      stateAfterHash: true,
      metadata: true,
      occurredAt: true,
      engineVersion: true,
      actorUserId: true,
      scoringSessionId: true,
    },
    orderBy: [{ matchId: "asc" }, { version: "asc" }],
  });
  const fixtures = await prisma.fixture.findMany({
    where: { competition: { tournamentId: tournament.id } },
    select: {
      id: true,
      code: true,
      kind: true,
      round: true,
      sequence: true,
      competitionId: true,
      groupId: true,
      stageId: true,
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
      winnerEntryId: true,
      decidedAt: true,
      lineupsRevealedAt: true,
    },
  });
  const groups = await prisma.group.findMany({
    where: { stage: { competition: { tournamentId: tournament.id } } },
    select: { id: true, code: true, ranking: true, rankingConfirmedAt: true, stage: { select: { competitionId: true } } },
  });
  const draws = await prisma.draw.findMany({
    where: { competition: { tournamentId: tournament.id }, status: "PUBLISHED" },
    select: { competitionId: true, settings: true },
  });
  const entries = await prisma.entry.findMany({
    where: { competition: { tournamentId: tournament.id } },
    select: { id: true, competitionId: true, withdrawnAt: true, members: { select: { participantId: true } } },
  });
  const participants = await prisma.participant.findMany({ where: { tournamentId: tournament.id }, select: { id: true } });
  const revisions = await prisma.resultRevision.findMany({
    where: { matchId: { in: matchIds } },
    select: { matchId: true, revision: true, status: true, actorUserId: true, submittedRole: true, reviewedByUserId: true, createdAt: true },
    orderBy: [{ matchId: "asc" }, { revision: "asc" }],
  });
  const exclusions = await prisma.rankingExclusion.findMany({ where: { group: { stage: { competition: { tournamentId: tournament.id } } } } });
  return { tournament, competitions, matches, events, fixtures, groups, draws, entries, participants, exclusions, revisions };
}

export type TournamentData = Awaited<ReturnType<typeof loadTournamentData>>;
export type MatchRow = TournamentData["matches"][number];
export type EventRow = TournamentData["events"][number];

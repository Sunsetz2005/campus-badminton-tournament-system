/**
 * 只读查询。仿真进程的数据库会话是 `default_transaction_read_only=on`（见 readonly-env.ts），这里任何写入都会被数据库拒绝。
 *
 * 用途分两类，报告里分开说明：
 * 1. 「页面同源数据」：管理页、我的执裁、团体对抗页能看到、但没有对应 GET 接口的编号（项目、报名、签表、对阵、参赛者），
 *    仿真按页面会显示的范围读取，相当于操作员在页面上看到后再点按钮；
 * 2. 判定：事件、快照、签位等内部表，只在判定阶段读取。
 */
import { prisma } from "../../../src/db/client";

export { prisma };

export async function tournamentIdOf(slug: string) {
  return (await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } })).id;
}

export async function competitionsOf(tournamentId: string) {
  return prisma.competition.findMany({ where: { tournamentId }, select: { id: true, code: true, kind: true, entryType: true } });
}

export async function pendingRegistrations(tournamentId: string, competitionId?: string) {
  return prisma.registration.findMany({
    where: { tournamentId, status: "PENDING", ...(competitionId ? { competitionId } : {}) },
    select: { id: true, version: true, competitionId: true, referenceCode: true, teamId: true },
    orderBy: { createdAt: "asc" },
  });
}

/** 报名单位（Entry）与其成员学号，用来把计划中的报名单位对应到系统编号。 */
export async function entriesOf(competitionId: string) {
  return prisma.entry.findMany({
    where: { competitionId },
    select: {
      id: true,
      code: true,
      displayName: true,
      teamId: true,
      members: { select: { slot: true, participant: { select: { id: true, studentId: true } } } },
    },
  });
}

export async function participantsOf(tournamentId: string) {
  return prisma.participant.findMany({ where: { tournamentId }, select: { id: true, studentId: true, publicCode: true, displayName: true } });
}

/** 团体对抗：签位、名单状态、各小场。 */
export async function fixturesOf(competitionId: string) {
  return prisma.fixture.findMany({
    where: { competitionId },
    select: {
      id: true,
      code: true,
      kind: true,
      round: true,
      label: true,
      sideAEntryId: true,
      sideBEntryId: true,
      lineupsRevealedAt: true,
      winnerEntryId: true,
      decidedAt: true,
      groupId: true,
      lineups: { select: { side: true, version: true, entryId: true } },
      matches: { select: { code: true, rubberOrder: true, rubberKind: true, scheduledAt: true, lifecycleStatus: true, notPlayedAt: true }, orderBy: { rubberOrder: "asc" } },
    },
    orderBy: [{ round: "asc" }, { sequence: "asc" }],
  });
}

export async function groupsOf(competitionId: string) {
  return prisma.group.findMany({
    where: { stage: { competitionId } },
    select: {
      id: true,
      code: true,
      rankingConfirmedAt: true,
      stage: { select: { type: true } },
      matches: { select: { code: true, lifecycleStatus: true, verificationStatus: true, notPlayedAt: true } },
      fixtures: { select: { id: true, decidedAt: true, matches: { select: { verificationStatus: true, notPlayedAt: true, lifecycleStatus: true } } } },
    },
    orderBy: { code: "asc" },
  });
}

export async function matchesOfTournament(tournamentId: string) {
  return prisma.match.findMany({
    where: { stage: { competition: { tournamentId } } },
    select: {
      id: true,
      code: true,
      lifecycleStatus: true,
      verificationStatus: true,
      notPlayedAt: true,
      sideAEntryId: true,
      sideBEntryId: true,
      scheduledAt: true,
      scheduledEndAt: true,
      startedAt: true,
      endedAt: true,
      courtId: true,
      fixtureId: true,
      groupId: true,
      stage: { select: { type: true, competition: { select: { code: true } } } },
    },
  });
}

/** 成员的学号（个人项目报名单位成员 + 团体小场上场队员），用于调度器判断「选手是否正在别场比赛」。 */
export async function playersOfMatches(codes: string[]) {
  const rows = await prisma.match.findMany({
    where: { code: { in: codes } },
    select: {
      code: true,
      players: { select: { participantId: true } },
      sideAEntry: { select: { members: { select: { participantId: true } } } },
      sideBEntry: { select: { members: { select: { participantId: true } } } },
      rubberKind: true,
    },
  });
  return new Map(
    rows.map((row) => [
      row.code,
      row.rubberKind
        ? row.players.map((item) => item.participantId)
        : [...(row.sideAEntry?.members ?? []), ...(row.sideBEntry?.members ?? [])].map((item) => item.participantId),
    ]),
  );
}

export async function courtsOf(tournamentId: string) {
  return prisma.court.findMany({ where: { tournamentId, active: true }, select: { id: true, code: true, name: true }, orderBy: { sortOrder: "asc" } });
}

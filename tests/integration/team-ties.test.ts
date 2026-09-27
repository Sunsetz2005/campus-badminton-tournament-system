import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand } from "@/domain/rules/match-engine";
import { eligibleForRubber } from "@/domain/team/lineup";
import type { RubberKind } from "@/domain/registration/team-roster";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { getAuthoritativeMatchState } from "@/server/services/match-state-service";
import { reviewRegistration } from "@/server/services/registration-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { acquireScoringSession, releaseScoringSession, takeoverScoringSession } from "@/server/services/scoring-session-service";
import { createTeam, provisionTeamManager, submitTeamRoster } from "@/server/services/team-service";
import {
  amendLineup,
  confirmGroupRanking,
  loadCompetitionTies,
  loadGroupStandings,
  loadManagerTies,
  loadRosterForLineup,
  projectTie,
  submitLineup,
} from "@/server/services/team-tie-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

const RUN = randomBytes(3).toString("hex");
const createdSlugs: string[] = [];
const createdEmails: string[] = [];
let adminId = "";
let refereeId = "";
let studentSeq = 0;
let commandSeq = 0;

function nextStudentId() {
  studentSeq += 1;
  return `D${RUN.toUpperCase()}${String(studentSeq).padStart(4, "0")}`;
}

/** 合规团体名单：默认 3 男 3 女，男队员报男单/男双/混双，女队员报女单/女双/混双。 */
function roster(male = 3, female = 3) {
  return [
    ...Array.from({ length: male }, (_, index) => ({
      displayName: `男${studentSeq}-${index}`,
      studentId: nextStudentId(),
      gender: "MALE",
      rubberKinds: ["MS", "MD", "XD"],
    })),
    ...Array.from({ length: female }, (_, index) => ({
      displayName: `女${studentSeq}-${index}`,
      studentId: nextStudentId(),
      gender: "FEMALE",
      rubberKinds: ["WS", "WD", "XD"],
    })),
  ];
}

async function newTournament(name: string) {
  const slug = `t4d-${RUN}-${name}`;
  createdSlugs.push(slug);
  await createTournament(adminId, {
    slug,
    name: `阳光联赛对抗测试 ${name}`,
    startDate: "2026-11-01",
    endDate: "2026-11-03",
    timezone: "Asia/Shanghai",
    namePolicy: "CODES_ONLY",
    rulePreset: "traditional-21",
    competitions: [{ kind: "TEAM", code: "TEAM", name: "学院团体赛" }],
  });
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const competition = await prisma.competition.findFirstOrThrow({ where: { tournamentId: tournament.id }, select: { id: true } });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
  return { slug, tournamentId: tournament.id, competitionId: competition.id };
}

async function approvedTeams(slug: string, competitionId: string, count: number) {
  const teams: { id: string; name: string }[] = [];
  for (let index = 0; index < count; index += 1) {
    const team = await createTeam(adminId, slug, { name: `学院${index + 1}` });
    const submitted = await submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, team.id, { competitionId, members: roster() });
    const current = await prisma.registration.findUniqueOrThrow({ where: { id: submitted.registrationId }, select: { version: true } });
    await reviewRegistration(adminId, slug, submitted.registrationId, { action: "APPROVE", expectedVersion: current.version });
    teams.push({ id: team.id, name: `学院${index + 1}` });
  }
  return teams;
}

/** 建赛、报名、抽签、发布，并给本赛事配好裁判员与裁判长。 */
async function publishedTournament(name: string, teamCount: number, settings: Record<string, unknown>) {
  const created = await newTournament(name);
  const teams = await approvedTeams(created.slug, created.competitionId, teamCount);
  const draft = await generateDrawDraft(adminId, created.slug, "TEAM", settings);
  await transitionTournamentPhase(adminId, created.slug, { to: "REGISTRATION_CLOSED" });
  await publishDraw(adminId, created.slug, "TEAM", draft.drawId, { confirm: true });
  await prisma.roleAssignment.createMany({
    data: [
      { userId: refereeId, tournamentId: created.tournamentId, role: "REFEREE" },
      { userId: adminId, tournamentId: created.tournamentId, role: "CHIEF_REFEREE" },
    ],
  });
  return { ...created, teams, drawId: draft.drawId };
}

async function fixtureByCode(competitionId: string, code: string) {
  return prisma.fixture.findFirstOrThrow({
    where: { competitionId, code },
    include: { matches: { orderBy: { rubberOrder: "asc" } } },
  });
}

/** 按报项自动挑人：每个小场取名单中最先报了该项的队员。 */
async function autoLineup(entryId: string, fixtureId: string) {
  const members = await loadRosterForLineup(entryId);
  const matches = await prisma.match.findMany({ where: { fixtureId }, orderBy: { rubberOrder: "asc" }, select: { rubberOrder: true, rubberKind: true } });
  return matches.map((match) => {
    const kind = match.rubberKind as RubberKind;
    const pool = eligibleForRubber(kind, members);
    const picked =
      kind === "XD"
        ? [pool.find((item) => item.gender === "MALE"), pool.find((item) => item.gender === "FEMALE")]
        : pool.slice(0, kind === "MS" || kind === "WS" ? 1 : 2);
    return { order: match.rubberOrder as number, participantIds: picked.map((item) => item?.participantId as string) };
  });
}

async function adminLineups(slug: string, fixtureId: string) {
  const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
  for (const side of ["A", "B"] as const) {
    const entryId = (side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId) as string;
    await submitLineup({ userId: adminId, mode: "ADMIN" }, slug, fixtureId, { side, rubbers: await autoLineup(entryId, fixtureId) });
  }
}

function command(
  control: { sessionId: string; takeoverGeneration: number },
  expectedVersion: number,
  type: MatchCommand["type"],
  payload: MatchCommand["payload"],
): ScoringCommandEnvelope {
  commandSeq += 1;
  return {
    commandId: randomUUID(),
    occurredAt: new Date(Date.UTC(2026, 10, 1, 8, 0, commandSeq)).toISOString(),
    expectedVersion,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type,
    payload,
  } as ScoringCommandEnvelope;
}

async function accepted(promise: Promise<unknown>) {
  const result = (await promise) as { status: string; version: number };
  if (result.status !== "accepted") throw new Error(`命令未被接受：${result.status}`);
  return result;
}

/** 以弃权结果走完一个小场：主裁判记录并提交，裁判长接管后复核锁定。 */
async function finishRubber(matchId: string, winnerSide: "A" | "B") {
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId }, select: { code: true } });
  await prisma.officialAssignment.upsert({
    where: { matchId_userId_role: { matchId, userId: refereeId, role: "MAIN_REFEREE" } },
    create: { matchId, userId: refereeId },
    update: {},
  });
  const control = await acquireScoringSession(refereeId, match.code, randomUUID());
  let result = await accepted(
    submitScoringCommand(refereeId, match.code, command(control, 0, "RECORD_SPECIAL_OUTCOME", { type: "WO", winnerSide, reason: "对方未到" }), control.controlToken),
  );
  result = await accepted(submitScoringCommand(refereeId, match.code, command(control, result.version, "SUBMIT_RESULT", { reason: "提交弃权结果" }), control.controlToken));
  const chief = await takeoverScoringSession(adminId, match.code, randomUUID(), "复核结果");
  result = await accepted(submitScoringCommand(adminId, match.code, command(chief, result.version, "CONFIRM_RESULT", { reason: "复核通过" }), chief.controlToken));
  return { code: match.code, chief, version: result.version };
}

async function reopenRubber(code: string, chief: { sessionId: string; takeoverGeneration: number; controlToken: string }, version: number) {
  return submitScoringCommand(adminId, code, command(chief, version, "REOPEN_RESULT", { reason: "核对记录后重开" }), chief.controlToken);
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
});

afterAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  for (const slug of createdSlugs) {
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) continue;
    const matchWhere = { stage: { competition: { tournamentId: tournament.id } } };
    await prisma.matchEvent.deleteMany({ where: { match: matchWhere } });
    await prisma.resultRevision.deleteMany({ where: { match: matchWhere } });
    await prisma.match.deleteMany({ where: matchWhere });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  }
});

describe("团体名单报项", () => {
  it("负责人提交名单须给每名队员报项；审核通过后报项随报名单位固化；数据库兜底性别与报项", async () => {
    const { slug, competitionId } = await newTournament("roster");
    const team = await createTeam(adminId, slug, { name: "数学学院" });
    const members = roster();
    members[0] = { ...members[0], rubberKinds: [] };
    await expect(
      submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, team.id, { competitionId, members }),
    ).rejects.toMatchObject({ code: "invalid_members", message: expect.stringContaining("报项至少选 1 项") });
    members[0] = { ...members[0], rubberKinds: ["WS"] };
    await expect(
      submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, team.id, { competitionId, members }),
    ).rejects.toMatchObject({ message: expect.stringContaining("与性别「男」不符") });
    members[0] = { ...members[0], rubberKinds: ["MS"] };
    const submitted = await submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, team.id, { competitionId, members });
    const stored = await prisma.registrationMember.findFirstOrThrow({ where: { registrationId: submitted.registrationId, slot: 1 } });
    expect(stored.rubberKinds).toEqual(["MS"]);
    // 数据库兜底：女队员不能报男单。
    const female = await prisma.registrationMember.findFirstOrThrow({ where: { registrationId: submitted.registrationId, gender: "FEMALE" } });
    await expect(prisma.registrationMember.update({ where: { id: female.id }, data: { rubberKinds: ["MS"] } })).rejects.toThrow();

    await reviewRegistration(adminId, slug, submitted.registrationId, { action: "APPROVE", expectedVersion: 0 });
    const entryMembers = await prisma.entryMember.findMany({ where: { competitionId }, orderBy: { slot: "asc" } });
    expect(entryMembers.map((item) => item.rubberKinds)).toEqual(members.map((item) => item.rubberKinds));
    // 数据库兜底：报名单位的报项必须仍能排满每种小场（去掉全部混双报项后提交失败）。
    await expect(
      prisma.$transaction(entryMembers.map((item) => prisma.entryMember.update({ where: { id: item.id }, data: { rubberKinds: item.rubberKinds.filter((kind) => kind !== "XD") } }))),
    ).rejects.toThrow(/rubber XD/);
  });
});

describe("出场名单盲交", () => {
  it("负责人只能交本队一侧；交齐前对方与后台都看不到内容；交齐后同时公开并锁定", async () => {
    const { slug, tournamentId, competitionId, teams } = await publishedTournament("lineup", 4, { format: "ROUND_ROBIN" });
    const managers: string[] = [];
    for (const [index, team] of teams.entries()) {
      const email = `mgr-${RUN}-lineup-${index}@example.invalid`;
      createdEmails.push(email);
      await provisionTeamManager(adminId, slug, team.id, { email, name: `负责人${index + 1}` });
      const user = await prisma.user.update({ where: { email }, data: { mustChangePassword: false }, select: { id: true } });
      managers.push(user.id);
    }
    const teamIndexOf = async (entryId: string | null) => {
      const entry = await prisma.entry.findUniqueOrThrow({ where: { id: entryId as string }, select: { teamId: true } });
      return teams.findIndex((team) => team.id === entry.teamId);
    };
    const fixture = await prisma.fixture.findFirstOrThrow({ where: { competitionId }, orderBy: [{ round: "asc" }, { sequence: "asc" }] });
    const managerA = managers[await teamIndexOf(fixture.sideAEntryId)];
    const managerB = managers[await teamIndexOf(fixture.sideBEntryId)];
    const outsider = managers.find((id) => id !== managerA && id !== managerB) as string;

    const lineupA = await autoLineup(fixture.sideAEntryId as string, fixture.id);
    // 未报该项的队员不能上场：把女单换成一名男队员。
    const wrong = lineupA.map((item) => (item.order === 2 ? { ...item, participantIds: lineupA[0].participantIds } : item));
    await expect(submitLineup({ userId: managerA, mode: "TEAM_MANAGER" }, slug, fixture.id, { rubbers: wrong })).rejects.toMatchObject({
      code: "invalid_lineup",
      message: expect.stringContaining("第 2 场女单"),
    });
    await expect(submitLineup({ userId: outsider, mode: "TEAM_MANAGER" }, slug, fixture.id, { rubbers: lineupA })).rejects.toMatchObject({
      code: "not_fixture_team",
    });
    // 负责人不能冒充对方：即使传了 side 也按绑定判定本方。
    const first = await submitLineup({ userId: managerA, mode: "TEAM_MANAGER" }, slug, fixture.id, { side: "B", rubbers: lineupA });
    expect(first).toEqual({ side: "A", version: 1, revealed: false, late: false });
    await expect(submitLineup({ userId: managerA, mode: "TEAM_MANAGER" }, slug, fixture.id, { rubbers: lineupA })).rejects.toMatchObject({
      code: "version_conflict",
    });
    await expect(
      submitLineup({ userId: managerA, mode: "TEAM_MANAGER" }, slug, fixture.id, { expectedVersion: 1, rubbers: lineupA }),
    ).resolves.toEqual({ side: "A", version: 2, revealed: false, late: false });

    const [row] = (await loadCompetitionTies(prisma, competitionId)).filter((item) => item.id === fixture.id);
    const forB = projectTie(row, { kind: "TEAM_MANAGER", side: "B" });
    const forA = projectTie(row, { kind: "TEAM_MANAGER", side: "A" });
    const forOfficial = projectTie(row, { kind: "OFFICIAL" });
    expect(forB.rubbers.every((rubber) => rubber.players.A === null)).toBe(true);
    expect(forA.rubbers[0].players.A).toHaveLength(1);
    expect(forOfficial.rubbers.every((rubber) => rubber.players.A === null && rubber.players.B === null)).toBe(true);
    expect(forOfficial.sides[0].lineup).toMatchObject({ version: 2, source: "TEAM_MANAGER" });
    expect(JSON.stringify(forB)).not.toContain(lineupA[0].participantIds[0]);

    // 小场在名单交齐前不能计分。
    const rubber = await prisma.match.findFirstOrThrow({ where: { fixtureId: fixture.id, rubberOrder: 1 } });
    await prisma.officialAssignment.create({ data: { matchId: rubber.id, userId: refereeId } });
    await expect(getAuthoritativeMatchState(refereeId, rubber.code)).rejects.toMatchObject({ code: "match_not_ready" });

    const lineupB = await autoLineup(fixture.sideBEntryId as string, fixture.id);
    await expect(submitLineup({ userId: managerB, mode: "TEAM_MANAGER" }, slug, fixture.id, { rubbers: lineupB })).resolves.toEqual({
      side: "B",
      version: 1,
      revealed: true,
      late: false,
    });
    await expect(
      submitLineup({ userId: managerA, mode: "TEAM_MANAGER" }, slug, fixture.id, { expectedVersion: 2, rubbers: lineupA }),
    ).rejects.toMatchObject({ code: "lineup_locked" });
    const revealed = projectTie((await loadCompetitionTies(prisma, competitionId)).find((item) => item.id === fixture.id)!, { kind: "OFFICIAL" });
    expect(revealed.rubbers[2].players.A).toHaveLength(2);
    expect(revealed.rubbers[2].players.B).toHaveLength(2);

    // 公开后：小场的计分状态使用出场名单上的队员。
    const state = await getAuthoritativeMatchState(refereeId, rubber.code);
    if (state.status !== "snapshot") throw new Error("首次读取应返回快照");
    expect(state.state.players).toEqual({ A: lineupA[0].participantIds, B: lineupB[0].participantIds });
    expect(Object.keys(state.match.playerNames)).toHaveLength(2);
    expect(state.match.rubber).toEqual({ kind: "MS", order: 1 });

    // 负责人视图只包含本人队伍的对抗。
    const { ties } = await loadManagerTies(managerA, slug);
    expect(ties.every((item) => [item.fixture.sideAEntry?.teamId, item.fixture.sideBEntry?.teamId].includes(teams[managers.indexOf(managerA)].id))).toBe(true);
    expect(ties).toHaveLength(3);

    // 公开后只有裁判长能改尚未开始的小场，且必须写原因。
    const substitute = (await loadRosterForLineup(fixture.sideAEntryId as string)).filter((item) => item.gender === "MALE")[1];
    await expect(
      amendLineup(adminId, slug, fixture.id, { side: "A", order: 1, participantIds: [substitute.participantId], reason: "" }),
    ).rejects.toMatchObject({ code: "reason_required" });
    await expect(
      amendLineup(refereeId, slug, fixture.id, { side: "A", order: 1, participantIds: [substitute.participantId], reason: "伤病换人" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      amendLineup(adminId, slug, fixture.id, { side: "A", order: 1, participantIds: [substitute.participantId], reason: "赛前热身扭伤，换人" }),
    ).resolves.toEqual({ matchCode: rubber.code });
    const after = await getAuthoritativeMatchState(refereeId, rubber.code);
    if (after.status !== "snapshot") throw new Error("改名单后应返回快照");
    expect(after.state.players.A).toEqual([substitute.participantId]);
    await expect(prisma.auditLog.count({ where: { tournamentId, action: "LINEUP_AMENDED" } })).resolves.toBe(1);

    // 小场开始后名单不能再改（服务与数据库两层）。
    const control = await acquireScoringSession(refereeId, rubber.code, randomUUID());
    await accepted(
      submitScoringCommand(refereeId, rubber.code, command(control, 0, "RECORD_COIN_TOSS", { valid: false, reason: "硬币落地不清" }), control.controlToken),
    );
    await expect(
      amendLineup(adminId, slug, fixture.id, { side: "A", order: 1, participantIds: [lineupA[0].participantIds[0]], reason: "再换回来" }),
    ).rejects.toMatchObject({ code: "rubber_started" });
    await expect(prisma.matchPlayer.deleteMany({ where: { matchId: rubber.id } })).rejects.toThrow(/started rubber/);
    // 数据库兜底：上场队员必须报了该项。
    const secondRubber = await prisma.match.findFirstOrThrow({ where: { fixtureId: fixture.id, rubberOrder: 2 } });
    const male = (await loadRosterForLineup(fixture.sideAEntryId as string)).find((item) => item.gender === "MALE")!;
    await expect(
      prisma.$transaction([
        prisma.matchPlayer.deleteMany({ where: { matchId: secondRubber.id, side: "A" } }),
        prisma.matchPlayer.create({
          data: { matchId: secondRubber.id, side: "A", slot: 1, entryId: fixture.sideAEntryId as string, participantId: male.participantId },
        }),
      ]),
    ).rejects.toThrow(/did not enter rubber event WS/);
  });
});

describe("对抗胜负与晋级回填", () => {
  it("小组赛：3:0 后胜负已定但仍打满，五场锁定后对抗结束", async () => {
    const { slug, competitionId } = await publishedTournament("group-play-all", 3, { format: "ROUND_ROBIN" });
    const fixture = await prisma.fixture.findFirstOrThrow({ where: { competitionId }, include: { matches: { orderBy: { rubberOrder: "asc" } } } });
    await adminLineups(slug, fixture.id);
    for (const match of fixture.matches.slice(0, 3)) await finishRubber(match.id, "A");
    const decided = await prisma.fixture.findUniqueOrThrow({ where: { id: fixture.id }, include: { matches: true } });
    expect(decided.winnerEntryId).toBe(fixture.sideAEntryId);
    expect(decided.matches.every((match) => match.notPlayedAt === null)).toBe(true);
    let view = projectTie((await loadCompetitionTies(prisma, competitionId)).find((item) => item.id === fixture.id)!, { kind: "OFFICIAL" });
    expect(view.summary).toMatchObject({ status: "DECIDED", rubbers: { A: 3, B: 0 }, policy: "PLAY_ALL" });
    await finishRubber(fixture.matches[3].id, "B");
    await finishRubber(fixture.matches[4].id, "B");
    view = projectTie((await loadCompetitionTies(prisma, competitionId)).find((item) => item.id === fixture.id)!, { kind: "OFFICIAL" });
    expect(view.summary).toMatchObject({ status: "COMPLETE", rubbers: { A: 3, B: 2 }, winner: "A" });
  });

  it("淘汰赛：决出即止，未开始的小场记为未进行并拒绝计分；胜负者回填决赛与三四名赛；重开撤回，后续开赛后拒绝重开", async () => {
    const { slug, competitionId, tournamentId } = await publishedTournament("knockout", 4, { format: "KNOCKOUT", thirdPlaceMatch: true });
    const semi = await fixtureByCode(competitionId, "SF1");
    const other = await fixtureByCode(competitionId, "SF2");
    await adminLineups(slug, semi.id);
    await adminLineups(slug, other.id);
    const results = [];
    for (const match of semi.matches.slice(0, 3)) results.push(await finishRubber(match.id, "B"));

    const decided = await fixtureByCode(competitionId, "SF1");
    expect(decided.winnerEntryId).toBe(semi.sideBEntryId);
    expect(decided.matches.map((match) => Boolean(match.notPlayedAt))).toEqual([false, false, false, true, true]);
    await prisma.officialAssignment.create({ data: { matchId: semi.matches[4].id, userId: refereeId } });
    await expect(getAuthoritativeMatchState(refereeId, semi.matches[4].code)).rejects.toMatchObject({ code: "rubber_not_played" });
    let final = await fixtureByCode(competitionId, "F");
    let bronze = await fixtureByCode(competitionId, "3P");
    expect(final.sideAEntryId).toBe(semi.sideBEntryId);
    expect(final.matches.every((match) => match.sideAEntryId === semi.sideBEntryId && match.sideBEntryId === null)).toBe(true);
    expect(bronze.sideAEntryId).toBe(semi.sideAEntryId);

    // 重开决胜小场：胜负撤回、未进行的小场恢复、决赛与三四名赛的这一侧清空。
    const decisive = results[2];
    await accepted(reopenRubber(decisive.code, decisive.chief, decisive.version));
    const reopened = await fixtureByCode(competitionId, "SF1");
    expect(reopened.winnerEntryId).toBeNull();
    expect(reopened.matches.every((match) => match.notPlayedAt === null)).toBe(true);
    final = await fixtureByCode(competitionId, "F");
    expect(final.sideAEntryId).toBeNull();
    expect(final.matches.every((match) => match.sideAEntryId === null)).toBe(true);
    await expect(prisma.auditLog.count({ where: { tournamentId, action: "TIE_UNDECIDED" } })).resolves.toBe(1);

    // 重新提交并复核锁定后再次回填。
    await releaseScoringSession(adminId, decisive.code, decisive.chief.sessionId, decisive.chief.takeoverGeneration, decisive.chief.controlToken);
    const control = await acquireScoringSession(refereeId, decisive.code, randomUUID());
    const state = await getAuthoritativeMatchState(refereeId, decisive.code);
    let result = await accepted(submitScoringCommand(refereeId, decisive.code, command(control, state.version, "SUBMIT_RESULT", { reason: "核对后重新提交" }), control.controlToken));
    const chief = await takeoverScoringSession(adminId, decisive.code, randomUUID(), "复核");
    result = await accepted(submitScoringCommand(adminId, decisive.code, command(chief, result.version, "CONFIRM_RESULT", { reason: "复核通过" }), chief.controlToken));
    final = await fixtureByCode(competitionId, "F");
    expect(final.sideAEntryId).toBe(semi.sideBEntryId);

    // 另一场半决赛也决出后，决赛双方确定，可以交名单并开赛。
    for (const match of other.matches.slice(0, 3)) await finishRubber(match.id, "A");
    final = await fixtureByCode(competitionId, "F");
    bronze = await fixtureByCode(competitionId, "3P");
    expect(final.sideBEntryId).toBe(other.sideAEntryId);
    expect(bronze.sideBEntryId).toBe(other.sideBEntryId);
    await adminLineups(slug, final.id);
    await prisma.officialAssignment.create({ data: { matchId: final.matches[0].id, userId: refereeId } });
    const finalControl = await acquireScoringSession(refereeId, final.matches[0].code, randomUUID());
    await accepted(
      submitScoringCommand(refereeId, final.matches[0].code, command(finalControl, 0, "RECORD_COIN_TOSS", { valid: false, reason: "重抛" }), finalControl.controlToken),
    );

    // 决赛已开始：再重开半决赛的小场会改变决赛一方，拒绝且整个命令回滚。
    await expect(reopenRubber(decisive.code, chief, result.version)).rejects.toMatchObject({ code: "downstream_started" });
    await expect(prisma.match.findUniqueOrThrow({ where: { code: decisive.code } })).resolves.toMatchObject({ verificationStatus: "LOCKED" });
  });

  it("小组积分榜：全部结束后裁判长确认名次并回填淘汰签位；须抽签时必须给出顺序与说明；重开本组小场撤回确认", async () => {
    const { slug, competitionId, tournamentId } = await publishedTournament("standings", 6, {
      format: "GROUPS_KNOCKOUT",
      groupCount: 2,
      qualifiersPerGroup: 2,
      thirdPlaceMatch: false,
    });
    const groups = await prisma.group.findMany({ where: { stage: { competitionId } }, orderBy: { code: "asc" } });
    expect(groups.map((group) => group.code)).toEqual(["A", "B"]);
    const lastResults: Awaited<ReturnType<typeof finishRubber>>[] = [];

    // A 组：按报名编号构造循环相克（甲胜乙、乙胜丙、丙胜甲），每场都是 3:2 → 各项相同，须抽签。
    // B 组：编号小的一方取胜（第一场 5:0，其余 3:2），名次可由成绩直接确定。
    for (const group of groups) {
      const fixtures = await prisma.fixture.findMany({
        where: { groupId: group.id },
        orderBy: [{ round: "asc" }, { sequence: "asc" }],
        include: { matches: { orderBy: { rubberOrder: "asc" } }, sideAEntry: { select: { code: true } }, sideBEntry: { select: { code: true } } },
      });
      const codes = [...new Set(fixtures.flatMap((fixture) => [fixture.sideAEntry?.code as string, fixture.sideBEntry?.code as string]))].sort();
      const beats = (winner: string, loser: string) => (codes.indexOf(winner) + 1) % 3 === codes.indexOf(loser);
      for (const [index, fixture] of fixtures.entries()) {
        await adminLineups(slug, fixture.id);
        const [codeA, codeB] = [fixture.sideAEntry?.code as string, fixture.sideBEntry?.code as string];
        const winner: "A" | "B" =
          group.code === "A" ? (beats(codeA, codeB) ? "A" : "B") : codes.indexOf(codeA) < codes.indexOf(codeB) ? "A" : "B";
        const loser = winner === "A" ? "B" : "A";
        const pattern: ("A" | "B")[] = group.code === "B" && index === 0 ? [winner, winner, winner, winner, winner] : [winner, winner, winner, loser, loser];
        for (const [order, match] of fixture.matches.entries()) lastResults.push(await finishRubber(match.id, pattern[order]));
      }
    }

    const groupA = await loadGroupStandings(prisma, groups[0].id);
    expect(groupA.standings.complete).toBe(true);
    expect(groupA.standings.rows.map((row) => row.won)).toEqual([1, 1, 1]);
    expect(groupA.standings.unresolved).toHaveLength(1);
    await expect(confirmGroupRanking(adminId, slug, "TEAM", "A", {})).rejects.toMatchObject({ code: "ranking_not_confirmable" });
    const order = [...groupA.standings.unresolved[0]].reverse();
    await expect(confirmGroupRanking(adminId, slug, "TEAM", "A", { order })).rejects.toMatchObject({ code: "reason_required" });
    await expect(
      confirmGroupRanking(adminId, slug, "TEAM", "A", { order, reason: "三队各项相同，由裁判长当场抽签，双方领队见证" }),
    ).resolves.toMatchObject({ order });
    const groupB = await loadGroupStandings(prisma, groups[1].id);
    expect(groupB.standings.unresolved).toEqual([]);
    expect(groupB.standings.rows.map((row) => row.won)).toEqual([2, 1, 0]);
    await expect(confirmGroupRanking(refereeId, slug, "TEAM", "B", {})).rejects.toMatchObject({ status: 403 });
    const confirmedB = await confirmGroupRanking(adminId, slug, "TEAM", "B", {});
    await expect(confirmGroupRanking(adminId, slug, "TEAM", "B", {})).rejects.toMatchObject({ code: "ranking_confirmed" });

    const rankA = ((await prisma.group.findUniqueOrThrow({ where: { id: groups[0].id } })).ranking as { order: string[] }).order;
    const semis = await prisma.fixture.findMany({ where: { competitionId, kind: "KNOCKOUT", round: 1 }, include: { matches: true } });
    for (const fixture of semis) {
      for (const side of ["A", "B"] as const) {
        const groupId = side === "A" ? fixture.sideAGroupId : fixture.sideBGroupId;
        const rank = (side === "A" ? fixture.sideARank : fixture.sideBRank) as number;
        const expected = groupId === groups[0].id ? rankA[rank - 1] : confirmedB.order[rank - 1];
        expect(side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId).toBe(expected);
        expect(fixture.matches.every((match) => (side === "A" ? match.sideAEntryId : match.sideBEntryId) === expected)).toBe(true);
      }
    }

    // 淘汰签位已按名次回填后，重开 B 组的一个小场：确认撤回、签位清空（后续比赛尚未开始）。
    const last = lastResults[lastResults.length - 1];
    await accepted(reopenRubber(last.code, last.chief, last.version));
    await expect(prisma.group.findUniqueOrThrow({ where: { id: groups[1].id } })).resolves.toMatchObject({ rankingConfirmedAt: null, ranking: null });
    const cleared = await prisma.fixture.findMany({ where: { competitionId, kind: "KNOCKOUT", round: 1 } });
    for (const fixture of cleared) {
      if (fixture.sideAGroupId === groups[1].id) expect(fixture.sideAEntryId).toBeNull();
      if (fixture.sideBGroupId === groups[1].id) expect(fixture.sideBEntryId).toBeNull();
    }
    await expect(prisma.auditLog.count({ where: { tournamentId, action: "GROUP_RANKING_REVOKED" } })).resolves.toBe(1);
  });
});

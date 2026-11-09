import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand } from "@/domain/rules/match-engine";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { releaseSuspendedMatchCourt, transferSuspendedMatch } from "@/server/services/schedule-service";
import { acquireScoringSession, takeoverScoringSession } from "@/server/services/scoring-session-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

/**
 * 赛务口径决定（2026-10-27）的比赛日规则：见 `docs/knowledge-base/03-竞赛规则/赛务口径决定-2026-10-27.md`。
 */

const RUN = `rr${randomBytes(3).toString("hex")}`;
const createdSlugs: string[] = [];
let adminId = "";
let refereeId = "";
let commandSeq = 0;

async function roundRobin(name: string, entryCount: number) {
  const slug = `md-${RUN}-${name}`;
  createdSlugs.push(slug);
  await createTournament(adminId, {
    slug,
    name: `比赛日规则 ${name}`,
    startDate: "2026-11-01",
    endDate: "2026-11-03",
    timezone: "Asia/Shanghai",
    namePolicy: "CODES_ONLY",
    rulePreset: "traditional-21",
    competitions: [{ kind: "MS", code: "MS", name: "男子单打" }],
  });
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const competition = await prisma.competition.findFirstOrThrow({ where: { tournamentId: tournament.id }, select: { id: true } });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
  for (let index = 0; index < entryCount; index += 1) {
    const created = await createManualRegistration(adminId, slug, {
      competitionId: competition.id,
      members: [{ displayName: `选手${index + 1}`, teamName: `学院${index + 1}` }],
    });
    const registration = await prisma.registration.findUniqueOrThrow({ where: { referenceCode: created.referenceCode }, select: { id: true, version: true } });
    await reviewRegistration(adminId, slug, registration.id, { action: "APPROVE", expectedVersion: registration.version });
  }
  const draft = await generateDrawDraft(adminId, slug, "MS", { format: "ROUND_ROBIN" });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
  await publishDraw(adminId, slug, "MS", draft.drawId, { confirm: true });
  await prisma.roleAssignment.createMany({
    skipDuplicates: true,
    data: [
      { userId: refereeId, tournamentId: tournament.id, role: "REFEREE" },
      { userId: adminId, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
    ],
  });
  const matches = await prisma.match.findMany({
    where: { stage: { competition: { tournamentId: tournament.id } } },
    select: { id: true, code: true, sideAEntryId: true, sideBEntryId: true },
    orderBy: { code: "asc" },
  });
  for (const match of matches) {
    await prisma.officialAssignment.upsert({
      where: { matchId_userId_role: { matchId: match.id, userId: refereeId, role: "MAIN_REFEREE" } },
      create: { matchId: match.id, userId: refereeId },
      update: {},
    });
  }
  return { slug, tournamentId: tournament.id, matches };
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
    occurredAt: new Date(Date.UTC(2026, 10, 2, 8, 0, commandSeq)).toISOString(),
    expectedVersion,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type,
    payload,
  } as ScoringCommandEnvelope;
}

/** 抛币后确认开局设置：这一步让比赛进入「进行中」。 */
async function startMatch(matchCode: string, deviceId = randomUUID()) {
  return (await startMatchWithControl(matchCode, deviceId)).result;
}

async function startMatchWithControl(matchCode: string, deviceId = randomUUID()) {
  const control = await acquireScoringSession(refereeId, matchCode, deviceId);
  const toss = await submitScoringCommand(
    refereeId,
    matchCode,
    command(control, 0, "RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: "A",
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    }),
    control.controlToken,
  );
  if (toss.status !== "accepted") throw new Error("抛币不应命中幂等分支。");
  const state = toss.state as { players: { A: string[]; B: string[] } };
  const result = await submitScoringCommand(
    refereeId,
    matchCode,
    command(control, toss.version, "CONFIRM_OPENING_SETUP", {
      serverPlayerId: state.players.A[0],
      receiverPlayerId: state.players.B[0],
      logicalCourts: null,
    } as MatchCommand["payload"]),
    control.controlToken,
  );
  return { control, result };
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
});

afterAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  for (const slug of createdSlugs) {
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) continue;
    const matchWhere = { stage: { competition: { tournamentId: tournament.id } } };
    await prisma.matchEvent.deleteMany({ where: { match: matchWhere } });
    await prisma.resultRevision.deleteMany({ where: { match: matchWhere } });
    await prisma.scoringSession.deleteMany({ where: { match: matchWhere } });
    await prisma.match.deleteMany({ where: matchWhere });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  }
});


/*
 * ===== 独立复判探针 RV-S8-D（2026-11-09，非产品测试）=====
 * 转场（schedule-service，默认读已提交 + 赛事行锁）与开局（scoring-command-service，可串行化，不锁赛事行）并发进入同一块场地。
 * 只读断言：同一块场地上不应同时出现「进行中」与「暂停中」两场。
 */
describe("复判 RV-S8-D 转场与开局并发进入同一块场地", () => {
  it("顺序对照：先开局后转场被拒（court_busy）；先转场后开局被拒（court_occupied）", async () => {
    for (const order of ["start-first", "transfer-first"] as const) {
      const { slug, tournamentId, matches } = await roundRobin(`seq-${order}`, 4);
      const [c1, c2] = await Promise.all(["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })));
      const [m, ...rest] = matches;
      const n = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === m.sideAEntryId || id === m.sideBEntryId))!;
      await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
      await prisma.match.update({ where: { id: n.id }, data: { courtId: c2.id } });
      const { control, result } = await startMatchWithControl(m.code);
      if (result.status !== "accepted") throw new Error("x");
      await submitScoringCommand(refereeId, m.code, command(control, result.version, "PAUSE_MATCH", { reason: "探针" }), control.controlToken);
      if (order === "start-first") {
        await startMatch(n.code);
        await expect(transferSuspendedMatch(adminId, slug, m.code, { courtCode: "C2", reason: "探针" })).rejects.toMatchObject({ code: "court_busy" });
      } else {
        await transferSuspendedMatch(adminId, slug, m.code, { courtCode: "C2", reason: "探针" });
        await expect(startMatch(n.code)).rejects.toMatchObject({ code: "court_occupied" });
      }
    }
  });

  it("20 轮并发：统计同一场地出现两场占用的轮数", async () => {
    let doubled = 0;
    const outcomes: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const { slug, tournamentId, matches } = await roundRobin(`tr-${round}`, 4);
      const [c1, c2] = await Promise.all(["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })));
      const [m, ...rest] = matches;
      const n = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === m.sideAEntryId || id === m.sideBEntryId))!;
      await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
      await prisma.match.update({ where: { id: n.id }, data: { courtId: c2.id } });
      const { control, result } = await startMatchWithControl(m.code);
      if (result.status !== "accepted") throw new Error("x");
      await submitScoringCommand(refereeId, m.code, command(control, result.version, "PAUSE_MATCH", { reason: "探针" }), control.controlToken);
      const cn = await acquireScoringSession(refereeId, n.code, randomUUID());
      const toss = await submitScoringCommand(refereeId, n.code, command(cn, 0, "RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } } as MatchCommand["payload"]), cn.controlToken);
      if (toss.status !== "accepted") throw new Error("x");
      const players = (toss.state as { players: { A: string[]; B: string[] } }).players;
      const settled = await Promise.allSettled([
        transferSuspendedMatch(adminId, slug, m.code, { courtCode: "C2", reason: "探针并发" }),
        submitScoringCommand(refereeId, n.code, command(cn, toss.version, "CONFIRM_OPENING_SETUP", { serverPlayerId: players.A[0], receiverPlayerId: players.B[0], logicalCourts: null } as MatchCommand["payload"]), cn.controlToken),
      ]);
      outcomes.push(settled.map((s) => (s.status === "fulfilled" ? "ok" : (s.reason as { code?: string }).code ?? "err")).join("/"));
      const onC2 = await prisma.match.count({ where: { courtId: c2.id, lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] } } });
      if (onC2 > 1) doubled += 1;
    }
    console.log("RV-S8-D outcomes", JSON.stringify(outcomes), "doubled", doubled);
    expect(doubled).toBe(0);
  });
});

// 夹具逐字复制带来的未用导入，保留以便与原文件对照。
void releaseSuspendedMatchCourt;
void takeoverScoringSession;

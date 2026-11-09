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

const RUN = `rv${randomBytes(3).toString("hex")}`;
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
 * ===== 独立复判探针（2026-11-09，非产品测试）=====
 * 上方夹具逐字复制自 tests/integration/match-day-rules.test.ts（仅改 RUN 前缀），下方用例只读断言、不改产品代码。
 * 运行：pnpm exec dotenv -e .env.test -- pnpm exec vitest run --config tests/review/vitest.review.config.ts
 */

function tossPayload() {
  return { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } } as MatchCommand["payload"];
}

async function sql(flag: string | null, statement: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>) {
  return prisma.$transaction(async (tx) => {
    if (flag) await tx.$executeRawUnsafe(`SELECT set_config('${flag}', 'on', true)`);
    return statement(tx);
  });
}

describe("复判 RV-S9-A 触发器例外的边界", () => {
  it("例外只放行：暂停中 + 计划时间不变 + （转场声明且新场地非空 / 离场声明且新场地为空）", async () => {
    const { tournamentId, matches } = await roundRobin("trig", 4);
    const [c1, c2] = await Promise.all(["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })));
    const [m] = matches;
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id, scheduledAt: new Date("2026-11-20T01:00:00Z"), scheduledEndAt: new Date("2026-11-20T01:30:00Z") } });
    const { control, result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("x");
    const setCourt = (courtId: string | null) => (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => tx.match.update({ where: { id: m.id }, data: { courtId } });

    // 进行中：两种声明都不放行。
    await expect(sql("badminton.court_release", setCourt(null))).rejects.toThrow(/cannot change/);
    await expect(sql("badminton.court_transfer", setCourt(c2.id))).rejects.toThrow(/cannot change/);

    const paused = await submitScoringCommand(refereeId, m.code, command(control, result.version, "PAUSE_MATCH", { reason: "探针" }), control.controlToken);
    if (paused.status !== "accepted") throw new Error("x");
    // 暂停中：声明与方向不符时拒绝。
    await expect(sql("badminton.court_release", setCourt(c2.id))).rejects.toThrow(/cannot change/);
    await expect(sql("badminton.court_transfer", setCourt(null))).rejects.toThrow(/cannot change/);
    await expect(sql(null, setCourt(c2.id))).rejects.toThrow(/cannot change/);
    // 暂停中 + 正确声明，但同时改计划时间：拒绝。
    await expect(sql("badminton.court_release", (tx) => tx.match.update({ where: { id: m.id }, data: { courtId: null, scheduledAt: new Date("2026-11-20T02:00:00Z") } }))).rejects.toThrow(/cannot change/);
    await expect(sql("badminton.court_transfer", (tx) => tx.match.update({ where: { id: m.id }, data: { courtId: c2.id, scheduledEndAt: new Date("2026-11-20T02:00:00Z") } }))).rejects.toThrow(/cannot change/);
    // 声明是事务级（is_local=true）：上一事务的声明不会泄漏到下一事务。
    await sql("badminton.court_release", async () => null);
    await expect(sql(null, setCourt(null))).rejects.toThrow(/cannot change/);
    // 正确组合放行（离场；CHECK 不要求同时写 awaitingCourtSince——记录观察）。
    await expect(sql("badminton.court_release", setCourt(null))).resolves.toBeTruthy();
    const row = await prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { courtId: true, awaitingCourtSince: true } });
    expect(row).toEqual({ courtId: null, awaitingCourtSince: null });
    await expect(sql("badminton.court_transfer", setCourt(c2.id))).resolves.toBeTruthy();
  });

  it("已抛币未开局（READY，version>0）：两种声明都不放行，场地被冻结", async () => {
    const { tournamentId, matches } = await roundRobin("trig-ready", 3);
    const [c1, c2] = await Promise.all(["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })));
    const [m] = matches;
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    const control = await acquireScoringSession(refereeId, m.code, randomUUID());
    await submitScoringCommand(refereeId, m.code, command(control, 0, "RECORD_COIN_TOSS", tossPayload()), control.controlToken);
    await expect(sql("badminton.court_transfer", (tx) => tx.match.update({ where: { id: m.id }, data: { courtId: c2.id } }))).rejects.toThrow(/cannot change/);
    await expect(sql("badminton.court_release", (tx) => tx.match.update({ where: { id: m.id }, data: { courtId: null } }))).rejects.toThrow(/cannot change/);
  });
});

describe("复判 RV-S9-B 离场待续后作废计分（S-7）", () => {
  it("观察：离场待续 → 裁判长作废 → 重新抛币开局，比赛在没有场地且仍标记待分配的状态下进行", async () => {
    const { slug, tournamentId, matches } = await roundRobin("void-released", 3);
    const c1 = await prisma.court.create({ data: { tournamentId, code: "C1", name: "场地 1", active: true, sortOrder: 0 } });
    const [m] = matches;
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    const { result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("x");
    const chief = await takeoverScoringSession(adminId, m.code, randomUUID(), "探针");
    const paused = await submitScoringCommand(adminId, m.code, command(chief, result.version, "PAUSE_MATCH", { reason: "伤停" }), chief.controlToken);
    if (paused.status !== "accepted") throw new Error("x");
    await releaseSuspendedMatchCourt(adminId, slug, m.code, { reason: "场地全满" });
    const voided = await submitScoringCommand(adminId, m.code, command(chief, paused.version, "VOID_MATCH_SCORING", { reason: "开错场次" }), chief.controlToken);
    if (voided.status !== "accepted") throw new Error("x");
    const afterVoid = await prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { courtId: true, awaitingCourtSince: true, lifecycleStatus: true, version: true } });
    // 记录：作废后 READY、无场地、仍带离场标记；version>0 → 场地被冻结，S-5 只接受 SUSPENDED，无法再分配场地。
    expect(afterVoid).toMatchObject({ courtId: null, lifecycleStatus: "READY", awaitingCourtSince: expect.any(Date) });
    await expect(transferSuspendedMatch(adminId, slug, m.code, { courtCode: "C1", reason: "分配场地" })).rejects.toMatchObject({ code: "match_not_suspended" });
    const toss = await submitScoringCommand(adminId, m.code, command(chief, voided.version, "RECORD_COIN_TOSS", tossPayload()), chief.controlToken);
    if (toss.status !== "accepted") throw new Error("x");
    const players = (toss.state as { players: { A: string[]; B: string[] } }).players;
    const opened = await submitScoringCommand(
      adminId,
      m.code,
      command(chief, toss.version, "CONFIRM_OPENING_SETUP", { serverPlayerId: players.A[0], receiverPlayerId: players.B[0], logicalCourts: null } as MatchCommand["payload"]),
      chief.controlToken,
    );
    expect(opened).toMatchObject({ status: "accepted" });
    await expect(prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { courtId: true, awaitingCourtSince: true, lifecycleStatus: true } })).resolves.toMatchObject({
      courtId: null,
      lifecycleStatus: "IN_PROGRESS",
      awaitingCourtSince: expect.any(Date),
    });
  });
});

describe("复判 RV-S8-C 同一场地并发开局", () => {
  it("两场同场地已抛币的比赛并发确认开局：恰好一场进入进行中", async () => {
    const { tournamentId, matches } = await roundRobin("race-open", 4);
    const c1 = await prisma.court.create({ data: { tournamentId, code: "C1", name: "场地 1", active: true, sortOrder: 0 } });
    const [a, ...rest] = matches;
    const b = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === a.sideAEntryId || id === a.sideBEntryId))!;
    await prisma.match.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { courtId: c1.id } });
    const prepared = [];
    for (const m of [a, b]) {
      const control = await acquireScoringSession(refereeId, m.code, randomUUID());
      const toss = await submitScoringCommand(refereeId, m.code, command(control, 0, "RECORD_COIN_TOSS", tossPayload()), control.controlToken);
      if (toss.status !== "accepted") throw new Error("x");
      prepared.push({ m, control, toss });
    }
    const results = await Promise.allSettled(
      prepared.map(({ m, control, toss }) => {
        const players = (toss.state as { players: { A: string[]; B: string[] } }).players;
        return submitScoringCommand(
          refereeId,
          m.code,
          command(control, toss.version, "CONFIRM_OPENING_SETUP", { serverPlayerId: players.A[0], receiverPlayerId: players.B[0], logicalCourts: null } as MatchCommand["payload"]),
          control.controlToken,
        );
      }),
    );
    const statuses = await prisma.match.findMany({ where: { id: { in: [a.id, b.id] } }, select: { lifecycleStatus: true } });
    console.log("RV-S8-C", JSON.stringify(results.map((r) => (r.status === "fulfilled" ? "accepted" : (r.reason as { code?: string }).code))), JSON.stringify(statuses));
    expect(statuses.filter((s) => s.lifecycleStatus === "IN_PROGRESS")).toHaveLength(1);
  });

  it("一场确认开局与同场地另一场抛币并发：不会出现「进行中 + 另一场已抛币被冻结在同一场地」", async () => {
    let both = 0;
    for (let round = 0; round < 5; round += 1) {
      const { tournamentId, matches } = await roundRobin(`race-toss-${round}`, 4);
      const c1 = await prisma.court.create({ data: { tournamentId, code: "C1", name: "场地 1", active: true, sortOrder: 0 } });
      const [a, ...rest] = matches;
      const b = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === a.sideAEntryId || id === a.sideBEntryId))!;
      await prisma.match.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { courtId: c1.id } });
      const ca = await acquireScoringSession(refereeId, a.code, randomUUID());
      const ta = await submitScoringCommand(refereeId, a.code, command(ca, 0, "RECORD_COIN_TOSS", tossPayload()), ca.controlToken);
      if (ta.status !== "accepted") throw new Error("x");
      const cb = await acquireScoringSession(refereeId, b.code, randomUUID());
      const players = (ta.state as { players: { A: string[]; B: string[] } }).players;
      await Promise.allSettled([
        submitScoringCommand(refereeId, a.code, command(ca, ta.version, "CONFIRM_OPENING_SETUP", { serverPlayerId: players.A[0], receiverPlayerId: players.B[0], logicalCourts: null } as MatchCommand["payload"]), ca.controlToken),
        submitScoringCommand(refereeId, b.code, command(cb, 0, "RECORD_COIN_TOSS", tossPayload()), cb.controlToken),
      ]);
      const rows = await prisma.match.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, lifecycleStatus: true, version: true } });
      const aRow = rows.find((r) => r.id === a.id)!;
      const bRow = rows.find((r) => r.id === b.id)!;
      if (aRow.lifecycleStatus === "IN_PROGRESS" && bRow.version > 0) both += 1;
    }
    console.log("RV-S8-C2 both-committed rounds", both);
    expect(both).toBe(0);
  });
});

// 夹具逐字复制带来的未用函数，保留以便与原文件对照。
void startMatch;

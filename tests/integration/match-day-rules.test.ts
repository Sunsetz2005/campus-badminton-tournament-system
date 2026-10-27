import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand } from "@/domain/rules/match-engine";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { transferSuspendedMatch } from "@/server/services/schedule-service";
import { acquireScoringSession } from "@/server/services/scoring-session-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

/**
 * 赛务口径决定（2026-10-27）的比赛日规则：见 `docs/knowledge-base/03-竞赛规则/赛务口径决定-2026-10-27.md`。
 */

const RUN = randomBytes(3).toString("hex");
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
async function startMatch(matchCode: string) {
  return (await startMatchWithControl(matchCode)).result;
}

async function startMatchWithControl(matchCode: string) {
  const control = await acquireScoringSession(refereeId, matchCode, randomUUID());
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

describe("S-4 选手正在别场比赛时不能开赛（P-08）", () => {
  it("同一选手的第二场在开局设置时被拒绝；不涉及该选手的比赛照常开始", async () => {
    const { matches } = await roundRobin("busy", 4);
    const [first, ...rest] = matches;
    const sharing = rest.find((match) => [match.sideAEntryId, match.sideBEntryId].some((id) => id === first.sideAEntryId || id === first.sideBEntryId))!;
    const disjoint = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === first.sideAEntryId || id === first.sideBEntryId))!;

    await expect(startMatch(first.code)).resolves.toMatchObject({ status: "accepted" });
    await expect(startMatch(sharing.code)).rejects.toMatchObject({ status: 409, code: "player_on_other_court", details: { busyMatchCode: first.code } });
    const blocked = await prisma.match.findUniqueOrThrow({ where: { id: sharing.id }, select: { lifecycleStatus: true, startedAt: true } });
    expect(blocked).toMatchObject({ lifecycleStatus: "READY", startedAt: null });
    await expect(startMatch(disjoint.code)).resolves.toMatchObject({ status: "accepted" });
  });
});

describe("S-5 暂停中的比赛转场（P-05）", () => {
  it("只有暂停中的比赛能转；只能转到启用且空着的场地；比分不变；绕过接口直接改场地仍被数据库拒绝", async () => {
    const { slug, tournamentId, matches } = await roundRobin("transfer", 3);
    const [c1, c2, c3] = await Promise.all(
      ["C1", "C2", "C3"].map((code, index) =>
        prisma.court.create({ data: { tournamentId, code, name: `场地 ${index + 1}`, active: code !== "C3", sortOrder: index } }),
      ),
    );
    await prisma.match.update({ where: { id: matches[0].id }, data: { courtId: c1.id } });
    const { control, result } = await startMatchWithControl(matches[0].code);
    if (result.status !== "accepted") throw new Error("开局不应命中幂等分支。");

    await expect(transferSuspendedMatch(adminId, slug, matches[0].code, { courtCode: "C2", reason: "场地漏水" })).rejects.toMatchObject({ code: "match_not_suspended" });
    const paused = await submitScoringCommand(refereeId, matches[0].code, command(control, result.version, "PAUSE_MATCH", { reason: "场地漏水" }), control.controlToken);
    if (paused.status !== "accepted") throw new Error("暂停不应命中幂等分支。");
    expect(paused.state).toMatchObject({ phase: "PAUSED" });

    await expect(transferSuspendedMatch(refereeId, slug, matches[0].code, { courtCode: "C2", reason: "场地漏水" })).rejects.toMatchObject({ status: 403 });
    await expect(transferSuspendedMatch(adminId, slug, matches[0].code, { courtCode: "C2", reason: "" })).rejects.toMatchObject({ code: "reason_required" });
    await expect(transferSuspendedMatch(adminId, slug, matches[0].code, { courtCode: "C3", reason: "场地漏水" })).rejects.toMatchObject({ code: "court_closed" });
    // 目标场地接下来已排定的比赛：不拒绝转场，但如实列出（会被顺延）；几小时后的比赛不列。
    const soon = Date.now() + 5 * 60_000;
    await prisma.match.update({ where: { id: matches[1].id }, data: { courtId: c2.id, scheduledAt: new Date(soon), scheduledEndAt: new Date(soon + 30 * 60_000) } });
    const later = Date.now() + 5 * 3_600_000;
    await prisma.match.update({ where: { id: matches[2].id }, data: { courtId: c2.id, scheduledAt: new Date(later), scheduledEndAt: new Date(later + 30 * 60_000) } });
    const transferred = await transferSuspendedMatch(adminId, slug, matches[0].code, { courtCode: "C2", reason: "场地漏水" });
    expect(transferred).toMatchObject({ toCourt: c2.name });
    expect(transferred.upcoming.map((item) => item.code)).toEqual([matches[1].code]);

    const moved = await prisma.match.findUniqueOrThrow({ where: { id: matches[0].id }, select: { courtId: true, version: true, lifecycleStatus: true } });
    expect(moved).toMatchObject({ courtId: c2.id, version: paused.version, lifecycleStatus: "SUSPENDED" });
    await expect(prisma.match.update({ where: { id: matches[0].id }, data: { courtId: c1.id } })).rejects.toThrow();
    await expect(prisma.auditLog.count({ where: { tournamentId, action: "MATCH_COURT_TRANSFERRED" } })).resolves.toBe(1);
    void c3;
  });
});

describe("S-7 开错比赛：作废本场计分", () => {
  it("第一局打完前裁判长可以作废，比赛回到抛币前、开始时刻清除、历史事件保留；主裁判不能作废；重放一致", async () => {
    const { takeoverScoringSession } = await import("@/server/services/scoring-session-service");
    const { getAuthoritativeMatchState } = await import("@/server/services/match-state-service");
    const { matches } = await roundRobin("void", 3);
    const { control, result } = await startMatchWithControl(matches[0].code);
    if (result.status !== "accepted") throw new Error("开局不应命中幂等分支。");
    const rally = await submitScoringCommand(refereeId, matches[0].code, command(control, result.version, "RALLY_WON", { side: "A" }), control.controlToken);
    if (rally.status !== "accepted") throw new Error("得分不应命中幂等分支。");
    expect((await prisma.match.findUniqueOrThrow({ where: { id: matches[0].id } })).startedAt).not.toBeNull();

    await expect(
      submitScoringCommand(refereeId, matches[0].code, command(control, rally.version, "VOID_MATCH_SCORING", { reason: "开错场次" }), control.controlToken),
    ).rejects.toMatchObject({ status: 403, code: "chief_referee_required" });
    const chief = await takeoverScoringSession(adminId, matches[0].code, randomUUID(), "作废错场计分");
    const voided = await submitScoringCommand(adminId, matches[0].code, command(chief, rally.version, "VOID_MATCH_SCORING", { reason: "开错场次，应为另一场" }), chief.controlToken);
    if (voided.status !== "accepted") throw new Error("作废不应命中幂等分支。");
    expect(voided.state).toMatchObject({ phase: "AWAITING_COIN_TOSS", score: { A: 0, B: 0 }, coinToss: null, version: rally.version + 1 });
    const row = await prisma.match.findUniqueOrThrow({ where: { id: matches[0].id }, select: { startedAt: true, lifecycleStatus: true } });
    expect(row).toMatchObject({ startedAt: null, lifecycleStatus: "READY" });
    await expect(prisma.matchEvent.count({ where: { matchId: matches[0].id } })).resolves.toBe(rally.version + 1);
    // 权威状态按全部事件重放后与作废后的状态一致。
    await expect(getAuthoritativeMatchState(adminId, matches[0].code)).resolves.toMatchObject({ state: { phase: "AWAITING_COIN_TOSS", version: rally.version + 1 } });
  });
});

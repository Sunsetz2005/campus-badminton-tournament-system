import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { AppError } from "@/server/services/errors";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { acquireScoringSession, heartbeatScoringSession, takeoverScoringSession } from "@/server/services/scoring-session-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

/**
 * 并发获取/接管控制会话：不同比赛上的可串行化事务互相冲突时（P2034/40001）应在服务端有界重试，
 * 不能把冲突漏成 500；同一设备重复获取仍是续用，另一设备仍得到 controller_exists。
 */
const RUN = randomBytes(3).toString("hex");
const slug = `t-sess-${RUN}`;
let adminId = "";
let refereeId = "";
let matches: { id: string; code: string }[] = [];

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
  await createTournament(adminId, {
    slug,
    name: "控制会话并发测试",
    startDate: "2026-11-02",
    endDate: "2026-11-03",
    timezone: "Asia/Shanghai",
    namePolicy: "CODES_ONLY",
    rulePreset: "traditional-21",
    competitions: [{ kind: "MS", code: "MS", name: "男子单打" }],
  });
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const competition = await prisma.competition.findFirstOrThrow({ where: { tournamentId: tournament.id }, select: { id: true } });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
  for (let index = 0; index < 7; index += 1) {
    const created = await createManualRegistration(adminId, slug, {
      competitionId: competition.id,
      members: [{ displayName: `并发选手${index + 1}`, studentId: `Q${RUN.toUpperCase()}${index}` }],
    });
    const current = await prisma.registration.findUniqueOrThrow({ where: { id: created.id }, select: { version: true } });
    await reviewRegistration(adminId, slug, created.id, { action: "APPROVE", expectedVersion: current.version });
  }
  const draft = await generateDrawDraft(adminId, slug, "MS", { format: "ROUND_ROBIN" });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
  await publishDraw(adminId, slug, "MS", draft.drawId, { confirm: true });
  await prisma.roleAssignment.createMany({
    data: [
      { userId: refereeId, tournamentId: tournament.id, role: "REFEREE" },
      { userId: adminId, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
    ],
  });
  matches = await prisma.match.findMany({ where: { stage: { competitionId: competition.id } }, select: { id: true, code: true }, orderBy: { code: "asc" } });
  await prisma.officialAssignment.createMany({ data: matches.map((match) => ({ matchId: match.id, userId: refereeId })) });
});

afterAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
  if (!tournament) return;
  const matchWhere = { stage: { competition: { tournamentId: tournament.id } } };
  await prisma.auditLog.deleteMany({ where: { tournamentId: tournament.id } });
  await prisma.scoringSession.deleteMany({ where: { match: matchWhere } });
  await prisma.match.deleteMany({ where: matchWhere });
  await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
  await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
  await prisma.tournament.delete({ where: { id: tournament.id } });
});

function leaked(results: PromiseSettledResult<unknown>[]) {
  // 可接受的失败只有明确的业务拒绝（AppError）；任何 Prisma 冲突或其他异常都算泄漏。
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .filter((result) => !(result.reason instanceof AppError))
    .map((result) => String((result.reason as { code?: string })?.code ?? result.reason));
}

describe("控制会话的并发获取与接管", () => {
  it("21 场比赛上同时获取与接管、并伴随心跳写入：全部成功，没有冲突泄漏，每场恰好一个活动会话", async () => {
    expect(matches).toHaveLength(21);
    const acquireTargets = matches.slice(0, 14);
    const takeoverTargets = matches.slice(14);
    const devices = new Map(acquireTargets.map((match) => [match.code, randomUUID()]));

    const firstWave = await Promise.allSettled([
      ...acquireTargets.map((match) => acquireScoringSession(refereeId, match.code, devices.get(match.code)!)),
      ...takeoverTargets.map((match) => takeoverScoringSession(adminId, match.code, randomUUID(), "并发接管测试")),
    ]);
    expect(leaked(firstWave)).toEqual([]);
    expect(firstWave.every((result) => result.status === "fulfilled")).toBe(true);

    const granted = firstWave.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireScoringSession>>>).value);
    // 第二波：同一设备重复获取（续用）、另一设备抢占（controller_exists）、已取得控制的设备心跳，全部同时进行。
    const secondWave = await Promise.allSettled([
      ...acquireTargets.map((match) => acquireScoringSession(refereeId, match.code, devices.get(match.code)!)),
      ...acquireTargets.map((match) => acquireScoringSession(refereeId, match.code, randomUUID())),
      ...acquireTargets.map((match, index) =>
        heartbeatScoringSession(refereeId, match.code, granted[index].sessionId, granted[index].takeoverGeneration, granted[index].controlToken),
      ),
    ]);
    expect(leaked(secondWave)).toEqual([]);
    const count = acquireTargets.length;
    const resumed = secondWave.slice(0, count);
    const intruders = secondWave.slice(count, count * 2);
    const heartbeats = secondWave.slice(count * 2);
    expect(resumed.every((result) => result.status === "fulfilled" && (result.value as { status: string }).status === "resumed")).toBe(true);
    expect(
      intruders.every((result) => result.status === "rejected" && (result.reason as AppError).code === "controller_exists"),
    ).toBe(true);
    expect(heartbeats.every((result) => result.status === "fulfilled")).toBe(true);

    const active = await prisma.scoringSession.groupBy({
      by: ["matchId"],
      where: { matchId: { in: matches.map((match) => match.id) }, status: "ACTIVE" },
      _count: { _all: true },
    });
    expect(active).toHaveLength(matches.length);
    expect(active.every((row) => row._count._all === 1)).toBe(true);
    // 续用不创建新会话、不推进控制代次。
    const generations = await prisma.match.findMany({ where: { id: { in: acquireTargets.map((match) => match.id) } }, select: { controlGeneration: true } });
    expect(generations.every((match) => match.controlGeneration === 1)).toBe(true);
  });
});

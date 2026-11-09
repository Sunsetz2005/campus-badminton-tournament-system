import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand } from "@/domain/rules/match-engine";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { getAuthoritativeMatchState } from "@/server/services/match-state-service";
import { loadOfficiatingTournament } from "@/server/services/officiating-service";
import { loadOfficiatingRecords } from "@/server/services/officiating-record";
import { generateReportExport } from "@/server/services/report-export-service";
import { loadScheduleWorkspace, releaseSuspendedMatchCourt, transferSuspendedMatch } from "@/server/services/schedule-service";
import { acquireScoringSession, takeoverScoringSession } from "@/server/services/scoring-session-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";
import { readXlsx, tableRows } from "../support/xlsx-reader";

/**
 * 赛务口径决定（2026-10-27）的比赛日规则：见 `docs/knowledge-base/03-竞赛规则/赛务口径决定-2026-10-27.md`。
 */

const RUN = randomBytes(3).toString("hex");
const createdSlugs: string[] = [];
const createdEmails: string[] = [];
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
  const control = await acquireScoringSession(refereeId, matchCode, deviceId, "演示裁判");
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
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
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

describe("S-8 一块场地同时只进行一场（2026-10-29 组织方决定）", () => {
  it("场地上有进行中或暂停中的比赛时，同场地另一场不能开始；暂停的比赛转场后可以开始", async () => {
    const { slug, tournamentId, matches } = await roundRobin("court", 4);
    const court = await prisma.court.create({ data: { tournamentId, code: "C1", name: "场地 1", active: true, sortOrder: 0 } });
    const [first, ...rest] = matches;
    const disjoint = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === first.sideAEntryId || id === first.sideBEntryId))!;
    await prisma.match.updateMany({ where: { id: { in: [first.id, disjoint.id] } }, data: { courtId: court.id } });

    const { control, result } = await startMatchWithControl(first.code);
    if (result.status !== "accepted") throw new Error("开局不应命中幂等分支。");
    // 场地被占：第二场连抛币都不能记录（抛币后时间与场地即冻结）。
    const second = await acquireScoringSession(refereeId, disjoint.code, randomUUID(), "演示裁判");
    const tossCommand = () =>
      command(second, 0, "RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } });
    await expect(submitScoringCommand(refereeId, disjoint.code, tossCommand(), second.controlToken)).rejects.toMatchObject({
      status: 409,
      code: "court_occupied",
      details: { busyMatchCode: first.code },
    });
    await expect(prisma.match.findUniqueOrThrow({ where: { id: disjoint.id }, select: { version: true, startedAt: true } })).resolves.toEqual({ version: 0, startedAt: null });

    // 暂停的比赛仍占着场地。
    const paused = await submitScoringCommand(refereeId, first.code, command(control, result.version, "PAUSE_MATCH", { reason: "地滑" }), control.controlToken);
    expect(paused.status).toBe("accepted");
    await expect(submitScoringCommand(refereeId, disjoint.code, tossCommand(), second.controlToken)).rejects.toMatchObject({ code: "court_occupied" });

    // 裁判长把暂停的比赛转到另一块空场地（S-5）后，本场照常抛币、开始。
    await prisma.court.create({ data: { tournamentId, code: "C2", name: "场地 2", active: true, sortOrder: 1 } });
    await transferSuspendedMatch(adminId, slug, first.code, { courtCode: "C2", reason: "场地 1 地滑" });
    const toss = await submitScoringCommand(refereeId, disjoint.code, tossCommand(), second.controlToken);
    if (toss.status !== "accepted") throw new Error("抛币不应命中幂等分支。");
    const players = (toss.state as { players: { A: string[]; B: string[] } }).players;
    await expect(
      submitScoringCommand(
        refereeId,
        disjoint.code,
        command(second, toss.version, "CONFIRM_OPENING_SETUP", { serverPlayerId: players.A[0], receiverPlayerId: players.B[0], logicalCourts: null } as MatchCommand["payload"]),
        second.controlToken,
      ),
    ).resolves.toMatchObject({ status: "accepted" });
  });
});

describe("S-8 占用判定与提示", () => {
  it("进行中、暂停中算占用；已结束待提交、待复核不算；提示写明占用比赛、状态与联系裁判长", async () => {
    const { tournamentId, matches } = await roundRobin("court-states", 4);
    const court = await prisma.court.create({ data: { tournamentId, code: "C1", name: "场地 1", active: true, sortOrder: 0 } });
    const [occupier, ...rest] = matches;
    const waiting = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === occupier.sideAEntryId || id === occupier.sideBEntryId))!;
    await prisma.match.updateMany({ where: { id: { in: [occupier.id, waiting.id] } }, data: { courtId: court.id } });
    const control = await acquireScoringSession(refereeId, waiting.code, randomUUID(), "演示裁判");
    const toss = () =>
      submitScoringCommand(
        refereeId,
        waiting.code,
        command(control, 0, "RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } }),
        control.controlToken,
      );
    // 只改占用方的生命周期投影来逐个检查判定条件（占用方没有真实事件，不对它下命令）。
    for (const [status, label] of [["IN_PROGRESS", "进行中"], ["SUSPENDED", "暂停中"]] as const) {
      await prisma.match.update({ where: { id: occupier.id }, data: { lifecycleStatus: status } });
      const rejected = toss();
      await expect(rejected).rejects.toMatchObject({ status: 409, code: "court_occupied", details: { busyMatchCode: occupier.code, busyMatchStatus: status } });
      await expect(rejected).rejects.toThrow(new RegExp(`场地 1被比赛 ${occupier.code}（${label}）占用.*请联系裁判长处理`));
    }
    for (const status of ["ENDED_PENDING_SUBMISSION", "SUBMITTED"] as const) {
      await prisma.match.update({ where: { id: occupier.id }, data: { lifecycleStatus: status } });
      const check = await prisma.$transaction(async (tx) =>
        tx.match.count({ where: { id: { not: waiting.id }, courtId: court.id, lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] } } }),
      );
      expect(check).toBe(0);
    }
    // 占用方已结束待提交时，本场照常抛币。
    await expect(toss()).resolves.toMatchObject({ status: "accepted" });
  });
});

describe("S-8 裁判长解除假占用", () => {
  async function abandonedOnCourt(name: string) {
    const { slug, tournamentId, matches } = await roundRobin(name, 4);
    const [c1, c2] = await Promise.all(
      ["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })),
    );
    const [stuck, ...rest] = matches;
    const waiting = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === stuck.sideAEntryId || id === stuck.sideBEntryId))!;
    await prisma.match.updateMany({ where: { id: { in: [stuck.id, waiting.id] } }, data: { courtId: c1.id } });
    // 主裁判开局后设备失联：比赛停在进行中，控制会话还在。
    const { result } = await startMatchWithControl(stuck.code);
    if (result.status !== "accepted") throw new Error("开局不应命中幂等分支。");
    const waitingDevice = randomUUID();
    await expect(startMatch(waiting.code, waitingDevice)).rejects.toMatchObject({ code: "court_occupied" });
    return { slug, c2, stuck, waiting, waitingDevice, version: result.version };
  }

  it("裁判长接管 → 暂停 → 转到空场地：原场地腾出，等候的比赛可以开始，比分不丢", async () => {
    const { slug, c2, stuck, waiting, waitingDevice, version } = await abandonedOnCourt("false-busy-transfer");
    const chief = await takeoverScoringSession(adminId, stuck.code, randomUUID(), "主裁判设备失联");
    const paused = await submitScoringCommand(adminId, stuck.code, command(chief, version, "PAUSE_MATCH", { reason: "设备失联，转场续打" }), chief.controlToken);
    expect(paused.status).toBe("accepted");
    await transferSuspendedMatch(adminId, slug, stuck.code, { courtCode: c2.code, reason: "原场地设备失联" });
    await expect(prisma.match.findUniqueOrThrow({ where: { id: stuck.id }, select: { courtId: true, lifecycleStatus: true } })).resolves.toEqual({ courtId: c2.id, lifecycleStatus: "SUSPENDED" });
    await expect(startMatch(waiting.code, waitingDevice)).resolves.toMatchObject({ status: "accepted" });
    await expect(prisma.auditLog.count({ where: { targetId: stuck.id, action: { contains: "TAKEOVER" } } })).resolves.toBeGreaterThan(0);
  });

  it("裁判长接管 → 登记特殊结果（比赛实际已结束）：比赛转为结束待提交，原场地腾出", async () => {
    const { stuck, waiting, waitingDevice, version } = await abandonedOnCourt("false-busy-end");
    const chief = await takeoverScoringSession(adminId, stuck.code, randomUUID(), "比赛已结束但设备未提交");
    const ended = await submitScoringCommand(
      adminId,
      stuck.code,
      command(chief, version, "RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "A", reason: "B 方伤退，主裁判设备失联未录入" }),
      chief.controlToken,
    );
    expect(ended.status).toBe("accepted");
    await expect(prisma.match.findUniqueOrThrow({ where: { id: stuck.id }, select: { lifecycleStatus: true } })).resolves.toEqual({ lifecycleStatus: "ENDED_PENDING_SUBMISSION" });
    await expect(startMatch(waiting.code, waitingDevice)).resolves.toMatchObject({ status: "accepted" });
  });
});

describe("S-9 暂停离场待续（场地全满时腾出场地）", () => {
  it("只有暂停中的比赛能离场；离场后原场地腾出、比分不变；恢复前必须先转场；绕过接口改场地仍被数据库拒绝", async () => {
    const { slug, tournamentId, matches } = await roundRobin("release", 4);
    const court = await prisma.court.create({ data: { tournamentId, code: "C1", name: "场地 1", active: true, sortOrder: 0 } });
    const [stuck, ...rest] = matches;
    const waiting = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === stuck.sideAEntryId || id === stuck.sideBEntryId))!;
    await prisma.match.updateMany({ where: { id: { in: [stuck.id, waiting.id] } }, data: { courtId: court.id } });
    const { control, result } = await startMatchWithControl(stuck.code);
    if (result.status !== "accepted") throw new Error("开局不应命中幂等分支。");
    const point = await submitScoringCommand(refereeId, stuck.code, command(control, result.version, "RALLY_WON", { side: "A" }), control.controlToken);
    if (point.status !== "accepted") throw new Error("得分不应命中幂等分支。");

    // 进行中的比赛不能离场；必须写原因；只有裁判长能操作。
    await expect(releaseSuspendedMatchCourt(adminId, slug, stuck.code, { reason: "场地全满" })).rejects.toMatchObject({ code: "match_not_suspended" });
    const paused = await submitScoringCommand(refereeId, stuck.code, command(control, point.version, "PAUSE_MATCH", { reason: "选手伤停" }), control.controlToken);
    if (paused.status !== "accepted") throw new Error("暂停不应命中幂等分支。");
    await expect(releaseSuspendedMatchCourt(adminId, slug, stuck.code, { reason: " " })).rejects.toMatchObject({ code: "reason_required" });
    await expect(releaseSuspendedMatchCourt(refereeId, slug, stuck.code, { reason: "场地全满" })).rejects.toMatchObject({ status: 403 });
    const waitingDevice = randomUUID();
    await expect(startMatch(waiting.code, waitingDevice)).rejects.toMatchObject({ code: "court_occupied", details: { busyMatchStatus: "SUSPENDED" } });

    await expect(releaseSuspendedMatchCourt(adminId, slug, stuck.code, { reason: "选手伤停待医疗处理，场地全满" })).resolves.toMatchObject({ fromCourt: "场地 1" });
    const released = await prisma.match.findUniqueOrThrow({ where: { id: stuck.id }, select: { courtId: true, lifecycleStatus: true, awaitingCourtSince: true } });
    expect(released).toMatchObject({ courtId: null, lifecycleStatus: "SUSPENDED", awaitingCourtSince: expect.any(Date) });
    await expect(prisma.auditLog.count({ where: { targetId: stuck.id, action: "MATCH_COURT_RELEASED" } })).resolves.toBe(1);
    await expect(releaseSuspendedMatchCourt(adminId, slug, stuck.code, { reason: "再来一次" })).rejects.toMatchObject({ code: "match_has_no_court" });

    // 原场地腾出：等候的比赛可以开始。
    await expect(startMatch(waiting.code, waitingDevice)).resolves.toMatchObject({ status: "accepted" });

    // 恢复前必须先转场；比分保持暂停前的 1:0。
    const resume = () => submitScoringCommand(refereeId, stuck.code, command(control, paused.version, "RESUME_MATCH", { reason: "医疗处理完毕" }), control.controlToken);
    await expect(resume()).rejects.toMatchObject({ status: 409, code: "match_awaiting_court" });
    const c2 = await prisma.court.create({ data: { tournamentId, code: "C2", name: "场地 2", active: true, sortOrder: 1 } });
    await transferSuspendedMatch(adminId, slug, stuck.code, { courtCode: c2.code, reason: "场地 2 空出" });
    await expect(prisma.match.findUniqueOrThrow({ where: { id: stuck.id }, select: { courtId: true, awaitingCourtSince: true } })).resolves.toEqual({ courtId: c2.id, awaitingCourtSince: null });
    const resumed = await resume();
    expect(resumed).toMatchObject({ status: "accepted" });
    expect((resumed as { state: { score: { A: number; B: number } } }).state.score).toEqual({ A: 1, B: 0 });

    // 数据库兜底：不声明离场就把已开始比赛的场地改为空，被触发器拒绝；离场待续时不能同时有场地。
    await expect(prisma.match.update({ where: { id: stuck.id }, data: { courtId: null } })).rejects.toThrow();
    await expect(prisma.match.update({ where: { id: waiting.id }, data: { awaitingCourtSince: new Date() } })).rejects.toThrow();
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

describe("方案 B2 执裁记录：排班与实际执裁人并列；用共用账号就要登记姓名", () => {
  it("逐场指派给共用账号的比赛也要填姓名，具名账号不用；看板、复核列表与内部名单并列显示排班与实际执裁（含交接、裁判长接管）", async () => {
    const { slug, tournamentId, matches } = await roundRobin("b2", 3);
    await expect(prisma.tournament.findUniqueOrThrow({ where: { id: tournamentId }, select: { refereeMode: true } })).resolves.toEqual({ refereeMode: "PER_MATCH" });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: refereeId }, select: { platformReferee: true } })).resolves.toEqual({ platformReferee: true });
    const [shared, named] = matches;

    // 共用账号（逐场指派模式下手工指派）：不填姓名不能取得控制，工作台也提示必须填写。
    await expect(acquireScoringSession(refereeId, shared.code, randomUUID())).rejects.toMatchObject({ status: 400, code: "officiating_name_required" });
    await expect(getAuthoritativeMatchState(refereeId, shared.code)).resolves.toMatchObject({ access: { officiatingNameRequired: true } });

    // 具名裁判账号：账号即身份，不要求填写姓名。
    const email = `b2-${RUN}@example.test`;
    createdEmails.push(email);
    const namedId = (await prisma.user.create({ data: { email, name: `具名裁判${RUN}` } })).id;
    await prisma.roleAssignment.create({ data: { userId: namedId, tournamentId, role: "REFEREE" } });
    await prisma.officialAssignment.updateMany({ where: { matchId: named.id }, data: { active: false } });
    await prisma.officialAssignment.create({ data: { matchId: named.id, userId: namedId } });
    await expect(getAuthoritativeMatchState(namedId, named.code)).resolves.toMatchObject({ access: { officiatingNameRequired: false } });
    const namedControl = await acquireScoringSession(namedId, named.code, randomUUID());
    await expect(prisma.scoringSession.findUniqueOrThrow({ where: { id: namedControl.sessionId } })).resolves.toMatchObject({ officiatingName: null });

    // 共用账号：张三取得控制并开局，同一设备换成李四（交接），之后裁判长接管。
    const device = randomUUID();
    const { control } = await startMatchWithControl(shared.code, device);
    await expect(prisma.scoringSession.findUniqueOrThrow({ where: { id: control.sessionId } })).resolves.toMatchObject({ officiatingName: "演示裁判" });
    await acquireScoringSession(refereeId, shared.code, device, "李四");
    await acquireScoringSession(refereeId, shared.code, device, "李四");
    await takeoverScoringSession(adminId, shared.code, randomUUID(), "设备失联");

    const records = await loadOfficiatingRecords(prisma, [shared.id, named.id, matches[2].id]);
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { name: true } });
    expect(records.get(shared.id)).toMatchObject({
      scheduled: { name: "共用账号", shared: true },
      actual: [
        { name: "演示裁判", kind: "ACQUIRED" },
        { name: "李四", kind: "HANDOVER" },
        { name: `${admin.name}（裁判长接管）`, kind: "TAKEOVER" },
      ],
    });
    expect(records.get(named.id)).toMatchObject({ scheduled: { name: `具名裁判${RUN}`, shared: false }, actual: [{ name: `具名裁判${RUN}` }] });
    // 没人取得过控制的比赛只有排班。
    expect(records.get(matches[2].id)).toMatchObject({ scheduled: { name: "共用账号" }, actual: [] });

    // 后台 / 裁判长看板：已开打的比赛一行并列显示。
    const workspace = await loadScheduleWorkspace(tournamentId, new Date());
    const row = workspace.publishedRows.find((item) => item.code === shared.code)!;
    expect(row.officiating?.scheduled).toBe("共用账号");
    expect(row.officiating?.actual).toMatch(/^演示裁判 \d\d:\d\d → 李四 \d\d:\d\d（交接） → .+（裁判长接管） \d\d:\d\d$/);
    expect(workspace.publishedRows.find((item) => item.code === matches[2].code)?.officiating).toBeNull();

    // 复核列表：提交后的比赛带执裁记录。
    await prisma.match.update({ where: { id: named.id }, data: { lifecycleStatus: "SUBMITTED" } });
    const review = await loadOfficiatingTournament(adminId, slug);
    expect(review.reviewMatches.find((item) => item.code === named.code)?.officiatingRecord).toMatch(new RegExp(`^排班：具名裁判${RUN} · 实际执裁：具名裁判${RUN} \\d\\d:\\d\\d$`));

    // 内部名单（仅管理员/编排员可下载）多一张「执裁记录」表；对外数据表不含裁判姓名。
    const internal = await generateReportExport(adminId, slug, { kind: "REGISTRATIONS_INTERNAL" });
    const file = await prisma.reportExport.findUniqueOrThrow({ where: { id: internal.id }, select: { content: true } });
    const sheet = readXlsx(Buffer.from(file.content)).find((item) => item.name === "执裁记录")!;
    const rows = tableRows(sheet, "比赛编号").rows;
    expect(rows.find((item) => item[0] === shared.code)).toEqual([shared.code, "男子单打", expect.any(String), expect.any(String), "进行中", "共用账号", expect.stringContaining("李四")]);
    expect(rows.find((item) => item[0] === named.code)?.[5]).toBe(`具名裁判${RUN}`);
    const workbook = await generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" });
    const workbookFile = await prisma.reportExport.findUniqueOrThrow({ where: { id: workbook.id }, select: { content: true } });
    const workbookXml = readXlsx(Buffer.from(workbookFile.content)).map((item) => item.xml).join("");
    for (const secret of ["李四", `具名裁判${RUN}`]) expect(workbookXml).not.toContain(secret);
  });
});

describe("独立复判 2026-11-09 RV-01 / RV-02 修复", () => {
  async function pausedAndWaiting(name: string) {
    const ctx = await roundRobin(name, 4);
    const [c1, c2] = await Promise.all(
      ["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId: ctx.tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })),
    );
    const [m, ...rest] = ctx.matches;
    const n = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === m.sideAEntryId || id === m.sideBEntryId))!;
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    await prisma.match.update({ where: { id: n.id }, data: { courtId: c2.id } });
    const { control, result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("开局不应命中幂等分支。");
    const paused = await submitScoringCommand(refereeId, m.code, command(control, result.version, "PAUSE_MATCH", { reason: "伤停" }), control.controlToken);
    if (paused.status !== "accepted") throw new Error("暂停不应命中幂等分支。");
    return { ...ctx, c1, c2, m, n, control, paused };
  }

  it("RV-01 转场与开局并发进入同一块场地：每一轮都只有一场成功，场地上从不出现两场", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { slug, c2, m, n } = await pausedAndWaiting(`rv01-${round}`);
      const nControl = await acquireScoringSession(refereeId, n.code, randomUUID(), "演示裁判");
      const toss = await submitScoringCommand(
        refereeId,
        n.code,
        command(nControl, 0, "RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } }),
        nControl.controlToken,
      );
      if (toss.status !== "accepted") throw new Error("抛币不应命中幂等分支。");
      const players = (toss.state as { players: { A: string[]; B: string[] } }).players;
      const settled = await Promise.allSettled([
        transferSuspendedMatch(adminId, slug, m.code, { courtCode: "C2", reason: "并发转场" }),
        submitScoringCommand(
          refereeId,
          n.code,
          command(nControl, toss.version, "CONFIRM_OPENING_SETUP", { serverPlayerId: players.A[0], receiverPlayerId: players.B[0], logicalCourts: null } as MatchCommand["payload"]),
          nControl.controlToken,
        ),
      ]);
      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
      expect(["court_busy", "court_occupied"]).toContain((rejected.reason as { code?: string }).code);
      await expect(prisma.match.count({ where: { courtId: c2.id, lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] } } })).resolves.toBe(1);
    }
  });

  it("RV-01 数据库兜底：绕过应用检查把暂停的比赛转进有人的场地被触发器拒绝；场地上原有的两场照常续打", async () => {
    const { c2, m, n } = await pausedAndWaiting("rv01-db");
    await startMatch(n.code);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('badminton.court_transfer', 'on', true)`;
        await tx.match.update({ where: { id: m.id }, data: { courtId: c2.id } });
      }),
    ).rejects.toThrow(/court_occupied/);
    // 只检查「新进入占用」：已在场上的比赛改状态（暂停 ↔ 进行中）不受影响。
    await expect(prisma.match.update({ where: { id: n.id }, data: { lifecycleStatus: "SUSPENDED" } })).resolves.toBeTruthy();
    await expect(prisma.match.update({ where: { id: n.id }, data: { lifecycleStatus: "IN_PROGRESS" } })).resolves.toBeTruthy();
  });

  it("RV-02 离场待续时不能作废计分、不能开局；先转场再作废照常；数据库不允许离场待续的比赛离开暂停中，也不允许离场时不记标记", async () => {
    const { slug, m, paused } = await pausedAndWaiting("rv02");
    await releaseSuspendedMatchCourt(adminId, slug, m.code, { reason: "场地全满" });
    const chief = await takeoverScoringSession(adminId, m.code, randomUUID(), "复核作废");
    await expect(
      submitScoringCommand(adminId, m.code, command(chief, paused.version, "VOID_MATCH_SCORING", { reason: "开错场次" }), chief.controlToken),
    ).rejects.toMatchObject({ status: 409, code: "match_awaiting_court" });
    await expect(prisma.match.update({ where: { id: m.id }, data: { lifecycleStatus: "READY" } })).rejects.toThrow();
    await transferSuspendedMatch(adminId, slug, m.code, { courtCode: "C1", reason: "场地 1 空出" });
    await expect(
      submitScoringCommand(adminId, m.code, command(chief, paused.version, "VOID_MATCH_SCORING", { reason: "开错场次" }), chief.controlToken),
    ).resolves.toMatchObject({ status: "accepted" });

    // 离场声明下只改场地、不记离场待续：触发器拒绝。
    const other = await pausedAndWaiting("rv02-flag");
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('badminton.court_release', 'on', true)`;
        await tx.match.update({ where: { id: other.m.id }, data: { courtId: null } });
      }),
    ).rejects.toThrow(/cannot change/);
  });
});

describe("独立复判第二轮 RV2-01 / RV2-02 / RV2-03 修复", () => {
  async function onCourts(name: string) {
    const ctx = await roundRobin(name, 4);
    const [c1, c2] = await Promise.all(
      ["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId: ctx.tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })),
    );
    const [m, ...rest] = ctx.matches;
    const n = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === m.sideAEntryId || id === m.sideBEntryId))!;
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    await prisma.match.update({ where: { id: n.id }, data: { courtId: c1.id } });
    return { ...ctx, c1, c2, m, n };
  }

  it("RV2-01 离场待续时记录退赛：照常结束并提交，标记保留；作废特殊结果回到暂停中后，恢复前仍须先转场", async () => {
    const { slug, m } = await onCourts("rv201");
    const { control, result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("开局不应命中幂等分支。");
    const paused = await submitScoringCommand(refereeId, m.code, command(control, result.version, "PAUSE_MATCH", { reason: "伤停" }), control.controlToken);
    if (paused.status !== "accepted") throw new Error("暂停不应命中幂等分支。");
    await releaseSuspendedMatchCourt(adminId, slug, m.code, { reason: "医疗处理、场地全满" });

    const ret = await submitScoringCommand(
      refereeId,
      m.code,
      command(control, paused.version, "RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "A", reason: "B 方伤退" } as MatchCommand["payload"]),
      control.controlToken,
    );
    expect(ret).toMatchObject({ status: "accepted" });
    if (ret.status !== "accepted") throw new Error("退赛不应命中幂等分支。");
    await expect(prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { lifecycleStatus: true, awaitingCourtSince: true, courtId: true } })).resolves.toMatchObject({
      lifecycleStatus: "ENDED_PENDING_SUBMISSION",
      awaitingCourtSince: expect.any(Date),
      courtId: null,
    });

    // 误记退赛：作废后回到暂停中，仍是离场待续，恢复前必须先转场。
    const invalidated = await submitScoringCommand(refereeId, m.code, command(control, ret.version, "INVALIDATE_SPECIAL_OUTCOME", { reason: "误记" }), control.controlToken);
    expect(invalidated).toMatchObject({ status: "accepted" });
    if (invalidated.status !== "accepted") throw new Error("作废不应命中幂等分支。");
    await expect(prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { lifecycleStatus: true, awaitingCourtSince: true } })).resolves.toMatchObject({
      lifecycleStatus: "SUSPENDED",
      awaitingCourtSince: expect.any(Date),
    });
    await expect(
      submitScoringCommand(refereeId, m.code, command(control, invalidated.version, "RESUME_MATCH", { reason: "处理完毕" }), control.controlToken),
    ).rejects.toMatchObject({ status: 409, code: "match_awaiting_court" });

    // 再次记录退赛并提交复核：走完整个流程。
    const again = await submitScoringCommand(
      refereeId,
      m.code,
      command(control, invalidated.version, "RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "A", reason: "B 方伤退" } as MatchCommand["payload"]),
      control.controlToken,
    );
    if (again.status !== "accepted") throw new Error("退赛不应命中幂等分支。");
    await expect(
      submitScoringCommand(refereeId, m.code, command(control, again.version, "SUBMIT_RESULT", { reason: "提交复核" }), control.controlToken),
    ).resolves.toMatchObject({ status: "accepted" });
    await expect(prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { lifecycleStatus: true } })).resolves.toEqual({ lifecycleStatus: "SUBMITTED" });
    // 数据库兜底：离场待续的比赛不能回到未开打或进行中。
    await expect(prisma.match.update({ where: { id: m.id }, data: { lifecycleStatus: "IN_PROGRESS" } })).rejects.toThrow();
  });

  it("RV2-02 结束后场地已被下一场占用：作废特殊结果回到进行中被拒，提示写明占用的比赛与状态", async () => {
    const { m, n } = await onCourts("rv202");
    const { control, result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("开局不应命中幂等分支。");
    const ret = await submitScoringCommand(
      refereeId,
      m.code,
      command(control, result.version, "RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "A", reason: "B 方伤退" } as MatchCommand["payload"]),
      control.controlToken,
    );
    if (ret.status !== "accepted") throw new Error("退赛不应命中幂等分支。");
    // 已结束待提交不占场地：下一场开局。
    await startMatch(n.code);
    await expect(
      submitScoringCommand(refereeId, m.code, command(control, ret.version, "INVALIDATE_SPECIAL_OUTCOME", { reason: "误记" }), control.controlToken),
    ).rejects.toMatchObject({
      status: 409,
      code: "court_occupied",
      details: { busyMatchCode: n.code, busyMatchStatus: "IN_PROGRESS" },
      message: expect.stringContaining("本场暂不能继续"),
    });
  });

  it("RV2-03 未登记姓名的旧会话补填姓名：时间线保留「未登记姓名」一段，再列交接后的人", async () => {
    const { m } = await onCourts("rv203");
    const device = randomUUID();
    const { control } = await startMatchWithControl(m.code, device);
    // 模拟 B2 上线前建立的会话：会话上没有姓名。
    await prisma.scoringSession.update({ where: { id: control.sessionId }, data: { officiatingName: null } });
    await acquireScoringSession(refereeId, m.code, device, "后来的人");
    const record = (await loadOfficiatingRecords(prisma, [m.id])).get(m.id)!;
    expect(record.actual.map((entry) => [entry.name, entry.kind])).toEqual([
      ["共用账号（未登记姓名）", "ACQUIRED"],
      ["后来的人", "HANDOVER"],
    ]);
  });
});

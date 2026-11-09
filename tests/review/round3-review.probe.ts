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
import { loadOfficiatingRecords } from "@/server/services/officiating-record";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

/**
 * 赛务口径决定（2026-10-27）的比赛日规则：见 `docs/knowledge-base/03-竞赛规则/赛务口径决定-2026-10-27.md`。
 */

const RUN = `r3${randomBytes(3).toString("hex")}`;
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
});

/*
 * ===== 独立复判第二轮探针（2026-11-09，非产品测试）=====
 * 上方夹具逐字复制自 tests/review/match-day-review.probe.ts（仅改 RUN 前缀）。
 * 只读断言为主；为构造并发与过期场景，少量直接写 _test 库（标明「探针写入」），不改产品代码。
 */
import { appendFileSync } from "node:fs";
/** 探针观察值写到 REVIEW_LOG（vitest 的 console 输出在本仓库配置下不显示）。 */
function note(...parts: unknown[]) {
  const line = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
  if (process.env.REVIEW_LOG) appendFileSync(process.env.REVIEW_LOG, `${line}\n`);
}

async function twoCourts(tournamentId: string) {
  return Promise.all(["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })));
}

function disjointPair(matches: { id: string; code: string; sideAEntryId: string | null; sideBEntryId: string | null }[]) {
  const [m, ...rest] = matches;
  const n = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === m.sideAEntryId || id === m.sideBEntryId))!;
  return { m, n };
}

/*
 * ===== 独立复判第三轮探针（2026-11-09，非产品测试）=====
 * 复判提交 8d1c355（RV2-01..04）。上方夹具逐字复制自 round2-review.probe.ts（仅改 RUN 前缀）。
 * 少量直接写 _test 库（标明「探针写入」）以构造边界，不改产品代码。
 */
import { rethrowCourtOccupied } from "@/server/services/errors";

type Outcome = "RET" | "WO" | "DSQ" | "ABANDONED";

function outcomePayload(type: Outcome) {
  return (type === "ABANDONED" ? { type, reason: "场馆停电" } : { type, winnerSide: "A", reason: `${type} 探针` }) as MatchCommand["payload"];
}

/** 提交命令并把结果归一成 { status, code, version, message }，不让 500 类错误被 rejects.toBeTruthy 吞掉。 */
async function attempt(actor: string, code: string, envelope: ScoringCommandEnvelope, token: string) {
  try {
    const r = await submitScoringCommand(actor, code, envelope, token);
    return { status: r.status as string, version: (r as { version?: number }).version ?? -1, code: null as string | null, message: "", details: null as unknown };
  } catch (error) {
    const e = error as { status?: number; code?: string; message: string; details?: unknown; constructor: { name: string } };
    return { status: e.status ? String(e.status) : `THROWN:${e.constructor.name}`, version: -1, code: e.code ?? null, message: e.message.slice(0, 300), details: e.details ?? null };
  }
}

async function lifecycleOf(id: string) {
  return prisma.match.findUniqueOrThrow({ where: { id }, select: { lifecycleStatus: true, awaitingCourtSince: true, courtId: true, verificationStatus: true } });
}

/** m、n 两场选手不重叠、都排在场地 1；m 开局→暂停→离场待续。 */
async function awaitingCourt(name: string) {
  const ctx = await roundRobin(name, 4);
  const [c1, c2] = await twoCourts(ctx.tournamentId);
  const { m, n } = disjointPair(ctx.matches);
  await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
  await prisma.match.update({ where: { id: n.id }, data: { courtId: c1.id } });
  const { control, result } = await startMatchWithControl(m.code);
  if (result.status !== "accepted") throw new Error("x");
  const paused = await submitScoringCommand(refereeId, m.code, command(control, result.version, "PAUSE_MATCH", { reason: "伤停" }), control.controlToken);
  if (paused.status !== "accepted") throw new Error("x");
  await releaseSuspendedMatchCourt(adminId, ctx.slug, m.code, { reason: "医疗处理、场地全满" });
  return { ...ctx, c1, c2, m, n, control, version: paused.version };
}


/** 逐分打完一场（A 方 2:0），返回最后一次接受的结果。 */
async function playToComplete(code: string, control: { sessionId: string; takeoverGeneration: number; controlToken: string }, start: { version: number; state: unknown }) {
  type S = { phase: string; pendingObligations: { id: string; type: string }[]; players: { A: string[]; B: string[] } };
  let version = start.version;
  let state = start.state as S;
  while (state.phase !== "MATCH_COMPLETE_PENDING_SUBMISSION") {
    const obligation = state.pendingObligations[0];
    const [type, payload] = obligation
      ? [obligation.type === "INTERVAL" ? "ACKNOWLEDGE_INTERVAL" : "CONFIRM_CHANGE_ENDS", { obligationId: obligation.id }]
      : state.phase === "AWAITING_NEXT_GAME_SETUP"
        ? ["CONFIRM_NEXT_GAME_SETUP", { serverPlayerId: state.players.A[0], receiverPlayerId: state.players.B[0], logicalCourts: null }]
        : ["RALLY_WON", { side: "A" }];
    const r = await submitScoringCommand(refereeId, code, command(control, version, type as MatchCommand["type"], payload as MatchCommand["payload"]), control.controlToken);
    if (r.status !== "accepted") throw new Error("x");
    version = r.version;
    state = r.state as S;
  }
  return { version };
}

describe("复判第三轮 RV2-01：离场待续时的特殊结果全链路", () => {
  for (const type of ["RET", "WO", "DSQ", "ABANDONED"] as Outcome[]) {
    it(`离场待续时记录 ${type}：接受、转结束待提交、标记保留`, async () => {
      const { m, control, version } = await awaitingCourt(`o-${type.toLowerCase()}`);
      const r = await attempt(refereeId, m.code, command(control, version, "RECORD_SPECIAL_OUTCOME", outcomePayload(type)), control.controlToken);
      note(`R3-OUTCOME ${type}`, r, await lifecycleOf(m.id));
      expect(r.status.startsWith("THROWN")).toBe(false);
      expect(r.status).not.toBe("500");
      if (type === "WO") return; // 弃权只用于一分未打：开局后 0:0 是否接受由 special-outcome 规则决定，这里只断言不是 500
      expect(r.status).toBe("accepted");
      await expect(lifecycleOf(m.id)).resolves.toMatchObject({ lifecycleStatus: "ENDED_PENDING_SUBMISSION", awaitingCourtSince: expect.any(Date), courtId: null });
    });
  }

  it("退赛 → 提交 → 裁判长确认 → 重开 → 作废特殊结果 → 恢复被拒 → 转场 → 恢复", async () => {
    const { slug, m, c2, control, version } = await awaitingCourt("chain");
    const steps: unknown[] = [];
    let v = version;
    const ret = await attempt(refereeId, m.code, command(control, v, "RECORD_SPECIAL_OUTCOME", outcomePayload("RET")), control.controlToken);
    steps.push(["RET", ret.status]); v = ret.version;
    const sub = await attempt(refereeId, m.code, command(control, v, "SUBMIT_RESULT", { reason: "提交" }), control.controlToken);
    steps.push(["SUBMIT", sub.status, (await lifecycleOf(m.id)).lifecycleStatus]); v = sub.version;
    const chief = await takeoverScoringSession(adminId, m.code, randomUUID(), "复核");
    const conf = await attempt(adminId, m.code, command(chief, v, "CONFIRM_RESULT", { reason: "确认" }), chief.controlToken);
    const afterConfirm = await lifecycleOf(m.id);
    steps.push(["CONFIRM", conf.status, afterConfirm.lifecycleStatus, afterConfirm.verificationStatus, Boolean(afterConfirm.awaitingCourtSince)]); v = conf.version;
    const reopen = await attempt(adminId, m.code, command(chief, v, "REOPEN_RESULT", { reason: "重开" }), chief.controlToken);
    steps.push(["REOPEN", reopen.status, (await lifecycleOf(m.id)).lifecycleStatus]); v = reopen.version;
    const inv = await attempt(adminId, m.code, command(chief, v, "INVALIDATE_SPECIAL_OUTCOME", { reason: "误记" }), chief.controlToken);
    const afterInv = await lifecycleOf(m.id);
    steps.push(["INVALIDATE", inv.status, afterInv.lifecycleStatus, Boolean(afterInv.awaitingCourtSince)]); v = inv.version;
    const resume1 = await attempt(adminId, m.code, command(chief, v, "RESUME_MATCH", { reason: "处理完毕" }), chief.controlToken);
    steps.push(["RESUME-before-transfer", resume1.status, resume1.code]);
    await transferSuspendedMatch(adminId, slug, m.code, { courtCode: c2.code, reason: "有空场地了" });
    const resume2 = await attempt(adminId, m.code, command(chief, v, "RESUME_MATCH", { reason: "处理完毕" }), chief.controlToken);
    const end = await lifecycleOf(m.id);
    steps.push(["RESUME-after-transfer", resume2.status, end.lifecycleStatus, end.courtId === c2.id, end.awaitingCourtSince]);
    note("R3-CHAIN", steps);
    expect(ret.status).toBe("accepted");
    expect(sub.status).toBe("accepted");
    expect(conf.status).toBe("accepted");
    expect(afterConfirm).toMatchObject({ lifecycleStatus: "SUBMITTED", verificationStatus: "LOCKED", awaitingCourtSince: expect.any(Date) });
    expect(reopen.status).toBe("accepted");
    expect(inv.status).toBe("accepted");
    expect(afterInv).toMatchObject({ lifecycleStatus: "SUSPENDED", awaitingCourtSince: expect.any(Date), courtId: null });
    expect(resume1).toMatchObject({ status: "409", code: "match_awaiting_court" });
    expect(resume2.status).toBe("accepted");
    expect(end).toMatchObject({ lifecycleStatus: "IN_PROGRESS", awaitingCourtSince: null });
  });

  it("离场待续 + 退赛后：作废特殊结果回到暂停中照常放行；作废计分、更正被拒且不是 500；转场被拒（只限暂停中）", async () => {
    const { slug, m, c2, control, version } = await awaitingCourt("after-ret");
    const ret = await attempt(refereeId, m.code, command(control, version, "RECORD_SPECIAL_OUTCOME", outcomePayload("RET")), control.controlToken);
    const chief = await takeoverScoringSession(adminId, m.code, randomUUID(), "复核");
    const voided = await attempt(adminId, m.code, command(chief, ret.version, "VOID_MATCH_SCORING", { reason: "作废" } as MatchCommand["payload"]), chief.controlToken);
    const corrected = await attempt(adminId, m.code, command(chief, ret.version, "CORRECT_SCORE_STATE", { reason: "更正", obligationModel: 2, replacement: { score: { A: 3, B: 2 } } } as unknown as MatchCommand["payload"]), chief.controlToken);
    let transfer: unknown;
    try { transfer = await transferSuspendedMatch(adminId, slug, m.code, { courtCode: c2.code, reason: "试转" }); } catch (e) { transfer = { status: (e as { status?: number }).status, code: (e as { code?: string }).code }; }
    const undo = await attempt(adminId, m.code, command(chief, ret.version, "UNDO_LAST_REVERSIBLE", { reason: "撤销退赛" }), chief.controlToken);
    const inv = await attempt(adminId, m.code, command(chief, ret.version, "INVALIDATE_SPECIAL_OUTCOME", { reason: "误记" }), chief.controlToken);
    const after = await lifecycleOf(m.id);
    note("R3-AFTER-RET", { voided, corrected, transfer, undo, inv, after });
    expect(voided).toMatchObject({ status: "409", code: "match_awaiting_court" });
    expect(corrected.status.startsWith("THROWN")).toBe(false);
    expect(["409", "422", "400"]).toContain(corrected.status);
    expect(transfer).toMatchObject({ status: 409, code: "match_not_suspended" });
    expect(undo).toMatchObject({ status: "422", code: "nothing_to_undo" }); // 特殊结果不走撤销，走作废
    expect(inv.status).toBe("accepted");
    expect(after).toMatchObject({ lifecycleStatus: "SUSPENDED", awaitingCourtSince: expect.any(Date), courtId: null });
  });

  it("数据库兜底：带离场标记的比赛直写为未开打 / 就绪 / 进行中均被拒，且映射为 409 match_awaiting_court", async () => {
    const { m, control, version } = await awaitingCourt("db");
    await attempt(refereeId, m.code, command(control, version, "RECORD_SPECIAL_OUTCOME", outcomePayload("RET")), control.controlToken);
    const [def] = await prisma.$queryRaw<{ conname: string; def: string }[]>`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname LIKE 'matches_awaiting_court%' AND conname <> 'matches_awaiting_court_has_no_court'`;
    const results: Record<string, unknown> = {};
    for (const status of ["SCHEDULED", "READY", "IN_PROGRESS"] as const) {
      try {
        // 探针写入：绕过服务层直写。
        await prisma.match.update({ where: { id: m.id }, data: { lifecycleStatus: status } });
        results[status] = "ACCEPTED";
      } catch (error) {
        try { rethrowCourtOccupied(error); } catch (mapped) { results[status] = { status: (mapped as { status?: number }).status ?? "unmapped", code: (mapped as { code?: string }).code ?? null }; }
      }
    }
    note("R3-DB", def, results);
    expect(def.conname).toBe("matches_awaiting_court_not_playable");
    for (const status of ["SCHEDULED", "READY", "IN_PROGRESS"]) expect(results[status]).toEqual({ status: 409, code: "match_awaiting_court" });
  });
});

describe("复判第三轮 RV2-02：从不占场地回到占场地", () => {
  it("逐分打完后场地交给下一场：撤销最后一分被拒（进行中、暂停中两种占用）；重开不误拦；下一场结束后撤销放行", async () => {
    const { tournamentId, matches } = await roundRobin("reocc", 4);
    const [c1] = await twoCourts(tournamentId);
    const { m, n } = disjointPair(matches);
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    await prisma.match.update({ where: { id: n.id }, data: { courtId: c1.id } });
    const { control, result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("x");
    const done = await playToComplete(m.code, control, result);
    const nStart = await startMatchWithControl(n.code);
    if (nStart.result.status !== "accepted") throw new Error("x");
    const undo1 = await attempt(refereeId, m.code, command(control, done.version, "UNDO_LAST_REVERSIBLE", { reason: "撤销" }), control.controlToken);
    const nPaused = await attempt(refereeId, n.code, command(nStart.control, nStart.result.version, "PAUSE_MATCH", { reason: "伤停" }), nStart.control.controlToken);
    const undo2 = await attempt(refereeId, m.code, command(control, done.version, "UNDO_LAST_REVERSIBLE", { reason: "撤销" }), control.controlToken);
    // 下一场退赛结束后，m 撤销放行。
    const nEnd = await attempt(refereeId, n.code, command(nStart.control, nPaused.version, "RECORD_SPECIAL_OUTCOME", outcomePayload("RET")), nStart.control.controlToken);
    const undo3 = await attempt(refereeId, m.code, command(control, done.version, "UNDO_LAST_REVERSIBLE", { reason: "撤销" }), control.controlToken);
    const after = await lifecycleOf(m.id);
    note("R3-REOCC", { undo1, undo2, nEnd: nEnd.status, undo3, after });
    expect(undo1).toMatchObject({ status: "409", code: "court_occupied", details: { busyMatchCode: n.code, busyMatchStatus: "IN_PROGRESS" } });
    expect(undo1.message).toContain("本场暂不能继续");
    expect(undo2).toMatchObject({ status: "409", code: "court_occupied", details: { busyMatchCode: n.code, busyMatchStatus: "SUSPENDED" } });
    expect(undo2.message).toContain("暂停中");
    expect(nEnd.status).toBe("accepted");
    expect(undo3.status).toBe("accepted");
    expect(after).toMatchObject({ lifecycleStatus: "IN_PROGRESS", courtId: c1.id });
    await expect(prisma.match.count({ where: { courtId: c1.id, lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] } } })).resolves.toBe(1);
  });

  it("作废特殊结果回到进行中：场地被下一场占用时被拒并带编号", async () => {
    const { tournamentId, matches } = await roundRobin("reocc-inv", 4);
    const [c1] = await twoCourts(tournamentId);
    const { m, n } = disjointPair(matches);
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    await prisma.match.update({ where: { id: n.id }, data: { courtId: c1.id } });
    const { control, result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("x");
    const ret = await attempt(refereeId, m.code, command(control, result.version, "RECORD_SPECIAL_OUTCOME", outcomePayload("RET")), control.controlToken);
    await startMatch(n.code);
    const inv = await attempt(refereeId, m.code, command(control, ret.version, "INVALIDATE_SPECIAL_OUTCOME", { reason: "误记" }), control.controlToken);
    // 提交后重开：SUBMITTED → 结束待提交，不进入占用，场地被占时也不应被拦。
    const sub = await attempt(refereeId, m.code, command(control, ret.version, "SUBMIT_RESULT", { reason: "提交" }), control.controlToken);
    const chief = await takeoverScoringSession(adminId, m.code, randomUUID(), "复核");
    const reopen = await attempt(adminId, m.code, command(chief, sub.version, "REOPEN_RESULT", { reason: "重开" }), chief.controlToken);
    note("R3-REOCC-INV", inv, sub.status, reopen.status);
    expect(sub.status).toBe("accepted");
    expect(reopen.status).toBe("accepted");
    expect(inv).toMatchObject({ status: "409", code: "court_occupied", details: { busyMatchCode: n.code, busyMatchStatus: "IN_PROGRESS" } });
  });

  it("抛币仍用「开始」提示，不被新分支改成「继续」", async () => {
    const { tournamentId, matches } = await roundRobin("toss", 4);
    const [c1] = await twoCourts(tournamentId);
    const { m, n } = disjointPair(matches);
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    await prisma.match.update({ where: { id: n.id }, data: { courtId: c1.id } });
    await startMatch(m.code);
    const control = await acquireScoringSession(refereeId, n.code, randomUUID(), "乙");
    const toss = await attempt(refereeId, n.code, command(control, 0, "RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } } as MatchCommand["payload"]), control.controlToken);
    note("R3-TOSS", toss);
    expect(toss).toMatchObject({ status: "409", code: "court_occupied" });
    expect(toss.message).toContain("本场暂不能开始");
  });

  it("并发：m 作废特殊结果回进行中 与 n 确认开局 同时进入场地 1（10 轮），每轮只进一场，失败方是 409 不是 500", async () => {
    const tally: Record<string, number> = {};
    for (let round = 0; round < 10; round += 1) {
      const { tournamentId, matches } = await roundRobin(`race${round}`, 4);
      const [c1] = await twoCourts(tournamentId);
      const { m, n } = disjointPair(matches);
      await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
      await prisma.match.update({ where: { id: n.id }, data: { courtId: c1.id } });
      const { control, result } = await startMatchWithControl(m.code);
      if (result.status !== "accepted") throw new Error("x");
      const ret = await attempt(refereeId, m.code, command(control, result.version, "RECORD_SPECIAL_OUTCOME", outcomePayload("RET")), control.controlToken);
      const nc = await acquireScoringSession(refereeId, n.code, randomUUID(), "乙");
      const toss = await submitScoringCommand(refereeId, n.code, command(nc, 0, "RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } } as MatchCommand["payload"]), nc.controlToken);
      if (toss.status !== "accepted") throw new Error("x");
      const players = (toss.state as { players: { A: string[]; B: string[] } }).players;
      const runM = () => attempt(refereeId, m.code, command(control, ret.version, "INVALIDATE_SPECIAL_OUTCOME", { reason: "误记" }), control.controlToken);
      const runN = () => attempt(refereeId, n.code, command(nc, toss.version, "CONFIRM_OPENING_SETUP", { serverPlayerId: players.A[0], receiverPlayerId: players.B[0], logicalCourts: null } as MatchCommand["payload"]), nc.controlToken);
      // 奇数轮先发 n，避免总是 m 先到。
      const [a, b] = round % 2 === 0 ? await Promise.all([runM(), runN()]) : await Promise.all([runN(), runM()]).then(([y, x]) => [x, y]);
      const key = `m=${a.status}/${a.code ?? "-"} | n=${b.status}/${b.code ?? "-"}`;
      tally[key] = (tally[key] ?? 0) + 1;
      note("R3-RACE-round", round, key);
      const onCourt = await prisma.match.count({ where: { courtId: c1.id, lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] } } });
      expect(onCourt).toBe(1);
      expect([a.status, b.status].filter((s) => s === "accepted")).toHaveLength(1);
      expect([a.status, b.status].every((s) => s === "accepted" || s === "409")).toBe(true);
    }
    note("R3-RACE", tally);
  }, 300_000);
});

describe("复判第三轮 RV2-03：执裁时间线", () => {
  async function legacy(name: string) {
    const { matches } = await roundRobin(name, 3);
    const match = matches[0];
    const device = randomUUID();
    const first = await acquireScoringSession(refereeId, match.code, device, "占位");
    // 探针写入：模拟 B2 上线前未登记姓名的会话。
    await prisma.scoringSession.update({ where: { id: first.sessionId }, data: { officiatingName: null } });
    return { match, device };
  }
  const line = async (id: string) => (await loadOfficiatingRecords(prisma, [id])).get(id)!.actual.map((entry) => `${entry.kind}:${entry.name}`);
  const expire = (id: string) => prisma.scoringSession.updateMany({ where: { matchId: id, status: "ACTIVE" }, data: { expiresAt: new Date(Date.now() - 1000) } });

  it("旧会话补名后再交接：未登记 → 甲（交接）→ 乙（交接）", async () => {
    const { match, device } = await legacy("tl-a");
    await acquireScoringSession(refereeId, match.code, device, "甲");
    await acquireScoringSession(refereeId, match.code, device, "乙");
    const actual = await line(match.id);
    note("R3-TL-A", actual);
    expect(actual).toEqual(["ACQUIRED:共用账号（未登记姓名）", "HANDOVER:甲", "HANDOVER:乙"]);
  });

  it("旧会话从未补名、过期后另一设备取得控制：未登记 → 丙", async () => {
    const { match } = await legacy("tl-b");
    await expire(match.id);
    await acquireScoringSession(refereeId, match.code, randomUUID(), "丙");
    const actual = await line(match.id);
    note("R3-TL-B", actual);
    expect(actual).toEqual(["ACQUIRED:共用账号（未登记姓名）", "ACQUIRED:丙"]);
  });

  it("旧会话补名 → 裁判长接管 → 过期后原设备再取得控制（新会话）：交接只归属第一段会话", async () => {
    const { match, device } = await legacy("tl-c");
    await acquireScoringSession(refereeId, match.code, device, "甲");
    await takeoverScoringSession(adminId, match.code, randomUUID(), "失联");
    await expire(match.id);
    await acquireScoringSession(refereeId, match.code, device, "丁");
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { name: true } });
    const actual = await line(match.id);
    note("R3-TL-C", actual);
    expect(actual).toEqual(["ACQUIRED:共用账号（未登记姓名）", "HANDOVER:甲", `TAKEOVER:${admin.name}（裁判长接管）`, "ACQUIRED:丁"]);
  });

  it("回归：正常登记姓名的会话不受影响：甲 → 乙（交接）", async () => {
    const { matches } = await roundRobin("tl-d", 3);
    const device = randomUUID();
    await acquireScoringSession(refereeId, matches[0].code, device, "甲");
    await acquireScoringSession(refereeId, matches[0].code, device, "乙");
    expect(await line(matches[0].id)).toEqual(["ACQUIRED:甲", "HANDOVER:乙"]);
  });
});

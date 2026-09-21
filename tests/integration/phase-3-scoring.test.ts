import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand, MatchState, ScoreStateReplacement } from "@/domain/rules/match-engine";
import { AppError } from "@/server/services/errors";
import { getAuthoritativeMatchState } from "@/server/services/match-state-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import {
  acquireScoringSession,
  heartbeatScoringSession,
  takeoverScoringSession,
} from "@/server/services/scoring-session-service";

// Keep this suite isolated from authorization.test.ts, which deliberately
// mutates the single-match control sessions in parallel Vitest workers.
const MATCH_CODE = "MD-DEMO-002";
let refereeId: string;
let chiefId: string;
let matchId: string;
let sequence = 0;

function command(
  control: { sessionId: string; takeoverGeneration: number },
  expectedVersion: number,
  type: MatchCommand["type"],
  payload: MatchCommand["payload"],
  commandId?: string,
): ScoringCommandEnvelope {
  sequence += 1;
  return {
    commandId: commandId ?? `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    occurredAt: `2026-09-19T06:${String(sequence % 60).padStart(2, "0")}:00.000Z`,
    expectedVersion,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type,
    payload,
  } as ScoringCommandEnvelope;
}

async function resetMatch() {
  await prisma.matchEvent.deleteMany({ where: { matchId } });
  await prisma.matchSnapshot.deleteMany({ where: { matchId } });
  await prisma.resultRevision.deleteMany({ where: { matchId } });
  await prisma.scoringSession.deleteMany({ where: { matchId } });
  await prisma.auditLog.deleteMany({ where: { targetId: matchId } });
  await prisma.game.updateMany({ where: { matchId }, data: { scoreA: 0, scoreB: 0, completed: false } });
  await prisma.match.update({
    where: { id: matchId },
    data: {
      version: 0,
      controlGeneration: 1,
      lifecycleStatus: "READY",
      outcomeType: null,
      verificationStatus: "UNVERIFIED",
      startedAt: null,
      endedAt: null,
    },
  });
}

describe("阶段 3 权威记分事务", () => {
  beforeAll(async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL } })).id;
    chiefId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL } })).id;
    matchId = (await prisma.match.findUniqueOrThrow({ where: { code: MATCH_CODE } })).id;
    await resetMatch();
  });

  afterEach(resetMatch);

  it("首次读取锚定初始状态并保存哈希", async () => {
    const state = await getAuthoritativeMatchState(refereeId, MATCH_CODE);
    expect(state).toMatchObject({ status: "snapshot", version: 0, state: { phase: "AWAITING_COIN_TOSS" } });
    const snapshot = await prisma.matchSnapshot.findUniqueOrThrow({ where: { matchId } });
    expect(snapshot.initialStateHash).toHaveLength(64);
    expect(snapshot.stateHash).toBe(snapshot.initialStateHash);
  });

  it("同 ID 同内容只生效一次，异内容复用拒绝", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "31111111-1111-4111-8111-111111111111");
    const envelope = command(control, 0, "RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: "A",
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    });
    const first = await submitScoringCommand(refereeId, MATCH_CODE, envelope, control.controlToken);
    const duplicate = await submitScoringCommand(refereeId, MATCH_CODE, envelope, control.controlToken);
    expect(first).toMatchObject({ status: "accepted", version: 1 });
    expect(duplicate).toMatchObject({ status: "duplicate", version: 1 });
    await expect(submitScoringCommand(refereeId, MATCH_CODE, {
      ...envelope,
      payload: { valid: false, reason: "改写载荷" },
    }, control.controlToken)).rejects.toMatchObject({ code: "command_id_reused" } satisfies Partial<AppError>);
    await expect(prisma.matchEvent.count({ where: { matchId } })).resolves.toBe(1);
  });

  it("两个同版本并发命令仅一个成功", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "32222222-2222-4222-8222-222222222222");
    const commands = [
      command(control, 0, "RECORD_COIN_TOSS", { valid: false, reason: "硬币落地不清" }),
      command(control, 0, "RECORD_COIN_TOSS", { valid: false, reason: "硬币被遮挡" }),
    ];
    const results = await Promise.allSettled(commands.map((item) => submitScoringCommand(refereeId, MATCH_CODE, item, control.controlToken)));
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    await expect(prisma.matchEvent.count({ where: { matchId } })).resolves.toBe(1);
  });

  it("心跳续租，裁判长接管后旧设备不能写入", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "33333333-3333-4333-8333-333333333333");
    await expect(heartbeatScoringSession(
      refereeId,
      MATCH_CODE,
      control.sessionId,
      control.takeoverGeneration,
      control.controlToken,
    )).resolves.toMatchObject({ status: "renewed" });
    const chief = await takeoverScoringSession(chiefId, MATCH_CODE, "34444444-4444-4444-8444-444444444444", "主裁判设备故障");
    expect(chief.takeoverGeneration).toBeGreaterThan(control.takeoverGeneration);
    await expect(submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, 0, "RECORD_COIN_TOSS", { valid: false, reason: "旧设备恢复写入" }),
      control.controlToken,
    )).rejects.toMatchObject({ code: "not_controller" } satisfies Partial<AppError>);
  });

  it("主裁判提交特殊结果后由不同裁判长锁定并记录双方角色", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "35555555-5555-4555-8555-555555555555");
    let result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, 0, "RECORD_SPECIAL_OUTCOME", { type: "WO", winnerSide: "A", reason: "B 方未到" }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("特殊结果首次提交不应命中幂等分支。");
    result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, result.version, "SUBMIT_RESULT", { reason: "提交弃权事实" }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("结果首次提交不应命中幂等分支。");
    const chief = await takeoverScoringSession(chiefId, MATCH_CODE, "36666666-6666-4666-8666-666666666666", "复核结果");
    await submitScoringCommand(
      chiefId,
      MATCH_CODE,
      command(chief, result.version, "CONFIRM_RESULT", { reason: "裁判长复核通过" }),
      chief.controlToken,
    );
    const revision = await prisma.resultRevision.findFirstOrThrow({ where: { matchId }, orderBy: { revision: "desc" } });
    expect(revision).toMatchObject({
      status: "LOCKED",
      actorUserId: refereeId,
      submittedRole: "REFEREE",
      reviewedByUserId: chiefId,
      reviewedRole: "CHIEF_REFEREE",
    });
    await expect(prisma.match.findUniqueOrThrow({ where: { id: matchId } })).resolves.toMatchObject({
      verificationStatus: "LOCKED",
      outcomeType: "WO",
    });
  });

  it("S2-009 在数据库事务中作废特殊结果且保留两条事件", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "37777777-7777-4777-8777-777777777777");
    let result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, 0, "RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "A", reason: "B 方误记退赛" }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("首次特殊结果应被接受。");
    result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, result.version, "INVALIDATE_SPECIAL_OUTCOME", { reason: "现场核对后作废" }),
      control.controlToken,
    );
    expect(result).toMatchObject({ status: "accepted", state: { phase: "AWAITING_COIN_TOSS", specialOutcome: null } });
    await expect(prisma.matchEvent.count({ where: { matchId } })).resolves.toBe(2);
    await expect(prisma.match.findUniqueOrThrow({ where: { id: matchId } })).resolves.toMatchObject({ outcomeType: null, version: 2 });
  });

  it("S2-008 在数据库事务中区分保留与完成规则换边待办", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "37aaaaaa-7777-4777-8777-777777777777");
    let result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, 0, "RECORD_COIN_TOSS", {
        valid: true,
        winnerSide: "A",
        winnerChoice: { kind: "SERVICE", decision: "SERVE" },
        loserChoice: { kind: "END", end: "END_2" },
      }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("有效抛币不应命中幂等分支。");
    result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, result.version, "CONFIRM_OPENING_SETUP", {
        serverPlayerId: result.state.players.A[0],
        receiverPlayerId: result.state.players.B[0],
        logicalCourts: {
          A: { R: result.state.players.A[0], L: result.state.players.A[1] },
          B: { R: result.state.players.B[0], L: result.state.players.B[1] },
        },
      }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("开局设置不应命中幂等分支。");
    result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, result.version, "CORRECT_SCORE_STATE", {
        reason: "准备局末换边待办",
        replacement: {
          score: { A: 20, B: 0 },
          gamesWon: result.state.gamesWon,
          completedGames: result.state.completedGames,
          servingSide: "A",
          serverPlayerId: result.state.logicalCourts!.A.R,
          receiverPlayerId: result.state.logicalCourts!.B.R,
          logicalCourts: result.state.logicalCourts,
          pendingObligations: [],
          phase: "IN_PROGRESS",
        },
      }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("赛点准备不应命中幂等分支。");
    result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, result.version, "RALLY_WON", { side: "A" }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("局末得分不应命中幂等分支。");
    const changeEnds = result.state.pendingObligations.find((item) => item.type === "CHANGE_ENDS");
    expect(changeEnds).toBeDefined();

    result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, result.version, "CORRECT_PHYSICAL_ENDS", {
        reason: "只纠正原端位记录，现场尚未换边",
        physicalEnds: { A: "END_2", B: "END_1" },
        obligationRelationship: { obligationId: changeEnds!.id, action: "KEEP_PENDING" },
      }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("KEEP_PENDING 更正不应命中幂等分支。");
    expect(result.state).toMatchObject({ physicalEnds: { A: "END_2", B: "END_1" } });
    expect(result.state.pendingObligations).toContainEqual(expect.objectContaining({ id: changeEnds!.id }));

    result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, result.version, "CORRECT_PHYSICAL_ENDS", {
        reason: "现场现已完成规则换边",
        physicalEnds: { A: "END_2", B: "END_1" },
        obligationRelationship: { obligationId: changeEnds!.id, action: "FULFILL" },
      }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("FULFILL 更正不应命中幂等分支。");
    expect(result.state.physicalEnds).toEqual({ A: "END_2", B: "END_1" });
    expect(result.state.pendingObligations).not.toContainEqual(expect.objectContaining({ id: changeEnds!.id }));
    await expect(prisma.matchEvent.count({ where: { matchId } })).resolves.toBe(6);
    await expect(prisma.matchSnapshot.findUniqueOrThrow({ where: { matchId } })).resolves.toMatchObject({
      version: result.version,
    });
  });

  it("快照哈希被篡改时拒绝后续写入且不产生半事务", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "38888888-8888-4888-8888-888888888888");
    const first = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, 0, "RECORD_COIN_TOSS", { valid: false, reason: "首次抛币无效" }),
      control.controlToken,
    );
    if (first.status !== "accepted") throw new Error("首次命令应被接受。");
    await prisma.matchSnapshot.update({ where: { matchId }, data: { stateHash: "0".repeat(64) } });
    await expect(submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, first.version, "RECORD_COIN_TOSS", { valid: false, reason: "不应写入" }),
      control.controlToken,
    )).rejects.toMatchObject({ code: "authoritative_state_corrupted" } satisfies Partial<AppError>);
    await expect(prisma.matchEvent.count({ where: { matchId } })).resolves.toBe(1);
    await expect(prisma.match.findUniqueOrThrow({ where: { id: matchId } })).resolves.toMatchObject({ version: 1 });
  });

  it("轮询 unchanged 走快路径，但返回快照的读取仍完整重放并发现损坏", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "3c111111-1111-4111-8111-111111111111");
    const first = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, 0, "RECORD_COIN_TOSS", { valid: false, reason: "首次抛币无效" }),
      control.controlToken,
    );
    if (first.status !== "accepted") throw new Error("首次命令应被接受。");

    // 版本未变：不返回比赛状态，因此可以跳过全量重放，但版本、控制权和访问信息仍然正确。
    const unchanged = await getAuthoritativeMatchState(refereeId, MATCH_CODE, first.version);
    expect(unchanged).toMatchObject({ status: "unchanged", version: first.version });
    expect(unchanged.control).toMatchObject({ active: true, ownedByCurrentUser: true });
    expect("state" in unchanged).toBe(false);

    // 只要需要返回状态，就必须完整重放并校验哈希。
    await prisma.matchSnapshot.update({ where: { matchId }, data: { stateHash: "0".repeat(64) } });
    await expect(getAuthoritativeMatchState(refereeId, MATCH_CODE)).rejects.toMatchObject({
      code: "authoritative_state_corrupted",
    } satisfies Partial<AppError>);
    await expect(getAuthoritativeMatchState(refereeId, MATCH_CODE, first.version - 1)).rejects.toMatchObject({
      code: "authoritative_state_corrupted",
    } satisfies Partial<AppError>);
  });

  it("复核修订缺失时整个确认事务回滚", async () => {
    const control = await acquireScoringSession(refereeId, MATCH_CODE, "39999999-9999-4999-8999-999999999999");
    let result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, 0, "RECORD_SPECIAL_OUTCOME", { type: "WO", winnerSide: "A", reason: "B 方未到" }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("特殊结果应被接受。");
    result = await submitScoringCommand(
      refereeId,
      MATCH_CODE,
      command(control, result.version, "SUBMIT_RESULT", { reason: "提交复核" }),
      control.controlToken,
    );
    if (result.status !== "accepted") throw new Error("结果应被提交。");
    await prisma.resultRevision.deleteMany({ where: { matchId } });
    const chief = await takeoverScoringSession(chiefId, MATCH_CODE, "3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "故障回滚测试");
    await expect(submitScoringCommand(
      chiefId,
      MATCH_CODE,
      command(chief, result.version, "CONFIRM_RESULT", { reason: "不应局部锁定" }),
      chief.controlToken,
    )).rejects.toMatchObject({ code: "result_revision_missing" } satisfies Partial<AppError>);
    await expect(prisma.matchEvent.count({ where: { matchId } })).resolves.toBe(2);
    await expect(prisma.matchSnapshot.findUniqueOrThrow({ where: { matchId } })).resolves.toMatchObject({ version: 2 });
    await expect(prisma.match.findUniqueOrThrow({ where: { id: matchId } })).resolves.toMatchObject({ version: 2, verificationStatus: "PENDING_REVIEW" });
  });

  /**
   * R3-004 回归：实际结束时刻、提交时刻和复核时刻是三个不同事实。
   * 只伪造 Date，不伪造计时器，避免干扰数据库驱动的异步流程。
   */
  describe("R3-004 实际结束时间与提交/复核时间分离", () => {
    afterEach(() => { vi.useRealTimers(); });

    function replacement(state: MatchState, scoreA: number, scoreB: number): ScoreStateReplacement {
      const servingSide = state.servingSide!;
      const receivingSide = servingSide === "A" ? "B" : "A";
      const court = state.score[servingSide] % 2 === 0 ? "R" : "L";
      const serveCourt = (servingSide === "A" ? scoreA : scoreB) % 2 === 0 ? "R" : "L";
      void court;
      return {
        score: { A: scoreA, B: scoreB },
        gamesWon: state.gamesWon,
        completedGames: state.completedGames,
        servingSide,
        serverPlayerId: state.logicalCourts![servingSide][serveCourt],
        receiverPlayerId: state.logicalCourts![receivingSide][serveCourt],
        logicalCourts: state.logicalCourts,
        pendingObligations: [],
        phase: "IN_PROGRESS",
      };
    }

    /** 真实裁判设备靠心跳续租；受控时钟必须同样分段推进，不能凭空跳过租约。 */
    async function advanceTo(
      target: Date,
      holder: { userId: string; control: { sessionId: string; takeoverGeneration: number; controlToken: string } },
    ) {
      const step = 90 * 1000;
      while (Date.now() < target.getTime()) {
        vi.setSystemTime(new Date(Math.min(Date.now() + step, target.getTime())));
        await heartbeatScoringSession(
          holder.userId,
          MATCH_CODE,
          holder.control.sessionId,
          holder.control.takeoverGeneration,
          holder.control.controlToken,
        );
      }
    }

    async function matchRow() {
      return prisma.match.findUniqueOrThrow({
        where: { id: matchId },
        select: { startedAt: true, endedAt: true, lifecycleStatus: true, verificationStatus: true },
      });
    }

    it("10:00 结束、10:05 提交、10:10 复核后 endedAt 仍是 10:00", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-21T09:30:00.000Z"));
      const control = await acquireScoringSession(refereeId, MATCH_CODE, "3b111111-1111-4111-8111-111111111111");
      let result = await submitScoringCommand(refereeId, MATCH_CODE, command(control, 0, "RECORD_COIN_TOSS", {
        valid: true,
        winnerSide: "A",
        winnerChoice: { kind: "SERVICE", decision: "SERVE" },
        loserChoice: { kind: "END", end: "END_2" },
      }), control.controlToken);
      if (result.status !== "accepted") throw new Error("抛币不应命中幂等分支。");

      const startTime = new Date("2026-09-21T09:40:00.000Z");
      await advanceTo(startTime, { userId: refereeId, control });
      result = await submitScoringCommand(refereeId, MATCH_CODE, command(result.version === 1 ? control : control, result.version, "CONFIRM_OPENING_SETUP", {
        serverPlayerId: result.state.players.A[0],
        receiverPlayerId: result.state.players.B[0],
        logicalCourts: {
          A: { R: result.state.players.A[0], L: result.state.players.A[1] },
          B: { R: result.state.players.B[0], L: result.state.players.B[1] },
        },
      }), control.controlToken);
      if (result.status !== "accepted") throw new Error("首局设置不应命中幂等分支。");
      await expect(matchRow()).resolves.toMatchObject({ startedAt: startTime, endedAt: null, lifecycleStatus: "IN_PROGRESS" });

      // 三局两胜：先正常打完第一局，处理局间待办并设置第二局，再在受控时刻打完全场。
      for (const game of [1, 2] as const) {
        result = await submitScoringCommand(refereeId, MATCH_CODE, command(control, result.version, "CORRECT_SCORE_STATE", {
          reason: `推进第 ${game} 局到局末分`,
          replacement: replacement(result.state, 20, 19),
        }), control.controlToken);
        if (result.status !== "accepted") throw new Error("比分更正不应命中幂等分支。");
        if (game === 2) break;
        result = await submitScoringCommand(refereeId, MATCH_CODE, command(control, result.version, "RALLY_WON", { side: "A" }), control.controlToken);
        if (result.status !== "accepted") throw new Error("局末分不应命中幂等分支。");
        for (const obligation of result.state.pendingObligations) {
          result = await submitScoringCommand(refereeId, MATCH_CODE, command(
            control,
            result.version,
            obligation.type === "INTERVAL" ? "ACKNOWLEDGE_INTERVAL" : "CONFIRM_CHANGE_ENDS",
            { obligationId: obligation.id },
          ), control.controlToken);
          if (result.status !== "accepted") throw new Error("局间待办不应命中幂等分支。");
        }
        result = await submitScoringCommand(refereeId, MATCH_CODE, command(control, result.version, "CONFIRM_NEXT_GAME_SETUP", {
          serverPlayerId: result.state.players.A[0],
          receiverPlayerId: result.state.players.B[0],
          logicalCourts: {
            A: { R: result.state.players.A[0], L: result.state.players.A[1] },
            B: { R: result.state.players.B[0], L: result.state.players.B[1] },
          },
        }), control.controlToken);
        if (result.status !== "accepted") throw new Error("次局设置不应命中幂等分支。");
      }

      const endTime = new Date("2026-09-21T10:00:00.000Z");
      await advanceTo(endTime, { userId: refereeId, control });
      result = await submitScoringCommand(refereeId, MATCH_CODE, command(control, result.version, "RALLY_WON", { side: "A" }), control.controlToken);
      if (result.status !== "accepted") throw new Error("赛末分不应命中幂等分支。");
      expect(result.state.phase).toBe("MATCH_COMPLETE_PENDING_SUBMISSION");
      await expect(matchRow()).resolves.toMatchObject({ startedAt: startTime, endedAt: endTime, lifecycleStatus: "ENDED_PENDING_SUBMISSION" });

      const submitTime = new Date("2026-09-21T10:05:00.000Z");
      await advanceTo(submitTime, { userId: refereeId, control });
      result = await submitScoringCommand(refereeId, MATCH_CODE, command(control, result.version, "SUBMIT_RESULT", { reason: "主裁判提交本场结果" }), control.controlToken);
      if (result.status !== "accepted") throw new Error("结果提交不应命中幂等分支。");
      await expect(matchRow()).resolves.toMatchObject({ startedAt: startTime, endedAt: endTime, verificationStatus: "PENDING_REVIEW" });

      const reviewTime = new Date("2026-09-21T10:10:00.000Z");
      await advanceTo(reviewTime, { userId: refereeId, control });
      const chief = await takeoverScoringSession(chiefId, MATCH_CODE, "3b222222-2222-4222-8222-222222222222", "复核结果");
      result = await submitScoringCommand(chiefId, MATCH_CODE, command(chief, result.version, "CONFIRM_RESULT", { reason: "裁判长复核通过" }), chief.controlToken);
      if (result.status !== "accepted") throw new Error("结果复核不应命中幂等分支。");
      await expect(matchRow()).resolves.toMatchObject({ startedAt: startTime, endedAt: endTime, verificationStatus: "LOCKED" });

      // 提交与复核时刻独立记录在结果修订上，不挤占实际结束时刻。
      const revision = await prisma.resultRevision.findFirstOrThrow({ where: { matchId }, orderBy: { revision: "desc" } });
      expect(revision.createdAt).toEqual(submitTime);
      expect(revision.reviewedAt).toEqual(reviewTime);

      await advanceTo(new Date("2026-09-21T10:20:00.000Z"), { userId: chiefId, control: chief });
      await submitScoringCommand(chiefId, MATCH_CODE, command(chief, result.version, "REOPEN_RESULT", { reason: "发现记录疑点，退回更正" }), chief.controlToken);
      await expect(matchRow()).resolves.toMatchObject({ startedAt: startTime, endedAt: endTime });
    });

    it("误记特殊结果被作废后清除结束时间，未开赛的 WO 不伪造开赛时刻", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const recordTime = new Date("2026-09-21T11:00:00.000Z");
      vi.setSystemTime(recordTime);
      const control = await acquireScoringSession(refereeId, MATCH_CODE, "3b333333-3333-4333-8333-333333333333");
      let result = await submitScoringCommand(refereeId, MATCH_CODE, command(control, 0, "RECORD_SPECIAL_OUTCOME", {
        type: "WO", winnerSide: "A", reason: "B 方未到场",
      }), control.controlToken);
      if (result.status !== "accepted") throw new Error("特殊结果不应命中幂等分支。");
      await expect(matchRow()).resolves.toMatchObject({ startedAt: null, endedAt: recordTime });

      await advanceTo(new Date("2026-09-21T11:03:00.000Z"), { userId: refereeId, control });
      result = await submitScoringCommand(refereeId, MATCH_CODE, command(control, result.version, "INVALIDATE_SPECIAL_OUTCOME", {
        reason: "现场核实后作废误记",
      }), control.controlToken);
      if (result.status !== "accepted") throw new Error("作废不应命中幂等分支。");
      await expect(matchRow()).resolves.toMatchObject({ startedAt: null, endedAt: null, lifecycleStatus: "READY" });
    });
  });
});

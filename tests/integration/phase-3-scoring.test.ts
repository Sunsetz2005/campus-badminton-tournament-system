import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand } from "@/domain/rules/match-engine";
import { AppError } from "@/server/services/errors";
import { getAuthoritativeMatchState } from "@/server/services/match-state-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import {
  acquireScoringSession,
  heartbeatScoringSession,
  takeoverScoringSession,
} from "@/server/services/scoring-session-service";

const MATCH_CODE = "MS-DEMO-001";
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
});

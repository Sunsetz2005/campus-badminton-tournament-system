/**
 * 量测 getAuthoritativeMatchState 的行锁 + 全量重放成本随事件数增长的变化。
 * 只连接隔离测试库，不做任何删除以外的破坏性操作（删除范围限于本脚本自己的比赛记录）。
 */
import { prisma } from "../src/db/client";
import { assertTestDatabaseUrl } from "../src/db/database-safety";
import type { MatchCommand } from "../src/domain/rules/match-engine";
import { getAuthoritativeMatchState } from "../src/server/services/match-state-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "../src/server/services/scoring-command-service";
import { acquireScoringSession, heartbeatScoringSession } from "../src/server/services/scoring-session-service";

const MATCH_CODE = "MD-DEMO-002";
let sequence = 0;

function envelope(control: { sessionId: string; takeoverGeneration: number }, expectedVersion: number, type: MatchCommand["type"], payload: unknown): ScoringCommandEnvelope {
  sequence += 1;
  return {
    commandId: `90000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    occurredAt: new Date().toISOString(),
    expectedVersion,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type,
    payload,
  } as ScoringCommandEnvelope;
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function main() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const match = await prisma.match.findUniqueOrThrow({ where: { code: MATCH_CODE }, select: { id: true } });
  const referee = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL } });
  await prisma.matchEvent.deleteMany({ where: { matchId: match.id } });
  await prisma.matchSnapshot.deleteMany({ where: { matchId: match.id } });
  await prisma.resultRevision.deleteMany({ where: { matchId: match.id } });
  await prisma.scoringSession.deleteMany({ where: { matchId: match.id } });
  await prisma.auditLog.deleteMany({ where: { targetId: match.id } });
  await prisma.match.update({
    where: { id: match.id },
    data: { version: 0, controlGeneration: 1, lifecycleStatus: "READY", outcomeType: null, verificationStatus: "UNVERIFIED", startedAt: null, endedAt: null },
  });

  const control = await acquireScoringSession(referee.id, MATCH_CODE, "99999999-9999-4999-8999-999999999999");
  let result = await submitScoringCommand(referee.id, MATCH_CODE, envelope(control, 0, "RECORD_COIN_TOSS", {
    valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" },
  }), control.controlToken);
  if (result.status !== "accepted") throw new Error("setup failed");
  result = await submitScoringCommand(referee.id, MATCH_CODE, envelope(control, result.version, "CONFIRM_OPENING_SETUP", {
    serverPlayerId: result.state.players.A[0], receiverPlayerId: result.state.players.B[0],
    logicalCourts: { A: { R: result.state.players.A[0], L: result.state.players.A[1] }, B: { R: result.state.players.B[0], L: result.state.players.B[1] } },
  }), control.controlToken);
  if (result.status !== "accepted") throw new Error("setup failed");

  const rows: Array<Record<string, number | string>> = [];
  const checkpoints = new Set([2, 20, 40, 60, 80, 100]);
  let side: "A" | "B" = "A";
  for (let version = result.version; version <= 100; ) {
    if (checkpoints.has(version)) {
      const reads: number[] = [];
      for (let index = 0; index < 12; index += 1) {
        const started = process.hrtime.bigint();
        await getAuthoritativeMatchState(referee.id, MATCH_CODE);
        reads.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      const unchangedReads: number[] = [];
      for (let index = 0; index < 12; index += 1) {
        const started = process.hrtime.bigint();
        await getAuthoritativeMatchState(referee.id, MATCH_CODE, version);
        unchangedReads.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      rows.push({
        事件数: version,
        "读取快照 p50(ms)": Number(percentile(reads, 0.5).toFixed(1)),
        "读取快照 p95(ms)": Number(percentile(reads, 0.95).toFixed(1)),
        "轮询 unchanged p50(ms)": Number(percentile(unchangedReads, 0.5).toFixed(1)),
        "轮询 unchanged p95(ms)": Number(percentile(unchangedReads, 0.95).toFixed(1)),
      });
      console.log(JSON.stringify(rows.at(-1)));
    }
    await heartbeatScoringSession(referee.id, MATCH_CODE, control.sessionId, control.takeoverGeneration, control.controlToken);
    const started = process.hrtime.bigint();
    const next = await submitScoringCommand(referee.id, MATCH_CODE, envelope(control, version, "RALLY_WON", { side }), control.controlToken);
    const writeMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (next.status !== "accepted") throw new Error("write failed");
    // 处理阈值待办，保持比赛可继续进行。
    let current = next;
    for (const obligation of current.state.pendingObligations) {
      const acked = await submitScoringCommand(referee.id, MATCH_CODE, envelope(control, current.version,
        obligation.type === "INTERVAL" ? "ACKNOWLEDGE_INTERVAL" : "CONFIRM_CHANGE_ENDS", { obligationId: obligation.id }), control.controlToken);
      if (acked.status !== "accepted") throw new Error("obligation failed");
      current = acked;
    }
    if (checkpoints.has(version)) {
      const row = rows.at(-1)!;
      row["单次写入(ms)"] = Number(writeMs.toFixed(1));
    }
    if (current.state.phase === "AWAITING_NEXT_GAME_SETUP") {
      const nextGame = await submitScoringCommand(referee.id, MATCH_CODE, envelope(control, current.version, "CONFIRM_NEXT_GAME_SETUP", {
        serverPlayerId: current.state.players.A[0], receiverPlayerId: current.state.players.B[0],
        logicalCourts: { A: { R: current.state.players.A[0], L: current.state.players.A[1] }, B: { R: current.state.players.B[0], L: current.state.players.B[1] } },
      }), control.controlToken);
      if (nextGame.status !== "accepted") throw new Error("next game failed");
      current = nextGame;
    }
    version = current.version;
    side = side === "A" ? "B" : "A";
  }
  console.log("\n最终结果：");
  console.table(rows);
  await prisma.$disconnect();
}

main().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });

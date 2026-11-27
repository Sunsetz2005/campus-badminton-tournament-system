import { describe, expect, it } from "vitest";

import { parseScoringCommandRequest } from "@/server/services/scoring-command-schema";

const baseEnvelope = {
  commandId: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2026-09-20T00:00:00.000Z",
  expectedVersion: 3,
  scoringSessionId: "00000000-0000-4000-8000-000000000002",
  takeoverGeneration: 1,
  type: "CORRECT_PHYSICAL_ENDS",
};

function requestWith(payload: Record<string, unknown>) {
  return new Request("http://localhost/api/matches/M/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...baseEnvelope, payload }),
  });
}

describe("计分命令请求解析", () => {
  it("接受显式物理端待办关系", async () => {
    const envelope = await parseScoringCommandRequest(requestWith({
      reason: "现场仍未换边",
      physicalEnds: { A: "END_2", B: "END_1" },
      obligationRelationship: { obligationId: "change-ends:1:11", action: "KEEP_PENDING" },
    }));

    expect(envelope.payload).toMatchObject({
      obligationRelationship: { obligationId: "change-ends:1:11", action: "KEEP_PENDING" },
    });
  });

  it("拒绝通过 HTTP 新提交历史兼容字段", async () => {
    await expect(parseScoringCommandRequest(requestWith({
      reason: "不得用旧字段提交新命令",
      physicalEnds: { A: "END_2", B: "END_1" },
      fulfillsObligationId: "change-ends:1:11",
    }))).rejects.toMatchObject({
      status: 400,
      code: "legacy_command_field_not_allowed",
    });
  });

  it("拒绝不带待办推导版本的新比分更正", async () => {
    const request = new Request("http://localhost/api/matches/M/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseEnvelope, type: "CORRECT_SCORE_STATE", payload: { reason: "误记", replacement: {} } }),
    });
    await expect(parseScoringCommandRequest(request)).rejects.toMatchObject({
      status: 400,
      code: "score_correction_model_required",
    });
  });
});

function request(type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/matches/M-1/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId: "7b0d5d2e-6a3f-4c1e-9d55-0c5a1e1f0a01",
      occurredAt: "2026-11-10T03:00:00.000Z",
      expectedVersion: 3,
      scoringSessionId: "7b0d5d2e-6a3f-4c1e-9d55-0c5a1e1f0a02",
      takeoverGeneration: 1,
      type,
      payload,
      ...extra,
    }),
  });
}

describe("记分命令载荷校验", () => {
  it("接受工作台实际发送的形状", async () => {
    await expect(parseScoringCommandRequest(request("RALLY_WON", { side: "A" }))).resolves.toMatchObject({ type: "RALLY_WON", payload: { side: "A" } });
    await expect(
      parseScoringCommandRequest(request("CONFIRM_OPENING_SETUP", { serverPlayerId: "p1", receiverPlayerId: "p2", logicalCourts: null })),
    ).resolves.toMatchObject({ payload: { logicalCourts: null } });
    await expect(
      parseScoringCommandRequest(request("RECORD_SPECIAL_OUTCOME", { type: "ABANDONED", reason: "停电" })),
    ).resolves.toMatchObject({ payload: { type: "ABANDONED", reason: "停电" } });
    await expect(
      parseScoringCommandRequest(
        request("RECORD_COIN_TOSS", {
          valid: true,
          winnerSide: "B",
          winnerChoice: { kind: "END", end: "END_2" },
          loserChoice: { kind: "SERVICE", decision: "RECEIVE" },
        }),
      ),
    ).resolves.toMatchObject({ payload: { winnerSide: "B" } });
  });

  it("拒绝不在枚举内的场地端、发球选择与比赛方", async () => {
    const invalid: [string, unknown][] = [
      ["CORRECT_PHYSICAL_ENDS", { reason: "核对", physicalEnds: { A: "foo", B: "bar" } }],
      ["RALLY_WON", { side: "C" }],
      ["RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "MAYBE" }, loserChoice: { kind: "END", end: "END_1" } }],
      ["RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_3" } }],
      ["PAUSE_MATCH", { reason: "x".repeat(501) }],
      ["CONFIRM_CHANGE_ENDS", {}],
    ];
    for (const [type, payload] of invalid) {
      await expect(parseScoringCommandRequest(request(type, payload)), type).rejects.toMatchObject({ status: 400, code: "invalid_command_payload" });
    }
  });

  it("未列出的字段不进入命令", async () => {
    const parsed = await parseScoringCommandRequest(request("RALLY_WON", { side: "B", junk: "z".repeat(200), nested: { a: 1 } }));
    expect(parsed.payload).toEqual({ side: "B" });
  });

  it("未知命令类型不携带载荷，交给引擎回答", async () => {
    const parsed = await parseScoringCommandRequest(request("DROP_TABLE", { anything: "z".repeat(100) }));
    expect(parsed.payload).toEqual({});
  });

  it("保留历史字段与更正版本的专用错误码", async () => {
    await expect(
      parseScoringCommandRequest(request("CORRECT_PHYSICAL_ENDS", { reason: "r", physicalEnds: { A: "END_1", B: "END_2" }, fulfillsObligationId: "x" })),
    ).rejects.toMatchObject({ code: "legacy_command_field_not_allowed" });
    await expect(parseScoringCommandRequest(request("CORRECT_SCORE_STATE", { reason: "r" }))).rejects.toMatchObject({ code: "score_correction_model_required" });
  });

  it("超过 16 KiB 的请求体直接拒绝", async () => {
    await expect(parseScoringCommandRequest(request("PAUSE_MATCH", { reason: "r" }, { padding: "z".repeat(17 * 1024) }))).rejects.toMatchObject({ status: 413 });
  });
});

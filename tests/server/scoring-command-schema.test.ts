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
});

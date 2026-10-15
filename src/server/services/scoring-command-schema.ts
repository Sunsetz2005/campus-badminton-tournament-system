import { z } from "zod";

import { SCORE_CORRECTION_OBLIGATION_MODEL, type MatchCommand } from "@/domain/rules/match-engine";
import type { ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { AppError } from "@/server/services/errors";

const schema = z.object({
  commandId: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  expectedVersion: z.number().int().nonnegative(),
  scoringSessionId: z.string().uuid(),
  takeoverGeneration: z.number().int().positive(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export async function parseScoringCommandRequest(request: Request): Promise<ScoringCommandEnvelope> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "invalid_request", "比赛命令信封无效。");
  if (
    parsed.data.type === "CORRECT_PHYSICAL_ENDS" &&
    Object.prototype.hasOwnProperty.call(parsed.data.payload, "fulfillsObligationId")
  ) {
    throw new AppError(
      400,
      "legacy_command_field_not_allowed",
      "新命令必须使用 obligationRelationship；旧字段仅用于历史事件重放。",
    );
  }
  if (
    parsed.data.type === "CORRECT_SCORE_STATE" &&
    parsed.data.payload.obligationModel !== SCORE_CORRECTION_OBLIGATION_MODEL
  ) {
    throw new AppError(
      400,
      "score_correction_model_required",
      "新的比分更正命令必须按当前待办推导版本提交；缺省版本仅用于历史事件重放。",
    );
  }
  return {
    ...parsed.data,
    type: parsed.data.type as MatchCommand["type"],
    payload: parsed.data.payload as MatchCommand["payload"],
  };
}

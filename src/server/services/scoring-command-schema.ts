import { z } from "zod";

import type { MatchCommand } from "@/domain/rules/match-engine";
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
  return {
    ...parsed.data,
    type: parsed.data.type as MatchCommand["type"],
    payload: parsed.data.payload as MatchCommand["payload"],
  };
}

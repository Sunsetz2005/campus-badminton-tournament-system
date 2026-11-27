import { z } from "zod";

import { SCORE_CORRECTION_OBLIGATION_MODEL, type MatchCommand } from "@/domain/rules/match-engine";
import type { ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { AppError } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";

/** 记分命令都是很小的 JSON；与全站其他写接口一样设请求体上限，避免超大载荷被写进事件并参与此后每次重放。 */
const MAX_COMMAND_BODY_BYTES = 16 * 1024;

const schema = z.object({
  commandId: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  expectedVersion: z.number().int().nonnegative(),
  scoringSessionId: z.string().uuid(),
  takeoverGeneration: z.number().int().positive(),
  type: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
});

/*
 * 各命令的载荷形状（只作用于新命令；已入库的历史事件照常重放，不经过这里）。
 * 引擎只校验与规则有关的部分，枚举值与字段类型在这里把关：此前 `physicalEnds: { A: "foo", B: "bar" }`
 * 这类载荷会被引擎接受并写进权威状态。未列出的字段一律丢弃，不进入事件。
 * 「原因是否为空」「球员是否属于本方」等规则判断仍由引擎回答，错误码不变。
 */
const side = z.enum(["A", "B"]);
const physicalEnd = z.enum(["END_1", "END_2"]);
const reason = z.string().max(500);
const playerId = z.string().min(1).max(64);
const obligationId = z.string().min(1).max(160);
const points = z.number().int().min(0).max(999);
const scorePair = z.object({ A: points, B: points });
const pairCourts = z.object({ R: playerId, L: playerId });
const logicalCourts = z.object({ A: pairCourts, B: pairCourts });
const coinChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SERVICE"), decision: z.enum(["SERVE", "RECEIVE"]) }),
  z.object({ kind: z.literal("END"), end: physicalEnd }),
]);
const reasonOnly = z.object({ reason });
const setup = z.object({ serverPlayerId: playerId, receiverPlayerId: playerId, logicalCourts: logicalCourts.nullable() });
const pendingObligation = z.object({
  id: obligationId,
  type: z.enum(["INTERVAL", "CHANGE_ENDS", "PHYSICAL_ENDS_REVIEW"]),
  gameNumber: z.number().int().min(1).max(99),
  triggerScore: scorePair,
  reason: z.string().max(500).optional(),
});

const PAYLOAD_SCHEMAS: Record<MatchCommand["type"], z.ZodType> = {
  RECORD_COIN_TOSS: z.discriminatedUnion("valid", [
    z.object({ valid: z.literal(false), reason }),
    z.object({ valid: z.literal(true), winnerSide: side, winnerChoice: coinChoice, loserChoice: coinChoice }),
  ]),
  INVALIDATE_COIN_TOSS: reasonOnly,
  CONFIRM_OPENING_SETUP: setup,
  CONFIRM_NEXT_GAME_SETUP: setup,
  RALLY_WON: z.object({ side }),
  LET: reasonOnly,
  ACKNOWLEDGE_INTERVAL: z.object({ obligationId }),
  CONFIRM_CHANGE_ENDS: z.object({ obligationId }),
  RECORD_MISSED_CHANGE_ENDS: z.object({ obligationId, reason }),
  CORRECT_PHYSICAL_ENDS: z.object({
    reason,
    physicalEnds: z.object({ A: physicalEnd, B: physicalEnd }),
    obligationRelationship: z.object({ obligationId, action: z.enum(["FULFILL", "KEEP_PENDING"]) }).optional(),
  }),
  CORRECT_LOGICAL_COURTS: z.object({ reason, logicalCourts }),
  CORRECT_SERVICE_ORDER: z.object({ reason, servingSide: side, serverPlayerId: playerId, receiverPlayerId: playerId }),
  CORRECT_SCORE_STATE: z.object({
    reason,
    obligationModel: z.literal(SCORE_CORRECTION_OBLIGATION_MODEL),
    replacement: z.object({
      score: scorePair,
      gamesWon: z.object({ A: z.number().int().min(0).max(99), B: z.number().int().min(0).max(99) }),
      completedGames: z
        .array(z.object({ number: z.number().int().min(1).max(99), scoreA: points, scoreB: points, winnerSide: side }))
        .max(9),
      servingSide: side,
      serverPlayerId: playerId,
      receiverPlayerId: playerId,
      logicalCourts: logicalCourts.nullable(),
      pendingObligations: z.array(pendingObligation).max(12),
      phase: z.enum(["IN_PROGRESS", "OBLIGATIONS_PENDING"]),
    }),
  }),
  UNDO_LAST_REVERSIBLE: reasonOnly,
  PAUSE_MATCH: reasonOnly,
  RESUME_MATCH: reasonOnly,
  // 类型是否允许在裁判台录入由 validateRefereeSpecialOutcome 回答（例如 BYE），这里只限定形状。
  RECORD_SPECIAL_OUTCOME: z.object({ type: z.string().min(1).max(20), winnerSide: side.nullish(), reason }),
  INVALIDATE_SPECIAL_OUTCOME: reasonOnly,
  VOID_MATCH_SCORING: reasonOnly,
  SUBMIT_RESULT: reasonOnly,
  CONFIRM_RESULT: reasonOnly,
  REOPEN_RESULT: reasonOnly,
};

function isKnownCommandType(type: string): type is MatchCommand["type"] {
  return Object.prototype.hasOwnProperty.call(PAYLOAD_SCHEMAS, type);
}

export async function parseScoringCommandRequest(request: Request): Promise<ScoringCommandEnvelope> {
  const parsed = schema.safeParse(await readJsonBody(request, MAX_COMMAND_BODY_BYTES));
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
  // 未知命令类型不带任何载荷交给引擎，由它照旧回答 unknown_command。
  let payload: unknown = {};
  if (isKnownCommandType(parsed.data.type)) {
    const checked = PAYLOAD_SCHEMAS[parsed.data.type].safeParse(parsed.data.payload);
    if (!checked.success) {
      const field = checked.error.issues[0]?.path.join(".") || "payload";
      throw new AppError(400, "invalid_command_payload", `比赛命令内容无效（${field}）。`);
    }
    payload = checked.data;
  }
  return {
    ...parsed.data,
    type: parsed.data.type as MatchCommand["type"],
    payload: payload as MatchCommand["payload"],
  };
}

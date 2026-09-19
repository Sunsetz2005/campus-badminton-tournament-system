import { hashRuleConfig, type RuleConfig, validateRuleConfig } from "./rule-profile";

export type Side = "A" | "B";
export type LogicalCourt = "R" | "L";
export type PhysicalEnd = "END_1" | "END_2";
export type MatchFormat = "SINGLES" | "DOUBLES";
export type MatchPhase =
  | "AWAITING_COIN_TOSS"
  | "AWAITING_OPENING_SETUP"
  | "IN_PROGRESS"
  | "OBLIGATIONS_PENDING"
  | "GAME_COMPLETE"
  | "AWAITING_NEXT_GAME_SETUP"
  | "MATCH_COMPLETE_PENDING_SUBMISSION"
  | "SPECIAL_OUTCOME_PENDING_SUBMISSION"
  | "PAUSED"
  | "SUBMITTED"
  | "CONFIRMED";

export type LogicalCourts = Record<Side, Record<LogicalCourt, string>>;
export type PhysicalEnds = Record<Side, PhysicalEnd>;

export interface PendingObligation {
  id: string;
  type: "INTERVAL" | "CHANGE_ENDS" | "PHYSICAL_ENDS_REVIEW";
  gameNumber: number;
  triggerScore: { A: number; B: number };
  reason?: string;
}

export interface CompletedGame {
  number: number;
  scoreA: number;
  scoreB: number;
  winnerSide: Side;
}

export interface CoinTossResult {
  winnerSide: Side;
  winnerChoice: ServiceChoice | EndChoice;
  loserChoice: ServiceChoice | EndChoice;
}

export interface SpecialOutcome {
  type: "WO" | "RET" | "DSQ" | "ABANDONED" | "BYE";
  winnerSide: Side | null;
  reason: string;
}

export interface MatchState {
  matchId: string;
  format: MatchFormat;
  players: Record<Side, string[]>;
  ruleConfig: RuleConfig;
  ruleConfigHash: string;
  phase: MatchPhase;
  version: number;
  coinToss: CoinTossResult | null;
  currentGame: number;
  score: { A: number; B: number };
  gamesWon: { A: number; B: number };
  completedGames: CompletedGame[];
  servingSide: Side | null;
  serverPlayerId: string | null;
  receiverPlayerId: string | null;
  serverCourt: LogicalCourt | null;
  receiverCourt: LogicalCourt | null;
  logicalCourts: LogicalCourts | null;
  physicalEnds: PhysicalEnds | null;
  pendingObligations: PendingObligation[];
  nextGameServingSide: Side | null;
  pausedFromPhase: MatchPhase | null;
  submittedFromPhase: MatchPhase | null;
  specialOutcome: SpecialOutcome | null;
}

interface CommandBase<T extends string, P> {
  commandId: string;
  occurredAt: string;
  type: T;
  payload: P;
}

interface ServiceChoice {
  kind: "SERVICE";
  decision: "SERVE" | "RECEIVE";
}

interface EndChoice {
  kind: "END";
  end: PhysicalEnd;
}

export interface ScoreStateReplacement {
  score: { A: number; B: number };
  gamesWon: { A: number; B: number };
  completedGames: CompletedGame[];
  servingSide: Side;
  serverPlayerId: string;
  receiverPlayerId: string;
  logicalCourts: LogicalCourts | null;
  pendingObligations: PendingObligation[];
  phase: "IN_PROGRESS" | "OBLIGATIONS_PENDING";
}

export type MatchCommand =
  | CommandBase<
      "RECORD_COIN_TOSS",
      | { valid: false; reason: string }
      | {
          valid: true;
          winnerSide: Side;
          winnerChoice: ServiceChoice | EndChoice;
          loserChoice: ServiceChoice | EndChoice;
        }
    >
  | CommandBase<"INVALIDATE_COIN_TOSS", { reason: string }>
  | CommandBase<
      "CONFIRM_OPENING_SETUP",
      { serverPlayerId: string; receiverPlayerId: string; logicalCourts: LogicalCourts | null }
    >
  | CommandBase<
      "CONFIRM_NEXT_GAME_SETUP",
      { serverPlayerId: string; receiverPlayerId: string; logicalCourts: LogicalCourts | null }
    >
  | CommandBase<"RALLY_WON", { side: Side }>
  | CommandBase<"LET", { reason: string }>
  | CommandBase<"ACKNOWLEDGE_INTERVAL", { obligationId: string }>
  | CommandBase<"CONFIRM_CHANGE_ENDS", { obligationId: string }>
  | CommandBase<"RECORD_MISSED_CHANGE_ENDS", { obligationId: string; reason: string }>
  | CommandBase<
      "CORRECT_PHYSICAL_ENDS",
      { reason: string; physicalEnds: PhysicalEnds; fulfillsObligationId?: string }
    >
  | CommandBase<"CORRECT_LOGICAL_COURTS", { reason: string; logicalCourts: LogicalCourts }>
  | CommandBase<
      "CORRECT_SERVICE_ORDER",
      { reason: string; servingSide: Side; serverPlayerId: string; receiverPlayerId: string }
    >
  | CommandBase<"CORRECT_SCORE_STATE", { reason: string; replacement: ScoreStateReplacement }>
  | CommandBase<"UNDO_LAST_REVERSIBLE", { reason: string }>
  | CommandBase<"PAUSE_MATCH", { reason: string }>
  | CommandBase<"RESUME_MATCH", { reason: string }>
  | CommandBase<
      "RECORD_SPECIAL_OUTCOME",
      { type: SpecialOutcome["type"]; winnerSide?: Side; reason: string }
    >
  | CommandBase<"INVALIDATE_SPECIAL_OUTCOME", { reason: string }>
  | CommandBase<"SUBMIT_RESULT", { reason: string }>
  | CommandBase<"CONFIRM_RESULT", { reason: string }>
  | CommandBase<"REOPEN_RESULT", { reason: string }>;

export interface MatchEvent {
  eventId: string;
  version: number;
  commandId: string;
  commandFingerprint: string;
  occurredAt: string;
  type: MatchCommand["type"];
  payload: MatchCommand["payload"];
  reversible: boolean;
  stateBefore: MatchState;
  stateAfter: MatchState;
  metadata?: { undoneCommandId?: string; invalidatedCommandId?: string };
}

export interface MatchAggregate {
  initialState: MatchState;
  state: MatchState;
  events: MatchEvent[];
}

export type ApplyCommandResult =
  | { status: "accepted"; aggregate: MatchAggregate; events: MatchEvent[] }
  | { status: "duplicate"; aggregate: MatchAggregate; events: MatchEvent[] }
  | { status: "rejected"; aggregate: MatchAggregate; error: { code: string; message: string } };

export interface CreateMatchInput {
  matchId: string;
  format: MatchFormat;
  players: Record<Side, string[]>;
  ruleConfig: RuleConfig;
  ruleConfigHash: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SPECIAL_OUTCOMES = new Set<SpecialOutcome["type"]>(["WO", "RET", "DSQ", "ABANDONED", "BYE"]);

class RuleViolation extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function opposite(side: Side): Side {
  return side === "A" ? "B" : "A";
}

function oppositeEnd(end: PhysicalEnd): PhysicalEnd {
  return end === "END_1" ? "END_2" : "END_1";
}

function courtForScore(score: number): LogicalCourt {
  return score % 2 === 0 ? "R" : "L";
}

function requireReason(reason: unknown) {
  if (typeof reason !== "string" || !reason.trim()) throw new RuleViolation("reason_required", "必须填写原因。");
}

function assertSide(side: unknown): asserts side is Side {
  if (side !== "A" && side !== "B") throw new RuleViolation("invalid_side", "比赛方必须是 A 或 B。");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintMatchCommand(command: MatchCommand) {
  return stableStringify({ occurredAt: command.occurredAt, type: command.type, payload: command.payload });
}

function assertCommonCommand(command: MatchCommand) {
  if (!command || typeof command !== "object") throw new RuleViolation("invalid_command", "命令格式无效。");
  if (!UUID_PATTERN.test(command.commandId)) throw new RuleViolation("invalid_command_id", "commandId 必须是 UUID。");
  if (!command.occurredAt || Number.isNaN(Date.parse(command.occurredAt))) {
    throw new RuleViolation("invalid_occurred_at", "命令必须提供有效发生时间。");
  }
  if (!command.payload || typeof command.payload !== "object") {
    throw new RuleViolation("invalid_payload", "命令载荷无效。");
  }
}

function assertPlayers(state: MatchState, playerId: string, side: Side) {
  if (!state.players[side].includes(playerId)) {
    throw new RuleViolation("invalid_player", `${playerId} 不属于 Side ${side}。`);
  }
}

function assertLogicalCourts(state: MatchState, courts: LogicalCourts | null): asserts courts is LogicalCourts {
  if (state.format !== "DOUBLES") {
    if (courts !== null) throw new RuleViolation("singles_has_pair_courts", "单打不能提交双打 R/L 分配。");
    return;
  }
  if (!courts) throw new RuleViolation("logical_courts_required", "双打开局必须提供双方 R/L 分配。");
  for (const side of ["A", "B"] as const) {
    const assigned = [courts[side]?.R, courts[side]?.L];
    if (new Set(assigned).size !== 2 || !assigned.every((playerId) => state.players[side].includes(playerId))) {
      throw new RuleViolation("invalid_logical_courts", `Side ${side} 的 R/L 分配必须恰好包含本方两名球员。`);
    }
  }
}

function setServiceOrder(
  state: MatchState,
  servingSide: Side,
  serverPlayerId?: string,
  receiverPlayerId?: string,
) {
  const receivingSide = opposite(servingSide);
  const serviceCourt = courtForScore(state.score[servingSide]);
  const expectedServer =
    state.format === "DOUBLES" ? state.logicalCourts![servingSide][serviceCourt] : state.players[servingSide][0];
  const expectedReceiver =
    state.format === "DOUBLES" ? state.logicalCourts![receivingSide][serviceCourt] : state.players[receivingSide][0];
  if (serverPlayerId && serverPlayerId !== expectedServer) {
    throw new RuleViolation("server_court_mismatch", "发球员与当前比分奇偶及 R/L 分配不一致。");
  }
  if (receiverPlayerId && receiverPlayerId !== expectedReceiver) {
    throw new RuleViolation("receiver_court_mismatch", "接发球员不在发球员对角的逻辑发球区。");
  }
  state.servingSide = servingSide;
  state.serverPlayerId = expectedServer;
  state.receiverPlayerId = expectedReceiver;
  state.serverCourt = serviceCourt;
  state.receiverCourt = serviceCourt;
}

function swapLogicalCourts(state: MatchState, side: Side) {
  if (state.format !== "DOUBLES") return;
  const current = state.logicalCourts![side];
  state.logicalCourts![side] = { R: current.L, L: current.R };
}

function addObligation(state: MatchState, obligation: PendingObligation) {
  if (!state.pendingObligations.some((item) => item.id === obligation.id)) state.pendingObligations.push(obligation);
}

function finishObligationPhase(state: MatchState) {
  if (state.pendingObligations.length > 0) return;
  if (state.phase === "OBLIGATIONS_PENDING") state.phase = "IN_PROGRESS";
  if (state.phase === "GAME_COMPLETE") state.phase = "AWAITING_NEXT_GAME_SETUP";
}

function removeObligation(state: MatchState, obligationId: string, type: PendingObligation["type"]) {
  const pending = state.pendingObligations.find((item) => item.id === obligationId);
  if (!pending || pending.type !== type) throw new RuleViolation("obligation_not_found", "待确认事项不存在或类型不匹配。");
  state.pendingObligations = state.pendingObligations.filter((item) => item.id !== obligationId);
  finishObligationPhase(state);
}

function gameIsWon(scoreA: number, scoreB: number, config: RuleConfig) {
  const high = Math.max(scoreA, scoreB);
  const low = Math.min(scoreA, scoreB);
  if (high >= config.capPoints) return true;
  return high >= config.targetPoints && high - low >= config.winBy;
}

function sameValue(left: unknown, right: unknown) {
  return stableStringify(left) === stableStringify(right);
}

function winsNeeded(config: RuleConfig) {
  return Math.floor(config.bestOf / 2) + 1;
}

function phaseAllowsScoring(state: MatchState) {
  if (state.phase !== "IN_PROGRESS") throw new RuleViolation("match_not_scoring", "当前比赛状态不能记录回合结果。");
}

function assertResultUnlocked(state: MatchState) {
  if (state.phase === "SUBMITTED" || state.phase === "CONFIRMED") {
    throw new RuleViolation("result_locked", "已提交或确认的结果必须先受控重开，不能直接更正。");
  }
}

function assertScoreCorrectionAllowed(state: MatchState) {
  assertResultUnlocked(state);
  if (
    state.phase !== "IN_PROGRESS" &&
    state.phase !== "OBLIGATIONS_PENDING" &&
    state.phase !== "GAME_COMPLETE" &&
    state.phase !== "MATCH_COMPLETE_PENDING_SUBMISSION"
  ) {
    throw new RuleViolation("score_correction_not_allowed", "当前比赛状态不能执行完整比分更正。");
  }
}

function deriveCoinToss(payload: Extract<MatchCommand, { type: "RECORD_COIN_TOSS" }>["payload"]) {
  if (!payload.valid) {
    requireReason(payload.reason);
    return null;
  }
  assertSide(payload.winnerSide);
  if (payload.winnerChoice.kind === payload.loserChoice.kind) {
    throw new RuleViolation("coin_toss_choice_conflict", "抛币胜负双方必须选择不同维度。");
  }
  const loserSide = opposite(payload.winnerSide);
  let serviceChoice: ServiceChoice;
  let serviceChooser: Side;
  let endChoice: EndChoice;
  let endChooser: Side;
  if (payload.winnerChoice.kind === "SERVICE" && payload.loserChoice.kind === "END") {
    serviceChoice = payload.winnerChoice;
    serviceChooser = payload.winnerSide;
    endChoice = payload.loserChoice;
    endChooser = loserSide;
  } else if (payload.winnerChoice.kind === "END" && payload.loserChoice.kind === "SERVICE") {
    serviceChoice = payload.loserChoice;
    serviceChooser = loserSide;
    endChoice = payload.winnerChoice;
    endChooser = payload.winnerSide;
  } else {
    throw new RuleViolation("coin_toss_choice_conflict", "抛币选择组合无效。");
  }
  const servingSide = serviceChoice.decision === "SERVE" ? serviceChooser : opposite(serviceChooser);
  return {
    result: {
      winnerSide: payload.winnerSide,
      winnerChoice: clone(payload.winnerChoice),
      loserChoice: clone(payload.loserChoice),
    } satisfies CoinTossResult,
    servingSide,
    physicalEnds: {
      [endChooser]: endChoice.end,
      [opposite(endChooser)]: oppositeEnd(endChoice.end),
    } as PhysicalEnds,
  };
}

function confirmSetup(
  state: MatchState,
  payload: Extract<MatchCommand, { type: "CONFIRM_OPENING_SETUP" | "CONFIRM_NEXT_GAME_SETUP" }>["payload"],
  servingSide: Side,
) {
  assertLogicalCourts(state, payload.logicalCourts);
  state.logicalCourts = payload.logicalCourts ? clone(payload.logicalCourts) : null;
  state.score = { A: 0, B: 0 };
  setServiceOrder(state, servingSide, payload.serverPlayerId, payload.receiverPlayerId);
  state.pendingObligations = [];
  state.phase = "IN_PROGRESS";
}

function applyRally(state: MatchState, winner: Side) {
  phaseAllowsScoring(state);
  assertSide(winner);
  const previousServingSide = state.servingSide!;
  state.score[winner] += 1;
  if (winner === previousServingSide) swapLogicalCourts(state, winner);
  setServiceOrder(state, winner);

  const scoreA = state.score.A;
  const scoreB = state.score.B;
  if (gameIsWon(scoreA, scoreB, state.ruleConfig)) {
    state.completedGames.push({
      number: state.currentGame,
      scoreA,
      scoreB,
      winnerSide: winner,
    });
    state.gamesWon[winner] += 1;
    state.nextGameServingSide = winner;
    if (state.gamesWon[winner] >= winsNeeded(state.ruleConfig)) {
      state.phase = "MATCH_COMPLETE_PENDING_SUBMISSION";
      state.pendingObligations = [];
      return;
    }
    state.phase = "GAME_COMPLETE";
    addObligation(state, {
      id: `interval:game:${state.currentGame}:between`,
      type: "INTERVAL",
      gameNumber: state.currentGame,
      triggerScore: clone(state.score),
    });
    addObligation(state, {
      id: `change-ends:game:${state.currentGame}:end`,
      type: "CHANGE_ENDS",
      gameNumber: state.currentGame,
      triggerScore: clone(state.score),
    });
    return;
  }

  const thresholdReached = scoreA === state.ruleConfig.intervalAt || scoreB === state.ruleConfig.intervalAt;
  if (thresholdReached) {
    addObligation(state, {
      id: `interval:game:${state.currentGame}:threshold`,
      type: "INTERVAL",
      gameNumber: state.currentGame,
      triggerScore: clone(state.score),
    });
  }
  const decidingGame = state.ruleConfig.bestOf === 1 || state.currentGame === state.ruleConfig.bestOf;
  const changeEndsReached =
    scoreA === state.ruleConfig.decidingGameChangeEndsAt || scoreB === state.ruleConfig.decidingGameChangeEndsAt;
  if (decidingGame && changeEndsReached) {
    addObligation(state, {
      id: `change-ends:game:${state.currentGame}:threshold`,
      type: "CHANGE_ENDS",
      gameNumber: state.currentGame,
      triggerScore: clone(state.score),
    });
  }
  if (state.pendingObligations.length > 0) state.phase = "OBLIGATIONS_PENDING";
}

function applyReplacement(state: MatchState, replacement: ScoreStateReplacement) {
  if (!replacement || typeof replacement !== "object") {
    throw new RuleViolation("replacement_required", "比分更正必须提供完整替换状态。");
  }
  for (const value of [replacement.score.A, replacement.score.B, replacement.gamesWon.A, replacement.gamesWon.B]) {
    if (!Number.isInteger(value) || value < 0) throw new RuleViolation("invalid_score", "比分和胜局数必须为非负整数。");
  }
  if (replacement.score.A > state.ruleConfig.capPoints || replacement.score.B > state.ruleConfig.capPoints) {
    throw new RuleViolation("corrected_score_above_cap", "比分更正不能超过规则封顶分。");
  }
  if (gameIsWon(replacement.score.A, replacement.score.B, state.ruleConfig)) {
    throw new RuleViolation("corrected_game_already_won", "已构成胜局的比分不能标记为本局进行中。");
  }

  if (replacement.completedGames.length !== state.currentGame - 1) {
    throw new RuleViolation("corrected_games_inconsistent", "已完成局数必须与当前局号一致。");
  }
  const countedGamesWon = { A: 0, B: 0 };
  replacement.completedGames.forEach((game, index) => {
    const scores = [game.scoreA, game.scoreB];
    if (
      game.number !== index + 1 ||
      scores.some((score) => !Number.isInteger(score) || score < 0 || score > state.ruleConfig.capPoints) ||
      game.scoreA === game.scoreB ||
      !gameIsWon(game.scoreA, game.scoreB, state.ruleConfig)
    ) {
      throw new RuleViolation("corrected_games_inconsistent", "已完成局记录与冻结规则不一致。");
    }
    const winnerSide: Side = game.scoreA > game.scoreB ? "A" : "B";
    if (game.winnerSide !== winnerSide) {
      throw new RuleViolation("corrected_games_inconsistent", "已完成局胜方与局分不一致。");
    }
    countedGamesWon[winnerSide] += 1;
  });
  if (!sameValue(replacement.gamesWon, countedGamesWon)) {
    throw new RuleViolation("corrected_games_inconsistent", "胜局数必须由已完成局记录推导。");
  }
  if (countedGamesWon.A >= winsNeeded(state.ruleConfig) || countedGamesWon.B >= winsNeeded(state.ruleConfig)) {
    throw new RuleViolation("corrected_match_already_won", "已达到全场胜局数的比赛不能标记为进行中。");
  }

  const expectedObligations: PendingObligation[] = state.pendingObligations
    .filter((item) => item.type === "PHYSICAL_ENDS_REVIEW")
    .map(clone);
  const triggerScore = clone(replacement.score);
  if (replacement.score.A === state.ruleConfig.intervalAt || replacement.score.B === state.ruleConfig.intervalAt) {
    expectedObligations.push({
      id: `interval:game:${state.currentGame}:threshold`,
      type: "INTERVAL",
      gameNumber: state.currentGame,
      triggerScore,
    });
  }
  const decidingGame = state.ruleConfig.bestOf === 1 || state.currentGame === state.ruleConfig.bestOf;
  if (
    decidingGame &&
    (replacement.score.A === state.ruleConfig.decidingGameChangeEndsAt ||
      replacement.score.B === state.ruleConfig.decidingGameChangeEndsAt)
  ) {
    expectedObligations.push({
      id: `change-ends:game:${state.currentGame}:threshold`,
      type: "CHANGE_ENDS",
      gameNumber: state.currentGame,
      triggerScore,
    });
  }
  const sortedObligations = (items: PendingObligation[]) => [...items].sort((left, right) => left.id.localeCompare(right.id));
  const expectedPhase = expectedObligations.length > 0 ? "OBLIGATIONS_PENDING" : "IN_PROGRESS";
  if (
    replacement.phase !== expectedPhase ||
    !sameValue(sortedObligations(replacement.pendingObligations), sortedObligations(expectedObligations))
  ) {
    throw new RuleViolation("corrected_obligations_inconsistent", "比分更正后的间歇、换边义务或比赛阶段不一致。");
  }
  assertSide(replacement.servingSide);
  assertLogicalCourts(state, replacement.logicalCourts);
  state.score = clone(replacement.score);
  state.gamesWon = clone(replacement.gamesWon);
  state.completedGames = clone(replacement.completedGames);
  state.logicalCourts = replacement.logicalCourts ? clone(replacement.logicalCourts) : null;
  state.pendingObligations = clone(replacement.pendingObligations);
  state.phase = replacement.phase;
  setServiceOrder(state, replacement.servingSide, replacement.serverPlayerId, replacement.receiverPlayerId);
}

function nextStateForCommand(state: MatchState, command: MatchCommand) {
  const next = clone(state);
  switch (command.type) {
    case "RECORD_COIN_TOSS": {
      if (next.phase !== "AWAITING_COIN_TOSS") throw new RuleViolation("coin_toss_already_recorded", "当前不能重新记录抛币。");
      const derived = deriveCoinToss(command.payload);
      if (!derived) return next;
      next.coinToss = derived.result;
      next.servingSide = derived.servingSide;
      next.physicalEnds = derived.physicalEnds;
      next.phase = "AWAITING_OPENING_SETUP";
      return next;
    }
    case "INVALIDATE_COIN_TOSS":
      requireReason(command.payload.reason);
      if (next.phase !== "AWAITING_OPENING_SETUP") {
        throw new RuleViolation("coin_toss_cannot_be_invalidated", "只有第一球前可以作废已确认抛币记录。");
      }
      next.coinToss = null;
      next.servingSide = null;
      next.physicalEnds = null;
      next.phase = "AWAITING_COIN_TOSS";
      return next;
    case "CONFIRM_OPENING_SETUP":
      if (next.phase !== "AWAITING_OPENING_SETUP" || !next.servingSide) {
        throw new RuleViolation("opening_setup_not_allowed", "必须先确认有效抛币结果。");
      }
      confirmSetup(next, command.payload, next.servingSide);
      return next;
    case "CONFIRM_NEXT_GAME_SETUP":
      if (next.phase !== "AWAITING_NEXT_GAME_SETUP" || !next.nextGameServingSide) {
        throw new RuleViolation("next_game_setup_not_allowed", "当前不能开始下一局。");
      }
      next.currentGame += 1;
      confirmSetup(next, command.payload, next.nextGameServingSide);
      return next;
    case "RALLY_WON":
      applyRally(next, command.payload.side);
      return next;
    case "LET":
      requireReason(command.payload.reason);
      phaseAllowsScoring(next);
      return next;
    case "ACKNOWLEDGE_INTERVAL":
      removeObligation(next, command.payload.obligationId, "INTERVAL");
      return next;
    case "CONFIRM_CHANGE_ENDS":
      if (!next.physicalEnds) throw new RuleViolation("physical_ends_missing", "尚未记录双方物理场地端。");
      removeObligation(next, command.payload.obligationId, "CHANGE_ENDS");
      next.physicalEnds = { A: next.physicalEnds.B, B: next.physicalEnds.A };
      return next;
    case "RECORD_MISSED_CHANGE_ENDS":
      requireReason(command.payload.reason);
      if (!next.physicalEnds) throw new RuleViolation("physical_ends_missing", "尚未记录双方物理场地端。");
      removeObligation(next, command.payload.obligationId, "CHANGE_ENDS");
      next.physicalEnds = { A: next.physicalEnds.B, B: next.physicalEnds.A };
      return next;
    case "CORRECT_PHYSICAL_ENDS":
      assertResultUnlocked(next);
      requireReason(command.payload.reason);
      if (command.payload.physicalEnds.A === command.payload.physicalEnds.B) {
        throw new RuleViolation("invalid_physical_ends", "双方不能占据同一物理场地端。");
      }
      const pendingChangeEnds = next.pendingObligations.filter((item) => item.type === "CHANGE_ENDS");
      if (pendingChangeEnds.length > 0 && !command.payload.fulfillsObligationId) {
        throw new RuleViolation(
          "change_ends_relationship_required",
          "存在未处理的规则换边义务，物理端更正必须明确是否同时完成该义务。",
        );
      }
      if (command.payload.fulfillsObligationId) {
        const allowedType = pendingChangeEnds.length > 0 ? "CHANGE_ENDS" : "PHYSICAL_ENDS_REVIEW";
        const obligation = next.pendingObligations.find(
          (item) => item.id === command.payload.fulfillsObligationId && item.type === allowedType,
        );
        if (!obligation) throw new RuleViolation("obligation_not_found", "物理场地核对事项不存在。");
        next.pendingObligations = next.pendingObligations.filter((item) => item.id !== obligation.id);
        finishObligationPhase(next);
      }
      next.physicalEnds = clone(command.payload.physicalEnds);
      return next;
    case "CORRECT_LOGICAL_COURTS":
      assertResultUnlocked(next);
      requireReason(command.payload.reason);
      assertLogicalCourts(next, command.payload.logicalCourts);
      next.logicalCourts = clone(command.payload.logicalCourts);
      if (!next.servingSide) throw new RuleViolation("service_order_missing", "尚未建立发接发顺序。");
      setServiceOrder(next, next.servingSide);
      return next;
    case "CORRECT_SERVICE_ORDER":
      assertResultUnlocked(next);
      requireReason(command.payload.reason);
      assertSide(command.payload.servingSide);
      assertPlayers(next, command.payload.serverPlayerId, command.payload.servingSide);
      assertPlayers(next, command.payload.receiverPlayerId, opposite(command.payload.servingSide));
      setServiceOrder(
        next,
        command.payload.servingSide,
        command.payload.serverPlayerId,
        command.payload.receiverPlayerId,
      );
      return next;
    case "CORRECT_SCORE_STATE":
      assertScoreCorrectionAllowed(next);
      requireReason(command.payload.reason);
      applyReplacement(next, command.payload.replacement);
      return next;
    case "PAUSE_MATCH":
      requireReason(command.payload.reason);
      if (next.phase !== "IN_PROGRESS" && next.phase !== "OBLIGATIONS_PENDING") {
        throw new RuleViolation("pause_not_allowed", "当前比赛状态不能暂停。");
      }
      next.pausedFromPhase = next.phase;
      next.phase = "PAUSED";
      return next;
    case "RESUME_MATCH":
      requireReason(command.payload.reason);
      if (next.phase !== "PAUSED" || !next.pausedFromPhase) {
        throw new RuleViolation("resume_not_allowed", "比赛当前未暂停。");
      }
      next.phase = next.pausedFromPhase;
      next.pausedFromPhase = null;
      return next;
    case "RECORD_SPECIAL_OUTCOME":
      requireReason(command.payload.reason);
      if (!SPECIAL_OUTCOMES.has(command.payload.type)) {
        throw new RuleViolation("invalid_special_outcome", "特殊结果类型无效。");
      }
      if (next.phase === "SUBMITTED" || next.phase === "CONFIRMED") {
        throw new RuleViolation("result_locked", "已提交或确认的结果不能直接改写。");
      }
      if (next.phase === "SPECIAL_OUTCOME_PENDING_SUBMISSION") {
        throw new RuleViolation(
          "special_outcome_already_recorded",
          "已记录特殊结果，必须先作废当前记录才能重新录入。",
        );
      }
      if (command.payload.winnerSide) assertSide(command.payload.winnerSide);
      next.specialOutcome = {
        type: command.payload.type,
        winnerSide: command.payload.winnerSide ?? null,
        reason: command.payload.reason.trim(),
      };
      next.phase = "SPECIAL_OUTCOME_PENDING_SUBMISSION";
      next.pendingObligations = [];
      return next;
    case "SUBMIT_RESULT":
      requireReason(command.payload.reason);
      if (
        next.phase !== "MATCH_COMPLETE_PENDING_SUBMISSION" &&
        next.phase !== "SPECIAL_OUTCOME_PENDING_SUBMISSION"
      ) {
        throw new RuleViolation("submit_not_allowed", "比赛尚未达到可提交结果的状态。");
      }
      next.submittedFromPhase = next.phase;
      next.phase = "SUBMITTED";
      return next;
    case "CONFIRM_RESULT":
      requireReason(command.payload.reason);
      if (next.phase !== "SUBMITTED") throw new RuleViolation("confirm_not_allowed", "只有已提交结果可以确认。");
      next.phase = "CONFIRMED";
      return next;
    case "REOPEN_RESULT":
      requireReason(command.payload.reason);
      if ((next.phase !== "SUBMITTED" && next.phase !== "CONFIRMED") || !next.submittedFromPhase) {
        throw new RuleViolation("reopen_not_allowed", "当前结果不能受控重开。");
      }
      next.phase = next.submittedFromPhase;
      next.submittedFromPhase = null;
      return next;
    case "INVALIDATE_SPECIAL_OUTCOME":
    case "UNDO_LAST_REVERSIBLE":
      throw new RuleViolation("internal_history_path", "该命令必须通过聚合历史处理。");
    default:
      throw new RuleViolation("unknown_command", "未知比赛命令。");
  }
}

function createEvent(
  aggregate: MatchAggregate,
  command: MatchCommand,
  stateAfter: MatchState,
  metadata?: MatchEvent["metadata"],
) {
  const stateBefore = clone(aggregate.state);
  stateAfter.version = stateBefore.version + 1;
  const event: MatchEvent = {
    eventId: `${command.commandId}:event`,
    version: stateAfter.version,
    commandId: command.commandId,
    commandFingerprint: fingerprintMatchCommand(command),
    occurredAt: command.occurredAt,
    type: command.type,
    payload: clone(command.payload),
    reversible: command.type === "RALLY_WON",
    stateBefore,
    stateAfter: clone(stateAfter),
    ...(metadata ? { metadata: clone(metadata) } : {}),
  };
  const nextAggregate = {
    initialState: clone(aggregate.initialState),
    state: clone(stateAfter),
    events: [...aggregate.events.map(clone), event],
  };
  return { aggregate: nextAggregate, event };
}

function applyUndo(aggregate: MatchAggregate, command: Extract<MatchCommand, { type: "UNDO_LAST_REVERSIBLE" }>) {
  requireReason(command.payload.reason);
  if (aggregate.state.phase === "SUBMITTED" || aggregate.state.phase === "CONFIRMED") {
    throw new RuleViolation("undo_result_locked", "已提交或确认的结果不能普通撤销。");
  }
  const alreadyUndone = new Set(
    aggregate.events
      .map((event) => event.metadata?.undoneCommandId)
      .filter((commandId): commandId is string => Boolean(commandId)),
  );
  let targetIndex = -1;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index];
    if (event.reversible && !alreadyUndone.has(event.commandId)) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) throw new RuleViolation("nothing_to_undo", "没有可撤销的最近业务命令。");
  const target = aggregate.events[targetIndex];
  const later = aggregate.events.slice(targetIndex + 1);
  const dependentTypes = new Set<MatchEvent["type"]>(["ACKNOWLEDGE_INTERVAL", "CONFIRM_CHANGE_ENDS", "RECORD_MISSED_CHANGE_ENDS"]);
  if (later.some((event) => !dependentTypes.has(event.type))) {
    throw new RuleViolation("undo_has_later_operations", "目标得分之后已有独立操作，不能普通撤销。");
  }
  const changeEndsWasConfirmed = later.some(
    (event) => event.type === "CONFIRM_CHANGE_ENDS" || event.type === "RECORD_MISSED_CHANGE_ENDS",
  );
  const restored = clone(target.stateBefore);
  if (changeEndsWasConfirmed) {
    restored.physicalEnds = clone(aggregate.state.physicalEnds);
    addObligation(restored, {
      id: `physical-review:undo:${target.commandId}`,
      type: "PHYSICAL_ENDS_REVIEW",
      gameNumber: restored.currentGame,
      triggerScore: clone(restored.score),
      reason: "得分撤销前已实际换边，需人工核对当前物理场地端。",
    });
    restored.phase = "OBLIGATIONS_PENDING";
  }
  return createEvent(aggregate, command, restored, { undoneCommandId: target.commandId });
}

function applySpecialOutcomeInvalidation(
  aggregate: MatchAggregate,
  command: Extract<MatchCommand, { type: "INVALIDATE_SPECIAL_OUTCOME" }>,
) {
  requireReason(command.payload.reason);
  if (aggregate.state.phase !== "SPECIAL_OUTCOME_PENDING_SUBMISSION") {
    throw new RuleViolation(
      "special_outcome_cannot_be_invalidated",
      "只有待提交的特殊结果记录可以作废。",
    );
  }
  const invalidated = new Set(
    aggregate.events
      .map((event) => event.metadata?.invalidatedCommandId)
      .filter((commandId): commandId is string => Boolean(commandId)),
  );
  const target = [...aggregate.events]
    .reverse()
    .find((event) => event.type === "RECORD_SPECIAL_OUTCOME" && !invalidated.has(event.commandId));
  if (!target) {
    throw new RuleViolation("special_outcome_event_missing", "找不到可作废的特殊结果历史。");
  }
  return createEvent(aggregate, command, clone(target.stateBefore), {
    invalidatedCommandId: target.commandId,
  });
}

export function createMatchAggregate(input: CreateMatchInput): MatchAggregate {
  if (!input.matchId.trim()) throw new RuleViolation("match_id_required", "比赛 ID 不能为空。");
  if (input.format !== "SINGLES" && input.format !== "DOUBLES") {
    throw new RuleViolation("invalid_format", "比赛类型必须是单打或双打。");
  }
  const expectedPlayers = input.format === "SINGLES" ? 1 : 2;
  for (const side of ["A", "B"] as const) {
    if (input.players[side].length !== expectedPlayers || new Set(input.players[side]).size !== expectedPlayers) {
      throw new RuleViolation("invalid_roster", `Side ${side} 的球员数量或身份不符合 ${input.format}。`);
    }
  }
  if (new Set([...input.players.A, ...input.players.B]).size !== expectedPlayers * 2) {
    throw new RuleViolation("duplicate_player", "A/B 双方不能包含重复球员。");
  }
  const ruleConfig = validateRuleConfig(clone(input.ruleConfig));
  if (hashRuleConfig(ruleConfig) !== input.ruleConfigHash) {
    throw new RuleViolation("rule_hash_mismatch", "规则配置与冻结哈希不一致。");
  }
  const state: MatchState = {
    matchId: input.matchId,
    format: input.format,
    players: clone(input.players),
    ruleConfig: clone(ruleConfig),
    ruleConfigHash: input.ruleConfigHash,
    phase: "AWAITING_COIN_TOSS",
    version: 0,
    coinToss: null,
    currentGame: 1,
    score: { A: 0, B: 0 },
    gamesWon: { A: 0, B: 0 },
    completedGames: [],
    servingSide: null,
    serverPlayerId: null,
    receiverPlayerId: null,
    serverCourt: null,
    receiverCourt: null,
    logicalCourts: null,
    physicalEnds: null,
    pendingObligations: [],
    nextGameServingSide: null,
    pausedFromPhase: null,
    submittedFromPhase: null,
    specialOutcome: null,
  };
  return { initialState: clone(state), state: clone(state), events: [] };
}

export function applyCommand(aggregate: MatchAggregate, command: MatchCommand): ApplyCommandResult {
  try {
    assertCommonCommand(command);
    const fingerprint = fingerprintMatchCommand(command);
    const prior = aggregate.events.find((event) => event.commandId === command.commandId);
    if (prior) {
      if (prior.commandFingerprint !== fingerprint) {
        throw new RuleViolation("command_id_reused", "同一 commandId 不能用于不同命令内容。");
      }
      return { status: "duplicate", aggregate: clone(aggregate), events: [clone(prior)] };
    }
    const applied =
      command.type === "UNDO_LAST_REVERSIBLE"
        ? applyUndo(aggregate, command)
        : command.type === "INVALIDATE_SPECIAL_OUTCOME"
          ? applySpecialOutcomeInvalidation(aggregate, command)
          : createEvent(aggregate, command, nextStateForCommand(aggregate.state, command));
    return { status: "accepted", aggregate: applied.aggregate, events: [applied.event] };
  } catch (error) {
    const violation = error instanceof RuleViolation ? error : new RuleViolation("invalid_command", "命令无法应用。");
    return {
      status: "rejected",
      aggregate: clone(aggregate),
      error: { code: violation.code, message: violation.message },
    };
  }
}

export function replayMatch(initialState: MatchState, events: MatchEvent[]) {
  let aggregate: MatchAggregate = {
    initialState: clone(initialState),
    state: clone(initialState),
    events: [],
  };
  for (const event of events) {
    if (event.version !== aggregate.state.version + 1 || event.stateAfter.version !== event.version) {
      throw new RuleViolation("invalid_event_version", "事件版本不连续，无法确定性重放。");
    }
    const command = {
      commandId: event.commandId,
      occurredAt: event.occurredAt,
      type: event.type,
      payload: clone(event.payload),
    } as MatchCommand;
    const result = applyCommand(aggregate, command);
    if (result.status !== "accepted" || result.events.length !== 1) {
      throw new RuleViolation("invalid_replay_event", "事件命令无法从当前状态重新应用。");
    }
    if (!sameValue(result.events[0], event)) {
      throw new RuleViolation("replay_snapshot_mismatch", "事件快照与命令重放结果不一致。");
    }
    aggregate = result.aggregate;
  }
  return aggregate.state;
}

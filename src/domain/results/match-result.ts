/**
 * 比赛结果的纯规则。无 IO、无框架。
 *
 * 把两种来源统一成同一种「结果事实」，供名次、晋级与界面使用：
 * - 裁判台逐分记分（LIVE）：从权威比赛状态读取；
 * - 管理员补录的「仅结果记录」（RESULT_ONLY）：只有逐局比分与结局，不伪造回合、发接发或换边过程。
 *
 * 只有「正式确认」的结果进入正式名次与晋级；其余状态只能出现在暂定榜并醒目标记。
 */

import { gameIsWon, winsNeeded, type MatchState, type Side } from "@/domain/rules/match-engine";
import type { RuleConfig } from "@/domain/rules/rule-profile";

export type ResultOutcome = "NORMAL" | "WO" | "RET" | "DSQ" | "ABANDONED" | "BYE";
export type ResultSourceKind = "LIVE" | "RESULT_ONLY";

/** 成绩状态：进行中比分、全场结束待提交、待复核、正式确认（被撤回/更正的旧版本另存在结果修订里）。 */
export type ResultStage = "NOT_STARTED" | "IN_PROGRESS" | "PENDING_SUBMISSION" | "PENDING_REVIEW" | "CONFIRMED";

export const RESULT_STAGE_LABEL: Record<ResultStage, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  PENDING_SUBMISSION: "结束待提交",
  PENDING_REVIEW: "待复核",
  CONFIRMED: "正式确认",
};

export const OUTCOME_LABEL: Record<ResultOutcome, string> = {
  NORMAL: "正常完赛",
  WO: "弃权（WO）",
  RET: "退赛（RET）",
  DSQ: "取消资格（DSQ）",
  ABANDONED: "终止待裁决",
  BYE: "轮空（BYE）",
};

export interface GameScore {
  a: number;
  b: number;
}

export interface MatchResultFact {
  stage: ResultStage;
  source: ResultSourceKind;
  outcome: ResultOutcome | null;
  winner: Side | null;
  /** 已完成的各局比分。 */
  games: GameScore[];
  /** 特殊结果时中断局的实际比分（保留实际比分，不补满）。 */
  partial: GameScore | null;
}

export const NOT_STARTED_FACT: MatchResultFact = {
  stage: "NOT_STARTED",
  source: "LIVE",
  outcome: null,
  winner: null,
  games: [],
  partial: null,
};

const ENDED_PHASES = new Set<MatchState["phase"]>([
  "MATCH_COMPLETE_PENDING_SUBMISSION",
  "SPECIAL_OUTCOME_PENDING_SUBMISSION",
  "SUBMITTED",
  "CONFIRMED",
]);

function stageOf(state: MatchState): ResultStage {
  switch (state.phase) {
    case "CONFIRMED":
      return "CONFIRMED";
    case "SUBMITTED":
      return "PENDING_REVIEW";
    case "MATCH_COMPLETE_PENDING_SUBMISSION":
    case "SPECIAL_OUTCOME_PENDING_SUBMISSION":
      return "PENDING_SUBMISSION";
    case "AWAITING_COIN_TOSS":
      return state.version === 0 ? "NOT_STARTED" : "IN_PROGRESS";
    default:
      return "IN_PROGRESS";
  }
}

/** 裁判台逐分记分的比赛：从权威状态读取结果事实。 */
export function factFromState(state: MatchState | null): MatchResultFact {
  if (!state) return NOT_STARTED_FACT;
  const games = state.completedGames.map((game) => ({ a: game.scoreA, b: game.scoreB }));
  const ended = ENDED_PHASES.has(state.phase);
  const special = state.specialOutcome;
  let winner: Side | null = null;
  if (special) winner = special.winnerSide;
  else if (ended && state.gamesWon.A !== state.gamesWon.B) winner = state.gamesWon.A > state.gamesWon.B ? "A" : "B";
  const partial = special && (state.score.A > 0 || state.score.B > 0) ? { a: state.score.A, b: state.score.B } : null;
  return {
    stage: stageOf(state),
    source: "LIVE",
    outcome: ended ? (special?.type ?? "NORMAL") : null,
    winner: ended ? winner : null,
    games,
    partial,
  };
}

// ---------------------------------------------------------------------------
// 仅结果记录：校验逐局分数、胜局数、比赛是否结束；特殊结果单独录入
// ---------------------------------------------------------------------------

export type ResultOnlyOutcome = Exclude<ResultOutcome, "BYE">;

export interface ResultOnlyInput {
  outcome: ResultOnlyOutcome;
  winnerSide: Side | null;
  games: GameScore[];
  partial: GameScore | null;
}

export interface ResultOnlyRecord extends ResultOnlyInput {
  kind: "RESULT_ONLY";
}

function isScore(value: number) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * 一局的最终比分合法：该局已经结束，而且赢方的最后一分正是结束这一局的那一分
 * （例如 25:20 不合法，因为 21:20 之前的 24:20 早已结束）。
 */
export function isFinalGameScore(game: GameScore, config: RuleConfig) {
  if (!isScore(game.a) || !isScore(game.b) || game.a === game.b) return false;
  const high = Math.max(game.a, game.b);
  const low = Math.min(game.a, game.b);
  if (high > config.capPoints) return false;
  return gameIsWon(high, low, config) && !gameIsWon(high - 1, low, config);
}

export function validateResultOnly(
  input: ResultOnlyInput,
  config: RuleConfig,
): { ok: true; record: ResultOnlyRecord } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const needed = winsNeeded(config);
  if (input.games.length > config.bestOf) errors.push(`本场最多 ${config.bestOf} 局，录入了 ${input.games.length} 局`);

  const won = { A: 0, B: 0 };
  let decidedAt: number | null = null;
  input.games.forEach((game, index) => {
    if (!isFinalGameScore(game, config)) {
      errors.push(`第 ${index + 1} 局比分 ${game.a}:${game.b} 不是按本场规则（${config.targetPoints} 分、领先 ${config.winBy} 分、封顶 ${config.capPoints} 分）结束的一局`);
      return;
    }
    if (decidedAt !== null) {
      errors.push(`第 ${decidedAt + 1} 局后比赛已经结束，不能再有第 ${index + 1} 局`);
      return;
    }
    won[game.a > game.b ? "A" : "B"] += 1;
    if (won.A >= needed || won.B >= needed) decidedAt = index;
  });
  const matchWinner: Side | null = won.A >= needed ? "A" : won.B >= needed ? "B" : null;

  if (input.partial) {
    const { a, b } = input.partial;
    if (!isScore(a) || !isScore(b) || a > config.capPoints || b > config.capPoints) errors.push("中断局比分无效");
    else if (gameIsWon(a, b, config)) errors.push("中断局比分已经构成完整一局，请作为已完成的一局录入");
  }

  switch (input.outcome) {
    case "NORMAL":
      if (input.partial) errors.push("正常完赛没有中断局");
      if (!matchWinner) errors.push(`正常完赛须有一方先胜 ${needed} 局`);
      else if (input.winnerSide && input.winnerSide !== matchWinner) errors.push("填写的胜方与逐局比分不一致");
      break;
    case "WO":
      if (input.games.length || input.partial) errors.push("弃权（WO）是未开赛的结局，未打的局留空，不补任何比分");
      if (!input.winnerSide) errors.push("弃权须写明胜方（未弃权的一方）");
      break;
    case "RET":
    case "DSQ":
      if (matchWinner) errors.push("逐局比分显示比赛已正常结束，不能再记为退赛或取消资格");
      if (!input.winnerSide) errors.push(`${input.outcome === "RET" ? "退赛" : "取消资格"}须写明胜方`);
      break;
    case "ABANDONED":
      if (matchWinner) errors.push("逐局比分显示比赛已正常结束，不能记为终止");
      if (input.winnerSide) errors.push("终止待裁决不自动产生胜方");
      break;
    default:
      errors.push("结局类型无效");
  }
  if (errors.length) return { ok: false, errors };
  const winnerSide = input.outcome === "NORMAL" ? matchWinner : input.winnerSide;
  return {
    ok: true,
    record: { kind: "RESULT_ONLY", outcome: input.outcome, winnerSide, games: input.games.map((game) => ({ ...game })), partial: input.partial ? { ...input.partial } : null },
  };
}

/** 仅结果记录的比赛：按最新有效修订读取结果事实。 */
export function factFromRecord(record: ResultOnlyRecord, stage: ResultStage): MatchResultFact {
  return {
    stage,
    source: "RESULT_ONLY",
    outcome: record.outcome,
    winner: record.winnerSide,
    games: record.games.map((game) => ({ ...game })),
    partial: record.partial ? { ...record.partial } : null,
  };
}

/** 比分摘要，例如「21:15 18:21 21:19」；特殊结果附中断局。 */
export function formatScoreline(fact: Pick<MatchResultFact, "games" | "partial">) {
  const parts = fact.games.map((game) => `${game.a}:${game.b}`);
  if (fact.partial) parts.push(`(${fact.partial.a}:${fact.partial.b})`);
  return parts.join(" ");
}

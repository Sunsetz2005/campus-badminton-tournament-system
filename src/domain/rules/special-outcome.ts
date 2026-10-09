import type { MatchPhase, MatchState, Side, SpecialOutcome } from "@/domain/rules/match-engine";

/**
 * 裁判台可以录入的特殊结果（弃权、退赛、取消资格、中止）。
 *
 * 引擎的 RECORD_SPECIAL_OUTCOME 只校验相位，历史事件按原样重放；
 * 这里是**新命令**的业务校验，服务端在接受命令前执行、裁判台用同一份规则提示，
 * 与「仅结果记录」（`src/domain/results/match-result.ts`）的口径一致：
 * 弃权/退赛/取消资格必须有胜方，中止不自动产生胜方，弃权只用于一分未打的比赛。
 * 轮空由编排产生，不由裁判录入。
 */
export type RefereeSpecialOutcomeType = Exclude<SpecialOutcome["type"], "BYE">;

export const REFEREE_SPECIAL_OUTCOMES: readonly RefereeSpecialOutcomeType[] = ["WO", "RET", "DSQ", "ABANDONED"];

/** 可以录入特殊结果的相位：比赛尚未产生正常结果、也未提交。 */
const RECORDABLE_PHASES = new Set<MatchPhase>([
  "AWAITING_COIN_TOSS",
  "AWAITING_OPENING_SETUP",
  "IN_PROGRESS",
  "OBLIGATIONS_PENDING",
  "PAUSED",
  "GAME_COMPLETE",
  "AWAITING_NEXT_GAME_SETUP",
]);

export function canRecordSpecialOutcome(state: Pick<MatchState, "phase">) {
  return RECORDABLE_PHASES.has(state.phase);
}

/** 本场是否已经打过任何一分（含已完成的局）。 */
export function hasPlayStarted(state: Pick<MatchState, "score" | "completedGames">) {
  return state.completedGames.length > 0 || state.score.A > 0 || state.score.B > 0;
}

/** 按当前进度给出默认类型：一分未打默认弃权，否则默认退赛。 */
export function defaultSpecialOutcomeType(state: Pick<MatchState, "score" | "completedGames">): RefereeSpecialOutcomeType {
  return hasPlayStarted(state) ? "RET" : "WO";
}

export function validateRefereeSpecialOutcome(
  state: Pick<MatchState, "phase" | "score" | "completedGames">,
  input: { type: string; winnerSide?: Side | null },
): string[] {
  const errors: string[] = [];
  if (!canRecordSpecialOutcome(state)) {
    errors.push(state.phase === "MATCH_COMPLETE_PENDING_SUBMISSION" ? "比赛已正常结束，不能再记录弃赛或特殊结果" : "当前比赛状态不能记录特殊结果");
  }
  switch (input.type) {
    case "WO":
      if (hasPlayStarted(state)) errors.push("比赛已经开始计分，中途放弃应记为退赛（RET），不是弃权（WO）");
      if (!input.winnerSide) errors.push("弃权须指明弃权的一方");
      break;
    case "RET":
      if (!input.winnerSide) errors.push("退赛须指明退赛的一方");
      break;
    case "DSQ":
      if (!input.winnerSide) errors.push("取消资格须指明被取消资格的一方");
      break;
    case "ABANDONED":
      if (input.winnerSide) errors.push("比赛中止不自动产生胜方，由裁判长另行裁决");
      break;
    case "BYE":
      errors.push("轮空由编排产生，不能在裁判台录入");
      break;
    default:
      errors.push("特殊结果类型无效");
  }
  return errors;
}

import { describe, expect, it } from "vitest";

import {
  canRecordSpecialOutcome,
  defaultSpecialOutcomeType,
  validateRefereeSpecialOutcome,
} from "@/domain/rules/special-outcome";
import type { MatchPhase } from "@/domain/rules/match-engine";

const notStarted = { phase: "AWAITING_COIN_TOSS" as MatchPhase, score: { A: 0, B: 0 }, completedGames: [] };
const midGame = { phase: "PAUSED" as MatchPhase, score: { A: 7, B: 5 }, completedGames: [] };
const betweenGames = {
  phase: "AWAITING_NEXT_GAME_SETUP" as MatchPhase,
  score: { A: 0, B: 0 },
  completedGames: [{ gameNumber: 1, scoreA: 21, scoreB: 15, winner: "A" }],
} as unknown as typeof notStarted;

describe("裁判台弃赛与特殊结果", () => {
  it("未开赛、暂停、局间都能记录；正常结束或已提交后不能", () => {
    for (const phase of ["AWAITING_COIN_TOSS", "AWAITING_OPENING_SETUP", "IN_PROGRESS", "OBLIGATIONS_PENDING", "PAUSED", "GAME_COMPLETE", "AWAITING_NEXT_GAME_SETUP"] as const) {
      expect(canRecordSpecialOutcome({ phase })).toBe(true);
    }
    for (const phase of ["MATCH_COMPLETE_PENDING_SUBMISSION", "SPECIAL_OUTCOME_PENDING_SUBMISSION", "SUBMITTED", "CONFIRMED"] as const) {
      expect(canRecordSpecialOutcome({ phase })).toBe(false);
    }
    expect(validateRefereeSpecialOutcome({ ...midGame, phase: "MATCH_COMPLETE_PENDING_SUBMISSION" }, { type: "RET", winnerSide: "A" }))
      .toContain("比赛已正常结束，不能再记录弃赛或特殊结果");
  });

  it("一分未打默认弃权，开始计分后默认退赛且不能再记弃权", () => {
    expect(defaultSpecialOutcomeType(notStarted)).toBe("WO");
    expect(defaultSpecialOutcomeType(midGame)).toBe("RET");
    expect(defaultSpecialOutcomeType(betweenGames)).toBe("RET");
    expect(validateRefereeSpecialOutcome(notStarted, { type: "WO", winnerSide: "A" })).toEqual([]);
    expect(validateRefereeSpecialOutcome(midGame, { type: "WO", winnerSide: "A" })).toHaveLength(1);
    expect(validateRefereeSpecialOutcome(betweenGames, { type: "RET", winnerSide: "B" })).toEqual([]);
  });

  it("弃权、退赛、取消资格必须有胜方；中止不得有胜方；轮空不由裁判录入", () => {
    expect(validateRefereeSpecialOutcome(notStarted, { type: "WO" })).toHaveLength(1);
    expect(validateRefereeSpecialOutcome(midGame, { type: "RET", winnerSide: null })).toHaveLength(1);
    expect(validateRefereeSpecialOutcome(midGame, { type: "DSQ" })).toHaveLength(1);
    expect(validateRefereeSpecialOutcome(midGame, { type: "DSQ", winnerSide: "B" })).toEqual([]);
    expect(validateRefereeSpecialOutcome(midGame, { type: "ABANDONED" })).toEqual([]);
    expect(validateRefereeSpecialOutcome(midGame, { type: "ABANDONED", winnerSide: "A" })).toHaveLength(1);
    expect(validateRefereeSpecialOutcome(notStarted, { type: "BYE", winnerSide: "A" })).toHaveLength(1);
  });
});

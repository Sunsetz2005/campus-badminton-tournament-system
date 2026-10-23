import { describe, expect, it } from "vitest";

import { runAutoGoldenCases, runManualGoldenCases } from "../../scripts/stress/oracle/golden";
import { applyOracle, diffAgainst, initialOracleState, type OracleRule } from "../../scripts/stress/oracle/scoring";

const traditional: OracleRule = { bestOf: 3, targetPoints: 21, winBy: 2, capPoints: 30, intervalAt: 11, decidingGameChangeEndsAt: 11, betweenGamesSeconds: 120 };
const singleGame: OracleRule = { bestOf: 1, targetPoints: 21, winBy: 2, capPoints: 30, intervalAt: 11, decidingGameChangeEndsAt: 11, betweenGamesSeconds: 0 };

function rally(state: ReturnType<typeof initialOracleState>, rule: OracleRule, side: "A" | "B", times = 1) {
  for (let index = 0; index < times; index += 1) {
    const step = applyOracle(state, rule, "RALLY_WON", { side });
    if (!step.ok) throw new Error(step.detail);
  }
}

describe("仿真 oracle：人工核对用例（§13.6）", () => {
  const manual = runManualGoldenCases();
  it("已填写 expected 的人工用例全部通过", () => {
    expect(manual.failed).toEqual([]);
  });
  for (const file of manual.pending) it.todo(`待填写：${file}`);
});

describe("仿真 oracle：自写黄金用例", () => {
  const auto = runAutoGoldenCases();
  it("全部通过", () => {
    expect(auto.failed).toEqual([]);
    expect(auto.passed).toBeGreaterThanOrEqual(8);
  });
});

describe("仿真 oracle：独立计分模型", () => {
  it("11 分间歇每局只触发一次，决胜局 11 分换边", () => {
    const state = initialOracleState();
    rally(state, traditional, "A", 11);
    expect(state.pending).toEqual(["INTERVAL"]);
    applyOracle(state, traditional, "ACKNOWLEDGE_INTERVAL", {});
    rally(state, traditional, "B", 11);
    expect(state.pending).toEqual([]);
  });

  it("20 平后须领先 2 分，29 平后 30 分封顶", () => {
    const state = initialOracleState();
    for (let index = 0; index < 20; index += 1) {
      rally(state, traditional, "A");
      rally(state, traditional, "B");
      state.pending = [];
    }
    rally(state, traditional, "A");
    expect(state.gamesWon).toEqual({ A: 0, B: 0 });
    rally(state, traditional, "B");
    for (let index = 0; index < 8; index += 1) {
      rally(state, traditional, "A");
      rally(state, traditional, "B");
    }
    expect(state.score).toEqual({ A: 29, B: 29 });
    rally(state, traditional, "B");
    expect(state.gamesWon).toEqual({ A: 0, B: 1 });
    expect(state.completedGames).toEqual([{ A: 29, B: 30 }]);
    expect(state.pending).toEqual(["INTERVAL", "CHANGE_ENDS"]);
  });

  it("三局两胜：第三局为决胜局，11 分同时间歇与换边", () => {
    const state = initialOracleState();
    const playGame = (winner: "A" | "B") => {
      applyOracle(state, traditional, "CONFIRM_NEXT_GAME_SETUP", {});
      rally(state, traditional, winner, 11);
      state.pending = [];
      rally(state, traditional, winner, 10);
    };
    playGame("A");
    playGame("B");
    applyOracle(state, traditional, "CONFIRM_NEXT_GAME_SETUP", {});
    rally(state, traditional, "A", 11);
    expect([...state.pending].sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);
  });

  it("单局 21：本局就是决胜局，11 分换边", () => {
    const state = initialOracleState();
    rally(state, singleGame, "B", 11);
    expect([...state.pending].sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);
  });

  it("与服务端状态比较能发现比分差异", () => {
    const state = initialOracleState();
    rally(state, traditional, "A", 3);
    const differences = diffAgainst(state, { currentGame: 1, score: { A: 2, B: 0 }, gamesWon: { A: 0, B: 0 }, completedGames: [], pendingObligations: [] });
    expect(differences.length).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  applyCommand,
  createMatchAggregate,
  type MatchAggregate,
  type MatchCommand,
  type MatchPhase,
  type MatchState,
} from "@/domain/rules/match-engine";
import { hashRuleConfig, traditional21Demo } from "@/domain/rules/rule-profile";
import { buildCourtViewModel, type CourtCellViewModel } from "@/ui/court-view-model";

function matchState(overrides: Partial<MatchState> = {}): MatchState {
  return {
    matchId: "court-view-test",
    format: "DOUBLES",
    players: { A: ["A1", "A2"], B: ["B1", "B2"] },
    ruleConfig: traditional21Demo,
    ruleConfigHash: hashRuleConfig(traditional21Demo),
    phase: "IN_PROGRESS",
    version: 1,
    coinToss: {
      winnerSide: "A",
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    },
    currentGame: 1,
    score: { A: 0, B: 0 },
    gamesWon: { A: 0, B: 0 },
    completedGames: [],
    servingSide: "A",
    serverPlayerId: "A1",
    receiverPlayerId: "B1",
    serverCourt: "R",
    receiverCourt: "R",
    logicalCourts: {
      A: { R: "A1", L: "A2" },
      B: { R: "B1", L: "B2" },
    },
    physicalEnds: { A: "END_1", B: "END_2" },
    pendingObligations: [],
    nextGameServingSide: null,
    pausedFromPhase: null,
    submittedFromPhase: null,
    specialOutcome: null,
    ...overrides,
  };
}

function singlesState(overrides: Partial<MatchState> = {}): MatchState {
  return matchState({
    format: "SINGLES",
    players: { A: ["A1"], B: ["B1"] },
    logicalCourts: null,
    ...overrides,
  });
}

function cell(
  state: MatchState,
  flipped: boolean,
  predicate: (candidate: CourtCellViewModel) => boolean,
): CourtCellViewModel {
  const candidate = buildCourtViewModel(state, flipped).cells.find(predicate);
  expect(candidate).toBeDefined();
  return candidate!;
}

let commandNumber = 0;

function command<T extends MatchCommand["type"]>(
  type: T,
  payload: Extract<MatchCommand, { type: T }>["payload"],
) {
  commandNumber += 1;
  return {
    commandId: `10000000-0000-4000-8000-${String(commandNumber).padStart(12, "0")}`,
    occurredAt: `2026-09-20T01:${String(commandNumber % 60).padStart(2, "0")}:00.000Z`,
    type,
    payload,
  } as Extract<MatchCommand, { type: T }>;
}

function accept(aggregate: MatchAggregate, nextCommand: MatchCommand) {
  const result = applyCommand(aggregate, nextCommand);
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error("球场投影测试命令未被接受。");
  return result.aggregate;
}

describe("buildCourtViewModel", () => {
  it.each([
    [false, "LEFT", "TOP", "END_1", "L", "A"],
    [false, "LEFT", "BOTTOM", "END_1", "R", "A"],
    [false, "RIGHT", "TOP", "END_2", "R", "B"],
    [false, "RIGHT", "BOTTOM", "END_2", "L", "B"],
    [true, "LEFT", "TOP", "END_2", "L", "B"],
    [true, "LEFT", "BOTTOM", "END_2", "R", "B"],
    [true, "RIGHT", "TOP", "END_1", "R", "A"],
    [true, "RIGHT", "BOTTOM", "END_1", "L", "A"],
  ] as const)(
    "flipped=%s 时 %s/%s 投影到 %s %s 区和 %s 方",
    (flipped, screenHalf, screenRow, physicalEnd, logicalCourt, side) => {
      const projected = cell(
        matchState(),
        flipped,
        (candidate) => candidate.screenHalf === screenHalf && candidate.screenRow === screenRow,
      );
      expect(projected).toMatchObject({ physicalEnd, logicalCourt, side });
    },
  );

  it.each([
    {
      score: { A: 0, B: 0 },
      servingSide: "A",
      serverCourt: "R",
      receiverCourt: "R",
      server: ["LEFT", "BOTTOM", "A1"],
      receiver: ["RIGHT", "TOP", "B1"],
    },
    {
      score: { A: 1, B: 0 },
      servingSide: "A",
      serverCourt: "L",
      receiverCourt: "L",
      server: ["LEFT", "TOP", "A1"],
      receiver: ["RIGHT", "BOTTOM", "B1"],
    },
    {
      score: { A: 1, B: 1 },
      servingSide: "B",
      serverCourt: "L",
      receiverCourt: "L",
      server: ["RIGHT", "BOTTOM", "B1"],
      receiver: ["LEFT", "TOP", "A1"],
    },
    {
      score: { A: 1, B: 2 },
      servingSide: "B",
      serverCourt: "R",
      receiverCourt: "R",
      server: ["RIGHT", "TOP", "B1"],
      receiver: ["LEFT", "BOTTOM", "A1"],
    },
  ] as const)("单打 $score.A:$score.B 只在对角规则发球区放置球员", (scenario) => {
    const state = singlesState({
      score: scenario.score,
      servingSide: scenario.servingSide,
      serverPlayerId: scenario.servingSide === "A" ? "A1" : "B1",
      receiverPlayerId: scenario.servingSide === "A" ? "B1" : "A1",
      serverCourt: scenario.serverCourt,
      receiverCourt: scenario.receiverCourt,
    });
    const view = buildCourtViewModel(state, false);
    const occupied = view.cells.filter((candidate) => candidate.playerId !== null);

    expect(occupied).toHaveLength(2);
    expect(occupied.find((candidate) => candidate.role === "SERVER")).toMatchObject({
      screenHalf: scenario.server[0],
      screenRow: scenario.server[1],
      playerId: scenario.server[2],
    });
    expect(occupied.find((candidate) => candidate.role === "RECEIVER")).toMatchObject({
      screenHalf: scenario.receiver[0],
      screenRow: scenario.receiver[1],
      playerId: scenario.receiver[2],
    });
  });

  it("双打使用权威 logicalCourts 放置四名球员，且只标记一名发球员", () => {
    const view = buildCourtViewModel(matchState(), false);
    expect(view.cells.map(({ screenHalf, screenRow, logicalCourt, playerId }) => ({
      screenHalf,
      screenRow,
      logicalCourt,
      playerId,
    }))).toEqual([
      { screenHalf: "LEFT", screenRow: "TOP", logicalCourt: "L", playerId: "A2" },
      { screenHalf: "LEFT", screenRow: "BOTTOM", logicalCourt: "R", playerId: "A1" },
      { screenHalf: "RIGHT", screenRow: "TOP", logicalCourt: "R", playerId: "B1" },
      { screenHalf: "RIGHT", screenRow: "BOTTOM", logicalCourt: "L", playerId: "B2" },
    ]);
    expect(view.cells.filter((candidate) => candidate.role === "SERVER")).toHaveLength(1);
    expect(view.cells.filter((candidate) => candidate.role === "RECEIVER")).toHaveLength(1);
  });

  it("双打黄金逐分序列同步投影四格、唯一发球员和接发员", () => {
    let aggregate = createMatchAggregate({
      matchId: "court-golden-doubles",
      format: "DOUBLES",
      players: { A: ["A1", "A2"], B: ["B1", "B2"] },
      ruleConfig: traditional21Demo,
      ruleConfigHash: hashRuleConfig(traditional21Demo),
    });
    aggregate = accept(aggregate, command("RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: "A",
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    }));
    aggregate = accept(aggregate, command("CONFIRM_OPENING_SETUP", {
      serverPlayerId: "A1",
      receiverPlayerId: "B1",
      logicalCourts: { A: { R: "A1", L: "A2" }, B: { R: "B1", L: "B2" } },
    }));

    const expected = [
      ["A", "A1", "B2", "A2", "A1", "B1", "B2"],
      ["A", "A1", "B1", "A1", "A2", "B1", "B2"],
      ["B", "B2", "A2", "A1", "A2", "B1", "B2"],
      ["B", "B2", "A1", "A1", "A2", "B2", "B1"],
      ["A", "A2", "B1", "A1", "A2", "B2", "B1"],
      ["A", "A2", "B2", "A2", "A1", "B2", "B1"],
      ["B", "B1", "A1", "A2", "A1", "B2", "B1"],
    ] as const;

    for (const [winner, server, receiver, aR, aL, bR, bL] of expected) {
      aggregate = accept(aggregate, command("RALLY_WON", { side: winner }));
      const view = buildCourtViewModel(aggregate.state, false);
      expect(view.cells.map((candidate) => candidate.playerId)).toEqual([aL, aR, bR, bL]);
      expect(view.cells.filter((candidate) => candidate.role === "SERVER")).toEqual([
        expect.objectContaining({ playerId: server }),
      ]);
      expect(view.cells.filter((candidate) => candidate.role === "RECEIVER")).toEqual([
        expect.objectContaining({ playerId: receiver }),
      ]);
    }
  });

  it("换边只更改队伍占据的物理半场，视角翻转不修改输入状态", () => {
    const state = matchState({ physicalEnds: { A: "END_2", B: "END_1" } });
    const before = structuredClone(state);
    const normal = buildCourtViewModel(state, false);
    const flipped = buildCourtViewModel(state, true);

    expect(normal.halves.map(({ screenHalf, physicalEnd, side }) => ({ screenHalf, physicalEnd, side }))).toEqual([
      { screenHalf: "LEFT", physicalEnd: "END_1", side: "B" },
      { screenHalf: "RIGHT", physicalEnd: "END_2", side: "A" },
    ]);
    expect(flipped.halves.map(({ screenHalf, physicalEnd, side }) => ({ screenHalf, physicalEnd, side }))).toEqual([
      { screenHalf: "LEFT", physicalEnd: "END_2", side: "A" },
      { screenHalf: "RIGHT", physicalEnd: "END_1", side: "B" },
    ]);
    expect(state).toEqual(before);
  });

  it("物理端未建立时返回稳定但明确未确认的布局", () => {
    const state = matchState({ physicalEnds: null });
    const first = buildCourtViewModel(state, false);
    const second = buildCourtViewModel(state, false);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      physicalEndsConfirmed: false,
      leftPhysicalEnd: "END_1",
      rightPhysicalEnd: "END_2",
    });
    expect(first.halves.map(({ side, physicalEndConfirmed }) => ({ side, physicalEndConfirmed }))).toEqual([
      { side: "A", physicalEndConfirmed: false },
      { side: "B", physicalEndConfirmed: false },
    ]);
  });

  it.each(["IN_PROGRESS", "OBLIGATIONS_PENDING", "PAUSED"] satisfies MatchPhase[])(
    "%s 阶段显示发球和接发身份",
    (phase) => {
      const roles = buildCourtViewModel(matchState({ phase }), false).cells
        .map((candidate) => candidate.role)
        .filter(Boolean);
      expect(roles).toEqual(["SERVER", "RECEIVER"]);
    },
  );

  it.each([
    "AWAITING_COIN_TOSS",
    "AWAITING_OPENING_SETUP",
    "GAME_COMPLETE",
    "AWAITING_NEXT_GAME_SETUP",
    "MATCH_COMPLETE_PENDING_SUBMISSION",
    "SPECIAL_OUTCOME_PENDING_SUBMISSION",
    "SUBMITTED",
    "CONFIRMED",
  ] satisfies MatchPhase[])("%s 阶段不误标当前发球员", (phase) => {
    expect(buildCourtViewModel(matchState({ phase }), false).cells.every((candidate) => candidate.role === null)).toBe(
      true,
    );
  });
});

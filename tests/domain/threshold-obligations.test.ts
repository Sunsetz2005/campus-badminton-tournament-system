import { describe, expect, it } from "vitest";

import {
  applyCommand,
  createMatchAggregate,
  replayMatch,
  type MatchAggregate,
  type MatchCommand,
  type MatchState,
  type ScoreStateReplacement,
} from "@/domain/rules/match-engine";
import {
  alternative3x15Demo,
  hashRuleConfig,
  singleGame21Demo,
  traditional21Demo,
  type RuleConfig,
} from "@/domain/rules/rule-profile";

/**
 * R3-001 回归：同一局内的间歇与决胜局换边阈值只能按本局规则触发一次。
 * 断言目标是「义务不应被重新生成」，因此绝不使用无条件 clearObligations 循环去吞掉重复。
 */

let commandNumber = 0;

function command<T extends MatchCommand["type"]>(
  type: T,
  payload: Extract<MatchCommand, { type: T }>["payload"],
) {
  commandNumber += 1;
  return {
    commandId: `10000000-0000-4000-8000-${String(commandNumber).padStart(12, "0")}`,
    occurredAt: `2026-09-21T09:${String(commandNumber % 60).padStart(2, "0")}:00.000Z`,
    type,
    payload,
  } as Extract<MatchCommand, { type: T }>;
}

function accept(aggregate: MatchAggregate, nextCommand: MatchCommand) {
  const result = applyCommand(aggregate, nextCommand);
  if (result.status !== "accepted") {
    throw new Error(result.status === "rejected" ? result.error.message : "测试命令意外被判定为重复。");
  }
  return result.aggregate;
}

function createSingles(ruleConfig: RuleConfig) {
  return createMatchAggregate({
    matchId: "match-threshold",
    format: "SINGLES",
    players: { A: ["A1"], B: ["B1"] },
    ruleConfig,
    ruleConfigHash: hashRuleConfig(ruleConfig),
  });
}

function tossAndOpen(aggregate: MatchAggregate, servingSide: "A" | "B" = "A") {
  aggregate = accept(
    aggregate,
    command("RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: servingSide,
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    }),
  );
  return accept(
    aggregate,
    command("CONFIRM_OPENING_SETUP", {
      serverPlayerId: servingSide === "A" ? "A1" : "B1",
      receiverPlayerId: servingSide === "A" ? "B1" : "A1",
      logicalCourts: null,
    }),
  );
}

/** 构造一个只改比分、不带任何待办的合法替换状态（单打）。 */
function replacement(
  state: MatchState,
  scoreA: number,
  scoreB: number,
  pendingObligations: MatchState["pendingObligations"] = [],
): ScoreStateReplacement {
  const servingSide = state.servingSide!;
  const receivingSide = servingSide === "A" ? "B" : "A";
  return {
    score: { A: scoreA, B: scoreB },
    gamesWon: state.gamesWon,
    completedGames: state.completedGames,
    servingSide,
    serverPlayerId: state.players[servingSide][0],
    receiverPlayerId: state.players[receivingSide][0],
    logicalCourts: state.logicalCourts,
    pendingObligations,
    phase: pendingObligations.length > 0 ? "OBLIGATIONS_PENDING" : "IN_PROGRESS",
  };
}

/** 逐一处理当前待办，并断言它们确实是本次预期新增的那些。 */
function settleObligations(aggregate: MatchAggregate, expectedTypes: Array<"INTERVAL" | "CHANGE_ENDS">) {
  expect([...aggregate.state.pendingObligations].map((item) => item.type).sort()).toEqual([...expectedTypes].sort());
  for (const pending of [...aggregate.state.pendingObligations]) {
    aggregate = accept(
      aggregate,
      pending.type === "INTERVAL"
        ? command("ACKNOWLEDGE_INTERVAL", { obligationId: pending.id })
        : command("CONFIRM_CHANGE_ENDS", { obligationId: pending.id }),
    );
  }
  expect(aggregate.state.pendingObligations).toEqual([]);
  return aggregate;
}

/** 走到某个比分，沿途不允许出现任何未预期的待办。 */
function rally(aggregate: MatchAggregate, side: "A" | "B", times = 1) {
  for (let index = 0; index < times; index += 1) {
    aggregate = accept(aggregate, command("RALLY_WON", { side }));
  }
  return aggregate;
}

function toDecidingGame(ruleConfig: RuleConfig) {
  // 用比分更正把前两局各判给一方，进入第三局（决胜局）。
  let aggregate = tossAndOpen(createSingles(ruleConfig));
  for (const winner of ["A", "B"] as const) {
    const state = aggregate.state;
    const target = ruleConfig.targetPoints;
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", {
        reason: "推进到决胜局",
        replacement: replacement(state, winner === "A" ? target - 1 : 0, winner === "B" ? target - 1 : 0),
      }),
    );
    aggregate = rally(aggregate, winner);
    // 局末的局间间歇与局间换边是另一类义务，按顺序消费。
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = accept(
      aggregate,
      command("CONFIRM_NEXT_GAME_SETUP", { serverPlayerId: `${winner}1`, receiverPlayerId: winner === "A" ? "B1" : "A1", logicalCourts: null }),
    );
  }
  expect(aggregate.state.currentGame).toBe(3);
  return aggregate;
}

describe("R3-001 阈值义务在一局内只触发一次", () => {
  it("单局 21：11:0 处理间歇与换边后，对方得分到 11:1 不再生成同一义务", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    const endsAfterThreshold = aggregate.state.physicalEnds;
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    const endsAfterConfirm = aggregate.state.physicalEnds;
    expect(endsAfterConfirm).not.toEqual(endsAfterThreshold);

    aggregate = rally(aggregate, "B");
    expect(aggregate.state.score).toEqual({ A: 11, B: 1 });
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    expect(aggregate.state.physicalEnds).toEqual(endsAfterConfirm);
  });

  it("三局 21 第一局：11:0 处理间歇后到 11:1 不再间歇，也不产生决胜局换边", () => {
    let aggregate = tossAndOpen(createSingles(traditional21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL"]);
    aggregate = rally(aggregate, "B");
    expect(aggregate.state.score).toEqual({ A: 11, B: 1 });
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("三局 21 决胜局：11:0 处理两项待办后到 11:1 不再重复，也不再换回场地端", () => {
    let aggregate = toDecidingGame(traditional21Demo);
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    const settledEnds = aggregate.state.physicalEnds;
    aggregate = rally(aggregate, "B");
    expect(aggregate.state.score).toEqual({ A: 11, B: 1 });
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(aggregate.state.physicalEnds).toEqual(settledEnds);
  });

  it("3×15 决胜局：阈值来自冻结配置的 8 分，8:0 处理后到 8:1 不再重复", () => {
    let aggregate = toDecidingGame(alternative3x15Demo);
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 7, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = rally(aggregate, "B");
    expect(aggregate.state.score).toEqual({ A: 8, B: 1 });
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("领先方先过阈值后继续得分，另一方稍后到达阈值也不产生第二次局中义务", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = rally(aggregate, "A", 2); // 13:0
    aggregate = rally(aggregate, "B", 11); // 13:11
    expect(aggregate.state.score).toEqual({ A: 13, B: 11 });
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
  });

  it("B 方先到阈值的对称用例同样只触发一次", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo), "B");
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 0, 10) }));
    aggregate = rally(aggregate, "B");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = rally(aggregate, "A", 3);
    expect(aggregate.state.score).toEqual({ A: 3, B: 11 });
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("间歇阈值与换边阈值不同时分别首次触发、确认、消费，不互相抑制", () => {
    const splitThresholds: RuleConfig = { ...singleGame21Demo, intervalAt: 11, decidingGameChangeEndsAt: 13 };
    let aggregate = tossAndOpen(createSingles(splitThresholds));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近间歇阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL"]);
    aggregate = rally(aggregate, "B");           // 11:1，间歇不得重复
    expect(aggregate.state.pendingObligations).toEqual([]);
    aggregate = rally(aggregate, "A", 2);        // 13:1，换边阈值首次触发
    aggregate = settleObligations(aggregate, ["CHANGE_ENDS"]);
    aggregate = rally(aggregate, "B");           // 13:2，换边不得重复
    expect(aggregate.state.score).toEqual({ A: 13, B: 2 });
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("换局后新一局重新计算阈值：第二局 11:0 仍应触发间歇", () => {
    let aggregate = tossAndOpen(createSingles(traditional21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "推进首局", replacement: replacement(aggregate.state, 20, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = accept(aggregate, command("CONFIRM_NEXT_GAME_SETUP", { serverPlayerId: "A1", receiverPlayerId: "B1", logicalCourts: null }));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    expect(aggregate.state.pendingObligations).toEqual([
      expect.objectContaining({ type: "INTERVAL", gameNumber: 2 }),
    ]);
  });

  it("阈值一分误点、尚未实际换边便撤销：恢复原比分与必要待办，不增加虚假确认", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    const endsBefore = aggregate.state.physicalEnds;
    aggregate = rally(aggregate, "A");
    expect(aggregate.state.pendingObligations).toHaveLength(2);
    aggregate = accept(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "阈值分误点" }));
    expect(aggregate.state.score).toEqual({ A: 10, B: 0 });
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(aggregate.state.physicalEnds).toEqual(endsBefore);
    // 撤销后重新打到阈值，义务应当重新出现（该分确实被重新打出）。
    aggregate = rally(aggregate, "A");
    expect([...aggregate.state.pendingObligations].map((item) => item.type).sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);
  });

  it("阈值后已实际换边再撤销触发得分：保留物理事实并进入显式核对", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    const endsBefore = aggregate.state.physicalEnds;
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    const swappedEnds = aggregate.state.physicalEnds;
    aggregate = accept(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "阈值分误点" }));
    expect(aggregate.state.score).toEqual({ A: 10, B: 0 });
    expect(aggregate.state.physicalEnds).toEqual(swappedEnds);
    expect(aggregate.state.physicalEnds).not.toEqual(endsBefore);
    expect(aggregate.state.pendingObligations).toEqual([
      expect.objectContaining({ type: "PHYSICAL_ENDS_REVIEW" }),
    ]);
  });

  it("比分更正到阈值之后：已处理过的阈值不得因更正被重新生成", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = rally(aggregate, "B", 5); // 11:5
    // 主裁判发现多记了 B 的一分，整体更正回 11:4——阈值历史仍在，不能重新生成义务。
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "更正 B 方多记一分", replacement: replacement(aggregate.state, 11, 4) }));
    expect(aggregate.state.score).toEqual({ A: 11, B: 4 });
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
  });

  it("比分更正回到阈值之前：阈值事实随之撤回，再次到达时重新触发", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "阈值分本不成立", replacement: replacement(aggregate.state, 9, 0) }));
    expect(aggregate.state.pendingObligations).toEqual([]);
    aggregate = rally(aggregate, "A", 2);
    expect([...aggregate.state.pendingObligations].map((item) => item.type).sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);
  });

  it("比分更正直接跳到阈值点：本局尚未触发时必须带上对应义务", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    const state = aggregate.state;
    const thresholdObligations: MatchState["pendingObligations"] = [
      { id: "interval:game:1:threshold", type: "INTERVAL", gameNumber: 1, triggerScore: { A: 11, B: 3 } },
      { id: "change-ends:game:1:threshold", type: "CHANGE_ENDS", gameNumber: 1, triggerScore: { A: 11, B: 3 } },
    ];
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "补记到阈值", replacement: replacement(state, 11, 3, thresholdObligations) }),
    );
    expect([...aggregate.state.pendingObligations].map((item) => item.type).sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = rally(aggregate, "B");
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("引擎 v1 历史事件（无 thresholdObligationsIssued）仍可确定性重放并自动升级", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = rally(aggregate, "B", 3);

    // 模拟数据库里引擎 v1 写下的历史：所有状态快照都缺少新字段，且不允许改写历史。
    const strip = (value: unknown) => {
      const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
      delete copy.thresholdObligationsIssued;
      return copy;
    };
    const legacyInitial = strip(aggregate.initialState) as unknown as MatchState;
    const legacyEvents = JSON.parse(JSON.stringify(aggregate.events)).map((event: Record<string, unknown>) => ({
      ...event,
      stateBefore: strip(event.stateBefore),
      stateAfter: strip(event.stateAfter),
    }));
    expect(legacyEvents.at(-1).stateAfter.thresholdObligationsIssued).toBeUndefined();

    const replayed = replayMatch(legacyInitial, legacyEvents);
    expect(replayed.score).toEqual({ A: 11, B: 3 });
    // 升级后的状态按比分重建阈值事实，因此后续不会重复生成已处理的义务。
    expect(replayed.thresholdObligationsIssued.sort()).toEqual([
      "change-ends:game:1:threshold",
      "interval:game:1:threshold",
    ]);
    const continued = accept({ initialState: replayed, state: replayed, events: [] }, command("RALLY_WON", { side: "B" }));
    expect(continued.state.pendingObligations).toEqual([]);
  });

  it("完整历史重放得到同一权威状态", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "接近阈值", replacement: replacement(aggregate.state, 10, 0) }));
    aggregate = rally(aggregate, "A");
    aggregate = settleObligations(aggregate, ["INTERVAL", "CHANGE_ENDS"]);
    aggregate = rally(aggregate, "B", 4);
    const replayed = replayMatch(
      JSON.parse(JSON.stringify(aggregate.initialState)),
      JSON.parse(JSON.stringify(aggregate.events)),
    );
    expect(replayed).toEqual(aggregate.state);
  });
});

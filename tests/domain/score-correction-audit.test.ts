import { describe, expect, it } from "vitest";

import {
  applyCommand,
  createMatchAggregate,
  deriveScoreCorrectionReplacement,
  replayMatch,
  SCORE_CORRECTION_OBLIGATION_MODEL,
  type MatchAggregate,
  type MatchCommand,
  type Side,
} from "@/domain/rules/match-engine";
import { hashRuleConfig, singleGame21Demo, traditional21Demo, type RuleConfig } from "@/domain/rules/rule-profile";

/**
 * AUD-001 / AUD-002 回归：
 * - 局末与整场结束相位的比分更正必须能通过引擎自身校验（辅助函数与服务端同一推导）；
 * - 阈值“已发生”不等于待办“已履行”，更正不得悄悄消掉尚未处理的间歇或换边。
 */

let commandNumber = 0;

function command<T extends MatchCommand["type"]>(type: T, payload: Extract<MatchCommand, { type: T }>["payload"]) {
  commandNumber += 1;
  return {
    commandId: `20000000-0000-4000-8000-${String(commandNumber).padStart(12, "0")}`,
    occurredAt: new Date(Date.UTC(2026, 9, 15, 8, 0, commandNumber)).toISOString(),
    type,
    payload,
  } as Extract<MatchCommand, { type: T }>;
}

function accept(aggregate: MatchAggregate, next: MatchCommand) {
  const result = applyCommand(aggregate, next);
  if (result.status !== "accepted") {
    throw new Error(result.status === "rejected" ? `${result.error.code}: ${result.error.message}` : "意外重复。");
  }
  return result.aggregate;
}

function open(ruleConfig: RuleConfig) {
  let aggregate = createMatchAggregate({
    matchId: "match-audit",
    format: "SINGLES",
    players: { A: ["A1"], B: ["B1"] },
    ruleConfig,
    ruleConfigHash: hashRuleConfig(ruleConfig),
  });
  aggregate = accept(aggregate, command("RECORD_COIN_TOSS", {
    valid: true,
    winnerSide: "A",
    winnerChoice: { kind: "SERVICE", decision: "SERVE" },
    loserChoice: { kind: "END", end: "END_2" },
  }));
  return accept(aggregate, command("CONFIRM_OPENING_SETUP", { serverPlayerId: "A1", receiverPlayerId: "B1", logicalCourts: null }));
}

/** 与工作台完全相同的更正路径：只提交意图，其余由引擎推导。 */
function correct(aggregate: MatchAggregate, scoreA: number, scoreB: number, servingSide: Side = "A") {
  const replacement = deriveScoreCorrectionReplacement(aggregate.state, {
    score: { A: scoreA, B: scoreB },
    servingSide,
    serverPlayerId: `${servingSide}1`,
    receiverPlayerId: servingSide === "A" ? "B1" : "A1",
  });
  return applyCommand(
    aggregate,
    command("CORRECT_SCORE_STATE", { reason: "误记", replacement, obligationModel: SCORE_CORRECTION_OBLIGATION_MODEL }),
  );
}

function corrected(aggregate: MatchAggregate, scoreA: number, scoreB: number, servingSide: Side = "A") {
  const result = correct(aggregate, scoreA, scoreB, servingSide);
  if (result.status !== "accepted") {
    throw new Error(result.status === "rejected" ? `${result.error.code}: ${result.error.message}` : "意外重复。");
  }
  return result.aggregate;
}

function rally(aggregate: MatchAggregate, side: Side, times = 1) {
  for (let index = 0; index < times; index += 1) aggregate = accept(aggregate, command("RALLY_WON", { side }));
  return aggregate;
}

function settle(aggregate: MatchAggregate, types?: Array<"INTERVAL" | "CHANGE_ENDS">) {
  for (const pending of [...aggregate.state.pendingObligations]) {
    if (types && !types.includes(pending.type as "INTERVAL" | "CHANGE_ENDS")) continue;
    aggregate = accept(
      aggregate,
      pending.type === "INTERVAL"
        ? command("ACKNOWLEDGE_INTERVAL", { obligationId: pending.id })
        : command("CONFIRM_CHANGE_ENDS", { obligationId: pending.id }),
    );
  }
  return aggregate;
}

/** 正常记分（经过阈值时处理待办）直到一方达到给定比分。 */
function playTo(aggregate: MatchAggregate, side: Side, points: number) {
  while (aggregate.state.score[side] < points) {
    if (aggregate.state.phase === "OBLIGATIONS_PENDING") aggregate = settle(aggregate);
    aggregate = rally(aggregate, side);
  }
  return aggregate;
}

function roundTrip(aggregate: MatchAggregate) {
  return replayMatch(JSON.parse(JSON.stringify(aggregate.initialState)), JSON.parse(JSON.stringify(aggregate.events)));
}

describe("AUD-001 局末与整场结束相位的比分更正", () => {
  it("三局制第一局 21:19 结束后，更正回 20:19 被接受并退回进行中", () => {
    let aggregate = open(traditional21Demo);
    aggregate = corrected(aggregate, 19, 19);
    aggregate = rally(aggregate, "A", 2);
    expect(aggregate.state.phase).toBe("GAME_COMPLETE");
    expect(aggregate.state.completedGames).toHaveLength(1);

    aggregate = corrected(aggregate, 20, 19);
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    expect(aggregate.state.currentGame).toBe(1);
    expect(aggregate.state.completedGames).toEqual([]);
    expect(aggregate.state.gamesWon).toEqual({ A: 0, B: 0 });
    expect(aggregate.state.score).toEqual({ A: 20, B: 19 });
    // 局间间歇与局间换边随局末结果一起撤回。
    expect(aggregate.state.pendingObligations).toEqual([]);

    aggregate = rally(aggregate, "A");
    expect(aggregate.state.phase).toBe("GAME_COMPLETE");
    expect(aggregate.state.completedGames).toEqual([{ number: 1, scoreA: 21, scoreB: 19, winnerSide: "A" }]);
    expect(roundTrip(aggregate)).toEqual(aggregate.state);
  });

  it("局末换边已经执行后再更正：保留物理端并生成场地核对，不悄悄换回", () => {
    let aggregate = open(traditional21Demo);
    aggregate = playTo(aggregate, "A", 21);
    expect(aggregate.state.phase).toBe("GAME_COMPLETE");
    aggregate = settle(aggregate, ["CHANGE_ENDS"]);
    const endsAfterChange = aggregate.state.physicalEnds;
    expect(aggregate.state.phase).toBe("GAME_COMPLETE");

    aggregate = corrected(aggregate, 20, 0);
    expect(aggregate.state.physicalEnds).toEqual(endsAfterChange);
    expect(aggregate.state.phase).toBe("OBLIGATIONS_PENDING");
    expect(aggregate.state.pendingObligations.map((item) => item.type)).toEqual(["PHYSICAL_ENDS_REVIEW"]);
    expect(roundTrip(aggregate)).toEqual(aggregate.state);
  });

  it("单局制整场结束后、提交前可以更正回进行中", () => {
    let aggregate = open(singleGame21Demo);
    aggregate = playTo(aggregate, "A", 21);
    expect(aggregate.state.phase).toBe("MATCH_COMPLETE_PENDING_SUBMISSION");

    aggregate = corrected(aggregate, 20, 0);
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    expect(aggregate.state.completedGames).toEqual([]);
    expect(aggregate.state.gamesWon).toEqual({ A: 0, B: 0 });
  });

  it("提交、确认、受控重开后仍可经同一路径更正", () => {
    let aggregate = open(singleGame21Demo);
    aggregate = playTo(aggregate, "A", 21);
    aggregate = accept(aggregate, command("SUBMIT_RESULT", { reason: "提交" }));
    aggregate = accept(aggregate, command("CONFIRM_RESULT", { reason: "复核" }));
    aggregate = accept(aggregate, command("REOPEN_RESULT", { reason: "发现末分误记" }));
    expect(aggregate.state.phase).toBe("MATCH_COMPLETE_PENDING_SUBMISSION");

    aggregate = corrected(aggregate, 20, 0);
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    expect(aggregate.state.completedGames).toEqual([]);
  });
});

describe("AUD-002 更正不得替裁判确认尚未履行的待办", () => {
  it("三局制：11:0 间歇未确认时更正为 11:1，间歇待办原样保留", () => {
    let aggregate = open(traditional21Demo);
    aggregate = rally(aggregate, "A", 11);
    const pending = aggregate.state.pendingObligations;
    expect(pending.map((item) => item.id)).toEqual(["interval:game:1:threshold"]);

    aggregate = corrected(aggregate, 11, 1);
    expect(aggregate.state.phase).toBe("OBLIGATIONS_PENDING");
    expect(aggregate.state.pendingObligations).toEqual(pending);
    const scoring = applyCommand(aggregate, command("RALLY_WON", { side: "A" }));
    expect(scoring.status).toBe("rejected");
  });

  it("单局制：间歇与换边都未处理时更正，两项都保留，物理端不变", () => {
    let aggregate = open(singleGame21Demo);
    aggregate = rally(aggregate, "A", 11);
    const ends = aggregate.state.physicalEnds;
    expect(aggregate.state.pendingObligations.map((item) => item.type).sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);

    aggregate = corrected(aggregate, 11, 1);
    expect(aggregate.state.pendingObligations.map((item) => item.type).sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);
    expect(aggregate.state.physicalEnds).toEqual(ends);
    expect(roundTrip(aggregate)).toEqual(aggregate.state);
  });

  it("只处理了间歇、换边仍待办时更正，只保留换边", () => {
    let aggregate = open(singleGame21Demo);
    aggregate = rally(aggregate, "A", 11);
    aggregate = settle(aggregate, ["INTERVAL"]);
    aggregate = corrected(aggregate, 11, 2);
    expect(aggregate.state.pendingObligations.map((item) => item.type)).toEqual(["CHANGE_ENDS"]);
  });

  it("待办已确认后更正：不重复生成", () => {
    let aggregate = open(singleGame21Demo);
    aggregate = rally(aggregate, "A", 11);
    aggregate = settle(aggregate);
    aggregate = corrected(aggregate, 11, 1);
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("换边未执行就退回阈值之前：待办撤回、不生成核对；再次到达阈值重新触发", () => {
    let aggregate = open(singleGame21Demo);
    aggregate = rally(aggregate, "A", 11);
    aggregate = corrected(aggregate, 10, 0);
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(aggregate.state.thresholdObligationsIssued).toEqual([]);

    aggregate = rally(aggregate, "A");
    expect(aggregate.state.pendingObligations.map((item) => item.type).sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);
  });

  it("换边已执行后退回阈值之前：生成物理场地核对，不改写物理端", () => {
    let aggregate = open(singleGame21Demo);
    aggregate = rally(aggregate, "A", 11);
    aggregate = settle(aggregate);
    const ends = aggregate.state.physicalEnds;

    aggregate = corrected(aggregate, 10, 0);
    expect(aggregate.state.physicalEnds).toEqual(ends);
    expect(aggregate.state.pendingObligations.map((item) => item.type)).toEqual(["PHYSICAL_ENDS_REVIEW"]);
    expect(roundTrip(aggregate)).toEqual(aggregate.state);
  });

  it("没有 obligationModel 的历史更正事件按原推导重放，不被新规则拒绝", () => {
    let aggregate = open(traditional21Demo);
    aggregate = rally(aggregate, "A", 11);
    const legacyReplacement = {
      ...deriveScoreCorrectionReplacement(aggregate.state, {
        score: { A: 11, B: 1 },
        servingSide: "A",
        serverPlayerId: "A1",
        receiverPlayerId: "B1",
      }),
      // 旧推导会把已发出的间歇一并丢掉。
      pendingObligations: [],
      phase: "IN_PROGRESS" as const,
    };
    aggregate = accept(aggregate, command("CORRECT_SCORE_STATE", { reason: "历史更正", replacement: legacyReplacement }));
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(roundTrip(aggregate)).toEqual(aggregate.state);
  });

  it("新版本标记下提交旧推导的结果会被拒绝", () => {
    let aggregate = open(traditional21Demo);
    aggregate = rally(aggregate, "A", 11);
    const replacement = {
      ...deriveScoreCorrectionReplacement(aggregate.state, {
        score: { A: 11, B: 1 },
        servingSide: "A",
        serverPlayerId: "A1",
        receiverPlayerId: "B1",
      }),
      pendingObligations: [],
      phase: "IN_PROGRESS" as const,
    };
    const result = applyCommand(aggregate, command("CORRECT_SCORE_STATE", {
      reason: "试图跳过间歇",
      replacement,
      obligationModel: SCORE_CORRECTION_OBLIGATION_MODEL,
    }));
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.error.code).toBe("corrected_obligations_inconsistent");
  });
});

/**
 * 来源：requirements/review-70fff5e/tests/referee-boundary-regressions.review.test.ts（审查草案，基线 70fff5e）。
 * 本机按原断言先记录真实红灯，再最小修复；不覆盖 tests/domain 既有用例。
 * Review first, then copy into tests/domain/ without replacing existing tests.
 * No database/network access in this file. Check the repository test runner:
 * the root `pnpm test` script prepares a database before starting Vitest.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createMatchAggregate,
  deriveScoreCorrectionReplacement,
  replayMatch,
  type MatchAggregate,
  type MatchCommand,
  type MatchState,
  type Side,
} from "@/domain/rules/match-engine";
import {
  alternative3x15Demo,
  hashRuleConfig,
  singleGame21Demo,
  traditional21Demo,
  type RuleConfig,
} from "@/domain/rules/rule-profile";

function command<T extends MatchCommand["type"]>(
  type: T,
  payload: Extract<MatchCommand, { type: T }>["payload"],
): Extract<MatchCommand, { type: T }> {
  return {
    commandId: randomUUID(),
    occurredAt: "2026-09-21T00:00:00.000Z",
    type,
    payload,
  } as Extract<MatchCommand, { type: T }>;
}

function accepted(
  aggregate: MatchAggregate,
  next: MatchCommand,
): MatchAggregate {
  const result = applyCommand(aggregate, next);
  if (result.status !== "accepted") {
    throw new Error(
      result.status === "rejected"
        ? `${next.type}: ${result.error.code}: ${result.error.message}`
        : `${next.type}: unexpected duplicate`,
    );
  }
  return result.aggregate;
}

function openSingles(config: RuleConfig): MatchAggregate {
  let aggregate = createMatchAggregate({
    matchId: `review-${randomUUID()}`,
    format: "SINGLES",
    players: { A: ["A1"], B: ["B1"] },
    ruleConfig: config,
    ruleConfigHash: hashRuleConfig(config),
  });
  aggregate = accepted(aggregate, command("RECORD_COIN_TOSS", {
    valid: true,
    winnerSide: "A",
    winnerChoice: { kind: "SERVICE", decision: "SERVE" },
    loserChoice: { kind: "END", end: "END_2" },
  }));
  return accepted(aggregate, command("CONFIRM_OPENING_SETUP", {
    serverPlayerId: "A1",
    receiverPlayerId: "B1",
    logicalCourts: null,
  }));
}

function point(aggregate: MatchAggregate, side: Side): MatchAggregate {
  return accepted(aggregate, command("RALLY_WON", { side }));
}

/** Acknowledge exactly the obligations present at entry, not new ones later. */
function acknowledgePresent(aggregate: MatchAggregate): MatchAggregate {
  const present = [...aggregate.state.pendingObligations];
  for (const item of present) {
    if (item.type === "INTERVAL") {
      aggregate = accepted(aggregate, command("ACKNOWLEDGE_INTERVAL", {
        obligationId: item.id,
      }));
    } else if (item.type === "CHANGE_ENDS") {
      aggregate = accepted(aggregate, command("CONFIRM_CHANGE_ENDS", {
        obligationId: item.id,
      }));
    } else {
      throw new Error(`Unexpected review obligation: ${item.type}`);
    }
  }
  return aggregate;
}

function firstThreshold(config: RuleConfig): MatchAggregate {
  let aggregate = openSingles(config);
  for (let index = 0; index < config.intervalAt; index += 1) {
    aggregate = point(aggregate, "A");
  }
  expect(aggregate.state.phase).toBe("OBLIGATIONS_PENDING");
  expect(aggregate.state.pendingObligations.filter(
    (item) => item.type === "INTERVAL",
  )).toHaveLength(1);
  return aggregate;
}

const profiles = [
  { name: "traditional 21 first game", config: traditional21Demo },
  { name: "alternative 3x15 first game", config: alternative3x15Demo },
  { name: "single-game 21 (also needs a change of ends)", config: singleGame21Demo },
];

describe.each(profiles)("review regressions: $name", ({ config }) => {
  it("RV3-001: opponent scoring while leader stays at threshold does not repeat obligations", () => {
    let aggregate = acknowledgePresent(firstThreshold(config));
    const endsAfterAcknowledgement = structuredClone(aggregate.state.physicalEnds);
    expect(aggregate.state.phase).toBe("IN_PROGRESS");

    for (let scoreB = 1; scoreB <= 3; scoreB += 1) {
      aggregate = point(aggregate, "B");
      expect(aggregate.state.score).toEqual({ A: config.intervalAt, B: scoreB });
      expect(aggregate.state.pendingObligations).toEqual([]);
      expect(aggregate.state.phase).toBe("IN_PROGRESS");
      expect(aggregate.state.physicalEnds).toEqual(endsAfterAcknowledgement);
    }
  });

  it("RV3-001: trailing player reaching threshold later does not repeat obligations", () => {
    let aggregate = acknowledgePresent(firstThreshold(config));
    aggregate = point(aggregate, "A");
    const endsAfterAcknowledgement = structuredClone(aggregate.state.physicalEnds);
    for (let scoreB = 1; scoreB <= config.intervalAt; scoreB += 1) {
      aggregate = point(aggregate, "B");
      expect(aggregate.state.pendingObligations).toEqual([]);
      expect(aggregate.state.phase).toBe("IN_PROGRESS");
    }
    expect(aggregate.state.score).toEqual({
      A: config.intervalAt + 1,
      B: config.intervalAt,
    });
    expect(aggregate.state.physicalEnds).toEqual(endsAfterAcknowledgement);
  });

  it("RV3-003: resolve pending tasks while paused then resume to a scoring state", () => {
    let aggregate = firstThreshold(config);
    aggregate = accepted(aggregate, command("PAUSE_MATCH", {
      reason: "暂停期间核对场地事项",
    }));
    expect(aggregate.state.phase).toBe("PAUSED");

    aggregate = acknowledgePresent(aggregate);
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(aggregate.state.phase).toBe("PAUSED");

    aggregate = accepted(aggregate, command("RESUME_MATCH", {
      reason: "事项处理完毕，恢复比赛",
    }));
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    // A leaves the threshold; avoid conflating this assertion with RV3-001.
    aggregate = point(aggregate, "A");
    expect(aggregate.state.score.A).toBe(config.intervalAt + 1);
  });
});

/**
 * These two should already be supported by the old DOMAIN implementation.
 * They do NOT prove RV3-004 is fixed: add browser tests for a real undo entry.
 */
describe.each([
  { name: "game-winning point", config: traditional21Demo, phase: "GAME_COMPLETE" },
  { name: "match-winning point", config: singleGame21Demo, phase: "MATCH_COMPLETE_PENDING_SUBMISSION" },
])("preserve domain undo: $name", ({ config, phase }) => {
  it("can undo the last unsubmitted ending point with no subsequent actions", () => {
    let aggregate = openSingles(config);
    for (let scoreA = 1; scoreA < config.targetPoints; scoreA += 1) {
      aggregate = point(aggregate, "A");
      if (scoreA === config.intervalAt) aggregate = acknowledgePresent(aggregate);
    }
    const before = structuredClone(aggregate.state);
    aggregate = point(aggregate, "A");
    expect(aggregate.state.phase).toBe(phase);

    aggregate = accepted(aggregate, command("UNDO_LAST_REVERSIBLE", {
      reason: "撤销误点的结束得分",
    }));
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    expect(aggregate.state.score).toEqual(before.score);
    expect(aggregate.state.physicalEnds).toEqual(before.physicalEnds);
    expect(aggregate.state.serverPlayerId).toBe(before.serverPlayerId);
    expect(aggregate.state.version).toBeGreaterThan(before.version);
  });
});

/* ------------------------------------------------------------------ *
 * 本机补充用例（草案未覆盖）：RV3-003 部分处理 / RV3-006 更正推导 / RV3-002 抛币组合。
 * ------------------------------------------------------------------ */

describe("RV3-003 暂停期间处理待办的边界", () => {
  it("只处理部分待办时恢复仍停在待办相位", () => {
    // 单局 21 的阈值同时产生间歇和决胜局换边两项。
    let aggregate = firstThreshold(singleGame21Demo);
    expect(aggregate.state.pendingObligations).toHaveLength(2);
    aggregate = accepted(aggregate, command("PAUSE_MATCH", { reason: "暂停核对" }));

    const interval = aggregate.state.pendingObligations.find((item) => item.type === "INTERVAL")!;
    aggregate = accepted(aggregate, command("ACKNOWLEDGE_INTERVAL", { obligationId: interval.id }));
    expect(aggregate.state.pendingObligations).toHaveLength(1);

    aggregate = accepted(aggregate, command("RESUME_MATCH", { reason: "恢复" }));
    expect(aggregate.state.phase).toBe("OBLIGATIONS_PENDING");
    expect(aggregate.state.pendingObligations).toHaveLength(1);
  });

  it("暂停期间用物理端更正完成换边义务，恢复后可以直接记分", () => {
    let aggregate = firstThreshold(singleGame21Demo);
    aggregate = accepted(aggregate, command("PAUSE_MATCH", { reason: "暂停核对" }));
    const interval = aggregate.state.pendingObligations.find((item) => item.type === "INTERVAL")!;
    aggregate = accepted(aggregate, command("ACKNOWLEDGE_INTERVAL", { obligationId: interval.id }));
    const changeEnds = aggregate.state.pendingObligations.find((item) => item.type === "CHANGE_ENDS")!;
    const before = structuredClone(aggregate.state.physicalEnds!);

    aggregate = accepted(aggregate, command("CORRECT_PHYSICAL_ENDS", {
      reason: "暂停期间已实际换边",
      physicalEnds: { A: before.B, B: before.A },
      obligationRelationship: { obligationId: changeEnds.id, action: "FULFILL" },
    }));
    expect(aggregate.state.phase).toBe("PAUSED");
    expect(aggregate.state.pendingObligations).toEqual([]);

    aggregate = accepted(aggregate, command("RESUME_MATCH", { reason: "恢复" }));
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    aggregate = point(aggregate, "B");
    expect(aggregate.state.score).toEqual({ A: singleGame21Demo.intervalAt, B: 1 });
  });

  it("暂停期间不处理待办时恢复相位不变", () => {
    let aggregate = firstThreshold(traditional21Demo);
    aggregate = accepted(aggregate, command("PAUSE_MATCH", { reason: "暂停" }));
    aggregate = accepted(aggregate, command("RESUME_MATCH", { reason: "恢复" }));
    expect(aggregate.state.phase).toBe("OBLIGATIONS_PENDING");
    expect(aggregate.state.pendingObligations).toHaveLength(1);
  });
});

describe("RV3-006 完整比分更正的待办推导", () => {
  /** 旧界面的做法：原样照搬当前 pendingObligations 与相位。 */
  function staleReplacement(state: MatchState, score: { A: number; B: number }) {
    return {
      score,
      gamesWon: state.gamesWon,
      completedGames: state.completedGames,
      servingSide: state.servingSide!,
      serverPlayerId: state.serverPlayerId!,
      receiverPlayerId: state.receiverPlayerId!,
      logicalCourts: state.logicalCourts,
      pendingObligations: state.pendingObligations,
      phase: state.pendingObligations.length > 0 ? ("OBLIGATIONS_PENDING" as const) : ("IN_PROGRESS" as const),
    };
  }

  function intent(state: MatchState, score: { A: number; B: number }) {
    return deriveScoreCorrectionReplacement(state, {
      score,
      servingSide: state.servingSide!,
      serverPlayerId: state.serverPlayerId!,
      receiverPlayerId: state.receiverPlayerId!,
    });
  }

  function at10to8() {
    let aggregate = openSingles(traditional21Demo);
    for (let index = 0; index < 10; index += 1) aggregate = point(aggregate, "A");
    for (let index = 0; index < 8; index += 1) aggregate = point(aggregate, "B");
    expect(aggregate.state.score).toEqual({ A: 10, B: 8 });
    expect(aggregate.state.pendingObligations).toEqual([]);
    return aggregate;
  }

  it("旧界面照搬待办的 10:8→11:8 会被领域层拒绝（复现）", () => {
    const aggregate = at10to8();
    const result = applyCommand(aggregate, command("CORRECT_SCORE_STATE", {
      reason: "记录员登记错误",
      replacement: staleReplacement(aggregate.state, { A: 11, B: 8 }),
    }));
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.error.code).toBe("corrected_obligations_inconsistent");
  });

  it("共用推导后 10:8→11:8 被接受并生成间歇义务", () => {
    let aggregate = at10to8();
    aggregate = accepted(aggregate, command("CORRECT_SCORE_STATE", {
      reason: "记录员登记错误",
      replacement: intent(aggregate.state, { A: 11, B: 8 }),
    }));
    expect(aggregate.state.phase).toBe("OBLIGATIONS_PENDING");
    expect(aggregate.state.pendingObligations.map((item) => item.type)).toEqual(["INTERVAL"]);
  });

  it("更正回 11:8→10:8 撤回本局阈值事实且不遗留待办", () => {
    let aggregate = at10to8();
    aggregate = accepted(aggregate, command("CORRECT_SCORE_STATE", {
      reason: "登记错误", replacement: intent(aggregate.state, { A: 11, B: 8 }),
    }));
    aggregate = accepted(aggregate, command("CORRECT_SCORE_STATE", {
      reason: "再次核对录像", replacement: intent(aggregate.state, { A: 10, B: 8 }),
    }));
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    expect(aggregate.state.pendingObligations).toEqual([]);
    expect(aggregate.state.thresholdObligationsIssued).toEqual([]);

    // 撤回后再次真实到达阈值仍要触发一次。
    aggregate = point(aggregate, "A");
    expect(aggregate.state.pendingObligations.map((item) => item.type)).toEqual(["INTERVAL"]);
  });

  it("阈值事项已处理后更正另一方比分不会重新生成间歇", () => {
    let aggregate = acknowledgePresent(firstThreshold(traditional21Demo));
    aggregate = point(aggregate, "B");
    aggregate = accepted(aggregate, command("CORRECT_SCORE_STATE", {
      reason: "对方比分登记少了两分",
      replacement: intent(aggregate.state, { A: traditional21Demo.intervalAt, B: 3 }),
    }));
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("撤销后留下的物理端核对待办不会被比分更正吞掉", () => {
    let aggregate = firstThreshold(singleGame21Demo);
    aggregate = acknowledgePresent(aggregate); // 含实际换边
    // 撤销触发阈值的那一分：换边已实际执行，必须留下人工核对待办。
    aggregate = accepted(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "误点" }));
    const review = aggregate.state.pendingObligations.filter((item) => item.type === "PHYSICAL_ENDS_REVIEW");
    expect(review).toHaveLength(1);

    const derived = intent(aggregate.state, { A: singleGame21Demo.intervalAt - 1, B: 2 });
    expect(derived.pendingObligations.map((item) => item.type)).toEqual(["PHYSICAL_ENDS_REVIEW"]);
    expect(derived.phase).toBe("OBLIGATIONS_PENDING");
  });
});

describe("RV3-002 抛币四类组合都落到正确的发球方与场地端", () => {
  const combinations = [
    { winner: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_1" }, servingSide: "A", ends: { A: "END_2", B: "END_1" } },
    { winner: "A", winnerChoice: { kind: "SERVICE", decision: "RECEIVE" }, loserChoice: { kind: "END", end: "END_2" }, servingSide: "B", ends: { A: "END_1", B: "END_2" } },
    { winner: "B", winnerChoice: { kind: "END", end: "END_1" }, loserChoice: { kind: "SERVICE", decision: "SERVE" }, servingSide: "A", ends: { A: "END_2", B: "END_1" } },
    { winner: "B", winnerChoice: { kind: "END", end: "END_2" }, loserChoice: { kind: "SERVICE", decision: "RECEIVE" }, servingSide: "B", ends: { A: "END_1", B: "END_2" } },
  ] as const;

  it.each(combinations)("$winner 胜、$winnerChoice.kind 类别", (combination) => {
    let aggregate = createMatchAggregate({
      matchId: `coin-${randomUUID()}`,
      format: "SINGLES",
      players: { A: ["A1"], B: ["B1"] },
      ruleConfig: traditional21Demo,
      ruleConfigHash: hashRuleConfig(traditional21Demo),
    });
    aggregate = accepted(aggregate, command("RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: combination.winner,
      winnerChoice: combination.winnerChoice,
      loserChoice: combination.loserChoice,
    }));
    expect(aggregate.state.servingSide).toBe(combination.servingSide);
    expect(aggregate.state.physicalEnds).toEqual(combination.ends);
  });
});

describe("RV3-003 修改后的历史兼容", () => {
  it("正常暂停/恢复历史（待办本来为空）重放结果逐字不变", () => {
    let aggregate = openSingles(traditional21Demo);
    aggregate = point(aggregate, "A");
    aggregate = accepted(aggregate, command("PAUSE_MATCH", { reason: "场地积水" }));
    aggregate = accepted(aggregate, command("RESUME_MATCH", { reason: "处理完毕" }));
    aggregate = point(aggregate, "B");

    // replayMatch 会逐条比较命令重算结果与已记录事件的完整前后快照。
    const replayed = replayMatch(aggregate.initialState, aggregate.events);
    expect(replayed).toEqual(aggregate.state);
    expect(replayed.phase).toBe("IN_PROGRESS");
  });

  it("暂停期间处理待办后的恢复只影响 RESUME_MATCH 自身的产出", () => {
    let aggregate = firstThreshold(traditional21Demo);
    aggregate = accepted(aggregate, command("PAUSE_MATCH", { reason: "暂停" }));
    const interval = aggregate.state.pendingObligations[0];
    aggregate = accepted(aggregate, command("ACKNOWLEDGE_INTERVAL", { obligationId: interval.id }));

    // 处理待办产出的事件与旧引擎一致：暂停中相位不变、恢复目标字段不被改写。
    const ackEvent = aggregate.events[aggregate.events.length - 1];
    expect(ackEvent.type).toBe("ACKNOWLEDGE_INTERVAL");
    expect(ackEvent.stateAfter.phase).toBe("PAUSED");
    expect(ackEvent.stateAfter.pausedFromPhase).toBe("OBLIGATIONS_PENDING");

    aggregate = accepted(aggregate, command("RESUME_MATCH", { reason: "恢复" }));
    expect(replayMatch(aggregate.initialState, aggregate.events)).toEqual(aggregate.state);
  });
});

/**
 * REVIEW DRAFT — baseline 70fff5e87c9252e0bd6cbd13060d6d870dd4cd37.
 * Not executed against the project by the reviewer. Syntax check only.
 * Review first, then copy into tests/domain/ without replacing existing tests.
 * No database/network access in this file. Check the repository test runner:
 * the root `pnpm test` script prepares a database before starting Vitest.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createMatchAggregate,
  type MatchAggregate,
  type MatchCommand,
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

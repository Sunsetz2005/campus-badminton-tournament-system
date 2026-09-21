import { describe, expect, it } from "vitest";

import trajectory from "../fixtures/referee-acceptance-trajectory.json" with { type: "json" };

import {
  applyCommand,
  createMatchAggregate,
  type MatchAggregate,
  type MatchCommand,
} from "@/domain/rules/match-engine";
import { hashRuleConfig, traditional21Demo, type RuleConfig } from "@/domain/rules/rule-profile";

/**
 * 裁判工作台改造验收轨迹（来源：requirements 包 acceptance/双打验收轨迹.json，2026-09-20 复制进仓库）。
 *
 * 该 JSON 是按 BWF Laws 10—12 推导的合成数据，使用虚拟身份 A1/A2/B1/B2，不含真实学生信息。
 * 这里逐步断言的是比分、双方 R/L 人员分配、发球员与接发员，而不只是比分。
 * 注意 JSON 用 LEFT/RIGHT 表示逻辑发球区，引擎用 L/R；两者只是命名差异。
 */

let commandNumber = 0;

function command<T extends MatchCommand["type"]>(
  type: T,
  payload: Extract<MatchCommand, { type: T }>["payload"],
) {
  commandNumber += 1;
  return {
    commandId: `00000000-0000-4000-9000-${String(commandNumber).padStart(12, "0")}`,
    occurredAt: `2026-09-20T09:${String(commandNumber % 60).padStart(2, "0")}:00.000Z`,
    type,
    payload,
  } as Extract<MatchCommand, { type: T }>;
}

function accept(aggregate: MatchAggregate, nextCommand: MatchCommand) {
  const result = applyCommand(aggregate, nextCommand);
  if (result.status !== "accepted") {
    throw new Error(result.status === "rejected" ? result.error.message : "命令意外被判定为重复。");
  }
  return result.aggregate;
}

function createMatch(format: "SINGLES" | "DOUBLES", ruleConfig: RuleConfig = traditional21Demo) {
  return createMatchAggregate({
    matchId: `acceptance-${format.toLowerCase()}`,
    format,
    players: format === "DOUBLES" ? { A: ["A1", "A2"], B: ["B1", "B2"] } : { A: ["A1"], B: ["B1"] },
    ruleConfig,
    ruleConfigHash: hashRuleConfig(ruleConfig),
  });
}

/** 按 JSON 的 assumptions：A1 首发、B1 首接、0:0。 */
function openDoubles() {
  let aggregate = createMatch("DOUBLES");
  aggregate = accept(
    aggregate,
    command("RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: "A",
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    }),
  );
  return accept(
    aggregate,
    command("CONFIRM_OPENING_SETUP", {
      serverPlayerId: "A1",
      receiverPlayerId: "B1",
      logicalCourts: { A: { R: "A1", L: "A2" }, B: { R: "B1", L: "B2" } },
    }),
  );
}

function openSingles(servingSide: "A" | "B") {
  let aggregate = createMatch("SINGLES");
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

/** 把 JSON 的 {LEFT,RIGHT} 写法转换成引擎的 {L,R}。 */
function toEngineCourts(positions: { LEFT: string; RIGHT: string }) {
  return { L: positions.LEFT, R: positions.RIGHT };
}

describe("裁判工作台验收轨迹（合成数据，非用户项目测试结果）", () => {
  it("双打九步轨迹逐步匹配比分、双方 R/L 分配、发球员和接发员", () => {
    let aggregate = openDoubles();
    const steps = trajectory.doubles;

    // step 0 是开局后的待发状态，不打回合。
    const opening = steps[0].expected;
    expect(aggregate.state).toMatchObject({
      score: opening.score,
      servingSide: opening.servingSideId,
      serverPlayerId: opening.serverId,
      receiverPlayerId: opening.receiverId,
      serverCourt: opening.serviceCourt === "RIGHT" ? "R" : "L",
      logicalCourts: { A: toEngineCourts(opening.positions.A), B: toEngineCourts(opening.positions.B) },
    });

    for (const step of steps.slice(1)) {
      aggregate = accept(aggregate, command("RALLY_WON", { side: step.rallyWinner as "A" | "B" }));
      const expected = step.expected;
      expect(aggregate.state, `第 ${step.step} 步`).toMatchObject({
        score: expected.score,
        servingSide: expected.servingSideId,
        serverPlayerId: expected.serverId,
        receiverPlayerId: expected.receiverId,
        serverCourt: expected.serviceCourt === "RIGHT" ? "R" : "L",
        logicalCourts: { A: toEngineCourts(expected.positions.A), B: toEngineCourts(expected.positions.B) },
      });
      // 接发球员永远在发球员同名的逻辑发球区（即物理对角）。
      expect(aggregate.state.receiverCourt).toBe(aggregate.state.serverCourt);
    }

    // A/B 身份与名单全程稳定，比分口径不因发球方改变而互换。
    expect(aggregate.state.players).toEqual({ A: ["A1", "A2"], B: ["B1", "B2"] });
    expect(aggregate.state.score).toEqual({ A: 5, B: 3 });
  });

  it("单打双方发球区只由当前发球方的分数决定（4:3 强制覆盖）", () => {
    // JSON singles：A=4、B=3、B 发球时双方均在各自逻辑左区。
    let aggregate = openSingles("B");
    // B 发球开局，打到 A=4 / B=3。
    for (const winner of ["A", "A", "A", "A", "B", "B", "B"] as const) {
      aggregate = accept(aggregate, command("RALLY_WON", { side: winner }));
    }
    expect(aggregate.state).toMatchObject({ score: { A: 4, B: 3 }, servingSide: "B" });

    const expectations = trajectory.singles;
    // 第 1 项：4:3，B 发球，双方 LEFT。
    expect(aggregate.state.serverCourt).toBe(expectations[0].expectedCourts.B === "LEFT" ? "L" : "R");
    expect(aggregate.state.receiverCourt).toBe(expectations[0].expectedCourts.A === "LEFT" ? "L" : "R");

    // 第 2 项：B 再得分 4:4，双方转为各自 RIGHT。
    aggregate = accept(aggregate, command("RALLY_WON", { side: "B" }));
    expect(aggregate.state).toMatchObject({ score: { A: 4, B: 4 }, servingSide: "B", serverCourt: "R", receiverCourt: "R" });

    // 第 3 项：A 随后得分 5:4，A 发球且双方均为各自 LEFT。
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state).toMatchObject({ score: { A: 5, B: 4 }, servingSide: "A", serverCourt: "L", receiverCourt: "L" });
  });

  it("单打发球权转移后不是每分必换区（1:2 → 1:3 仍在左区）", () => {
    const sample = trajectory.singleCourtNotAlwaysToggled;
    let aggregate = openSingles("A");
    // 打到 1:2 且仍由 A 发球：A 必须是最后一分的胜者，所以顺序是 B、B、A。
    for (const winner of ["B", "B", "A"] as const) {
      aggregate = accept(aggregate, command("RALLY_WON", { side: winner }));
    }
    expect(aggregate.state).toMatchObject({ score: sample.before.score, servingSide: sample.before.servingSideId });
    expect(aggregate.state.serverCourt).toBe(sample.before.courts.A === "LEFT" ? "L" : "R");

    aggregate = accept(aggregate, command("RALLY_WON", { side: sample.rallyWinner as "A" | "B" }));
    expect(aggregate.state).toMatchObject({ score: sample.after.score, servingSide: sample.after.servingSideId });
    // 发球权从 A 转到 B，但 B 的新分数 3 仍是奇数，双方仍在左区。
    expect(aggregate.state.serverCourt).toBe(sample.after.courts.B === "LEFT" ? "L" : "R");
    expect(aggregate.state.receiverCourt).toBe(sample.after.courts.A === "LEFT" ? "L" : "R");
  });

  describe("手动更正后以更正结果为新基线", () => {
    /** 把双打推进到 JSON 的 doubles[step]。 */
    function doublesAtStep(step: number) {
      let aggregate = openDoubles();
      for (const item of trajectory.doubles.slice(1, step + 1)) {
        aggregate = accept(aggregate, command("RALLY_WON", { side: item.rallyWinner as "A" | "B" }));
      }
      return aggregate;
    }

    for (const scenario of trajectory.manualCorrectionScenarios) {
      it(scenario.name, () => {
        let aggregate = doublesAtStep(scenario.baseDoublesStep);
        const before = aggregate.state;
        const correctedSide = scenario.correction.sideId as "A" | "B";
        const current = before.logicalCourts![correctedSide];

        aggregate = accept(
          aggregate,
          command("CORRECT_LOGICAL_COURTS", {
            reason: scenario.correction.reason,
            logicalCourts: {
              ...before.logicalCourts!,
              [correctedSide]: { R: current.L, L: current.R },
            },
          }),
        );

        const immediate = scenario.expectedImmediately;
        expect(aggregate.state).toMatchObject({
          score: immediate.score,
          servingSide: immediate.servingSideId,
          serverPlayerId: immediate.serverId,
          receiverPlayerId: immediate.receiverId,
          logicalCourts: { A: toEngineCourts(immediate.positions.A), B: toEngineCourts(immediate.positions.B) },
        });
        // 位置更正不改比分。
        expect(aggregate.state.score).toEqual(before.score);

        // 之后的自动计算以已确认更正为新基线，不回到错误的旧位置。
        aggregate = accept(aggregate, command("RALLY_WON", { side: scenario.nextRallyWinner as "A" | "B" }));
        const next = scenario.expectedAfterNextRally;
        expect(aggregate.state).toMatchObject({
          score: next.score,
          servingSide: next.servingSideId,
          serverPlayerId: next.serverId,
          receiverPlayerId: next.receiverId,
          logicalCourts: { A: toEngineCourts(next.positions.A), B: toEngineCourts(next.positions.B) },
        });
      });
    }
  });

  it("未确认首发时不存在当前发球员，不能伪造发球标记", () => {
    const aggregate = createMatch("DOUBLES");
    expect(aggregate.state).toMatchObject({
      phase: "AWAITING_COIN_TOSS",
      servingSide: null,
      serverPlayerId: null,
      receiverPlayerId: null,
      serverCourt: null,
      receiverCourt: null,
    });
  });

  it("单打不接受双打 R/L 分配，避免用四人假数据填满单打", () => {
    const aggregate = openSingles("A");
    const result = applyCommand(
      aggregate,
      command("CORRECT_LOGICAL_COURTS", {
        reason: "单打非法单侧移动",
        logicalCourts: { A: { R: "A1", L: "A1" }, B: { R: "B1", L: "B1" } },
      }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.error.code).toBe("singles_has_pair_courts");
  });
});

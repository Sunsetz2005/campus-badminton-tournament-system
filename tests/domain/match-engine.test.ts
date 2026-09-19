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

let commandNumber = 0;

function command<T extends MatchCommand["type"]>(
  type: T,
  payload: Extract<MatchCommand, { type: T }>["payload"],
  commandId?: string,
) {
  commandNumber += 1;
  return {
    commandId: commandId ?? `00000000-0000-4000-8000-${String(commandNumber).padStart(12, "0")}`,
    occurredAt: `2026-09-18T12:${String(commandNumber % 60).padStart(2, "0")}:00.000Z`,
    type,
    payload,
  } as Extract<MatchCommand, { type: T }>;
}

function accept(aggregate: MatchAggregate, nextCommand: MatchCommand) {
  const result = applyCommand(aggregate, nextCommand);
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error(result.status === "rejected" ? result.error.message : "测试命令意外被判定为重复。");
  }
  return result.aggregate;
}

function createDoubles(ruleConfig: RuleConfig = traditional21Demo) {
  return createMatchAggregate({
    matchId: "match-doubles",
    format: "DOUBLES",
    players: { A: ["A1", "A2"], B: ["B1", "B2"] },
    ruleConfig,
    ruleConfigHash: hashRuleConfig(ruleConfig),
  });
}

function createSingles(ruleConfig: RuleConfig = traditional21Demo) {
  return createMatchAggregate({
    matchId: "match-singles",
    format: "SINGLES",
    players: { A: ["A1"], B: ["B1"] },
    ruleConfig,
    ruleConfigHash: hashRuleConfig(ruleConfig),
  });
}

function tossAndOpen(aggregate: MatchAggregate, servingSide: "A" | "B" = "A") {
  const other = servingSide === "A" ? "B" : "A";
  aggregate = accept(
    aggregate,
    command("RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: servingSide,
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    }),
  );
  const doubles = aggregate.state.format === "DOUBLES";
  return accept(
    aggregate,
    command("CONFIRM_OPENING_SETUP", {
      serverPlayerId: servingSide === "A" ? "A1" : "B1",
      receiverPlayerId: other === "A" ? "A1" : "B1",
      logicalCourts: doubles
        ? {
            A: { R: "A1", L: "A2" },
            B: { R: "B1", L: "B2" },
          }
        : null,
    }),
  );
}

function replacement(state: MatchState, scoreA: number, scoreB: number): ScoreStateReplacement {
  const servingScore = state.servingSide === "A" ? scoreA : scoreB;
  const court = servingScore % 2 === 0 ? "R" : "L";
  const serverPlayerId =
    state.format === "DOUBLES" ? state.logicalCourts![state.servingSide!][court] : state.players[state.servingSide!][0];
  const receivingSide = state.servingSide === "A" ? "B" : "A";
  const receiverPlayerId =
    state.format === "DOUBLES" ? state.logicalCourts![receivingSide][court] : state.players[receivingSide][0];
  return {
    score: { A: scoreA, B: scoreB },
    gamesWon: state.gamesWon,
    completedGames: state.completedGames,
    servingSide: state.servingSide!,
    serverPlayerId,
    receiverPlayerId,
    logicalCourts: state.logicalCourts,
    pendingObligations: [],
    phase: "IN_PROGRESS",
  };
}

function clearObligations(aggregate: MatchAggregate) {
  while (aggregate.state.pendingObligations.length > 0) {
    const pending = aggregate.state.pendingObligations[0];
    aggregate = accept(
      aggregate,
      pending.type === "INTERVAL"
        ? command("ACKNOWLEDGE_INTERVAL", { obligationId: pending.id })
        : command("CONFIRM_CHANGE_ENDS", { obligationId: pending.id }),
    );
  }
  return aggregate;
}

describe("阶段 2 纯规则引擎", () => {
  it("逐分执行双打黄金轨迹并保持固定 A/B 身份", () => {
    let aggregate = tossAndOpen(createDoubles());
    const expected = [
      ["A", 1, 0, "A1", "B2", "A2", "A1", "B1", "B2"],
      ["A", 2, 0, "A1", "B1", "A1", "A2", "B1", "B2"],
      ["B", 2, 1, "B2", "A2", "A1", "A2", "B1", "B2"],
      ["B", 2, 2, "B2", "A1", "A1", "A2", "B2", "B1"],
      ["A", 3, 2, "A2", "B1", "A1", "A2", "B2", "B1"],
      ["A", 4, 2, "A2", "B2", "A2", "A1", "B2", "B1"],
      ["B", 4, 3, "B1", "A1", "A2", "A1", "B2", "B1"],
    ] as const;

    for (const [winner, scoreA, scoreB, server, receiver, aR, aL, bR, bL] of expected) {
      aggregate = accept(aggregate, command("RALLY_WON", { side: winner }));
      expect(aggregate.state).toMatchObject({
        score: { A: scoreA, B: scoreB },
        serverPlayerId: server,
        receiverPlayerId: receiver,
        logicalCourts: { A: { R: aR, L: aL }, B: { R: bR, L: bL } },
      });
    }
    expect(aggregate.state.players).toEqual({ A: ["A1", "A2"], B: ["B1", "B2"] });
    expect(aggregate.state).not.toHaveProperty("screenOrientation");
  });

  it("支持 B 方首发和不同首接球员，不把黄金轨迹硬编码", () => {
    let aggregate = createDoubles();
    aggregate = accept(
      aggregate,
      command("RECORD_COIN_TOSS", {
        valid: true,
        winnerSide: "B",
        winnerChoice: { kind: "SERVICE", decision: "SERVE" },
        loserChoice: { kind: "END", end: "END_1" },
      }),
    );
    aggregate = accept(
      aggregate,
      command("CONFIRM_OPENING_SETUP", {
        serverPlayerId: "B2",
        receiverPlayerId: "A2",
        logicalCourts: { A: { R: "A2", L: "A1" }, B: { R: "B2", L: "B1" } },
      }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state).toMatchObject({ servingSide: "A", serverPlayerId: "A1", receiverPlayerId: "B1" });
  });

  it("抛币可记录无效结果；胜方选场地时负方选择发或接", () => {
    let aggregate = createSingles();
    aggregate = accept(
      aggregate,
      command("RECORD_COIN_TOSS", { valid: false, reason: "硬币落入遮挡区域" }),
    );
    expect(aggregate.state.phase).toBe("AWAITING_COIN_TOSS");
    aggregate = accept(
      aggregate,
      command("RECORD_COIN_TOSS", {
        valid: true,
        winnerSide: "A",
        winnerChoice: { kind: "END", end: "END_1" },
        loserChoice: { kind: "SERVICE", decision: "RECEIVE" },
      }),
    );
    expect(aggregate.state).toMatchObject({
      phase: "AWAITING_OPENING_SETUP",
      servingSide: "A",
      physicalEnds: { A: "END_1", B: "END_2" },
    });
    expect(replayMatch(aggregate.initialState, aggregate.events)).toEqual(aggregate.state);
  });

  it("单打按比分奇偶更新发球区和发球权", () => {
    let aggregate = tossAndOpen(createSingles());
    expect(aggregate.state.serverCourt).toBe("R");
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state).toMatchObject({ score: { A: 1, B: 0 }, servingSide: "A", serverCourt: "L" });
    aggregate = accept(aggregate, command("RALLY_WON", { side: "B" }));
    expect(aggregate.state).toMatchObject({ score: { A: 1, B: 1 }, servingSide: "B", serverCourt: "L" });
  });

  it("传统 21 分在 20:20 不以 21:20 结束，并在 22:20 结束", () => {
    let aggregate = tossAndOpen(createSingles());
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "边界测试", replacement: replacement(aggregate.state, 20, 20) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.completedGames[0]).toMatchObject({ scoreA: 22, scoreB: 20, winnerSide: "A" });
  });

  it("传统 21 分在 29:29 由下一分 30:29 封顶", () => {
    let aggregate = tossAndOpen(createSingles());
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "封顶测试", replacement: replacement(aggregate.state, 29, 29) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "B" }));
    expect(aggregate.state.completedGames[0]).toMatchObject({ scoreA: 29, scoreB: 30, winnerSide: "B" });
  });

  it("替代 3×15 使用 15/2/21 和 8 分阈值", () => {
    let aggregate = tossAndOpen(createSingles(alternative3x15Demo));
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "替代规则测试", replacement: replacement(aggregate.state, 14, 14) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.phase).toBe("IN_PROGRESS");
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.completedGames[0]).toMatchObject({ scoreA: 16, scoreB: 14 });

    aggregate = tossAndOpen(createSingles(alternative3x15Demo));
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "替代封顶测试", replacement: replacement(aggregate.state, 20, 20) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "B" }));
    expect(aggregate.state.completedGames[0]).toMatchObject({ scoreA: 20, scoreB: 21 });
  });

  it("替代 3×15 的 8 分间歇只触发一次，首局不触发决胜局换边", () => {
    let aggregate = tossAndOpen(createSingles(alternative3x15Demo));
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "8 分阈值", replacement: replacement(aggregate.state, 7, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.pendingObligations).toEqual([
      expect.objectContaining({ type: "INTERVAL", gameNumber: 1 }),
    ]);
    aggregate = clearObligations(aggregate);
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("单局 21 在 11 分同时生成一次间歇和换边义务", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "阈值测试", replacement: replacement(aggregate.state, 10, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.pendingObligations.map((item) => item.type).sort()).toEqual(["CHANGE_ENDS", "INTERVAL"]);
    aggregate = clearObligations(aggregate);
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("局间换边和间歇完成后重新选择首发/首接且不重新抛币", () => {
    let aggregate = tossAndOpen(createDoubles());
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "快速结束首局", replacement: replacement(aggregate.state, 20, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = clearObligations(aggregate);
    expect(aggregate.state.phase).toBe("AWAITING_NEXT_GAME_SETUP");
    const toss = aggregate.state.coinToss;
    aggregate = accept(
      aggregate,
      command("CONFIRM_NEXT_GAME_SETUP", {
        serverPlayerId: "A2",
        receiverPlayerId: "B2",
        logicalCourts: { A: { R: "A2", L: "A1" }, B: { R: "B2", L: "B1" } },
      }),
    );
    expect(aggregate.state).toMatchObject({ currentGame: 2, score: { A: 0, B: 0 }, serverPlayerId: "A2" });
    expect(aggregate.state.coinToss).toEqual(toss);
  });

  it("赢两局结束全场，赛末得分可撤销且结束后拒绝继续加分", () => {
    let aggregate = tossAndOpen(createSingles());
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "首局赛点", replacement: replacement(aggregate.state, 20, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = clearObligations(aggregate);
    aggregate = accept(
      aggregate,
      command("CONFIRM_NEXT_GAME_SETUP", {
        serverPlayerId: "A1",
        receiverPlayerId: "B1",
        logicalCourts: null,
      }),
    );
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "次局赛点", replacement: replacement(aggregate.state, 20, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state).toMatchObject({
      phase: "MATCH_COMPLETE_PENDING_SUBMISSION",
      gamesWon: { A: 2, B: 0 },
    });
    expect(applyCommand(aggregate, command("RALLY_WON", { side: "A" })).status).toBe("rejected");
    aggregate = accept(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "赛末误点" }));
    expect(aggregate.state).toMatchObject({ phase: "IN_PROGRESS", gamesWon: { A: 1, B: 0 }, score: { A: 20, B: 0 } });
  });

  it("撤销普通得分恢复比分、发接发和双打 R/L，重做使用新命令", () => {
    let aggregate = tossAndOpen(createDoubles());
    const before = aggregate.state;
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = accept(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "误点" }));
    expect(aggregate.state).toMatchObject({
      score: before.score,
      servingSide: before.servingSide,
      serverPlayerId: before.serverPlayerId,
      receiverPlayerId: before.receiverPlayerId,
      logicalCourts: before.logicalCourts,
    });
    const undoAgain = applyCommand(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "不允许反撤销" }));
    expect(undoAgain.status).toBe("rejected");
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    expect(aggregate.state.score).toEqual({ A: 1, B: 0 });
  });

  it("撤销阈值分清除待办；已实际换边时要求物理端核对而不静默再换", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "阈值撤销", replacement: replacement(aggregate.state, 10, 0) }),
    );
    const beforeEnds = aggregate.state.physicalEnds;
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = clearObligations(aggregate);
    const changedEnds = aggregate.state.physicalEnds;
    aggregate = accept(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "阈值误点" }));
    expect(aggregate.state.score).toEqual({ A: 10, B: 0 });
    expect(aggregate.state.physicalEnds).toEqual(changedEnds);
    expect(aggregate.state.physicalEnds).not.toEqual(beforeEnds);
    expect(aggregate.state.pendingObligations).toContainEqual(
      expect.objectContaining({ type: "PHYSICAL_ENDS_REVIEW" }),
    );
  });

  it("局末得分可撤销，但后续已有独立操作时拒绝普通撤销", () => {
    let aggregate = tossAndOpen(createSingles());
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "局末撤销", replacement: replacement(aggregate.state, 20, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = accept(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "误判局末分" }));
    expect(aggregate.state).toMatchObject({ phase: "IN_PROGRESS", score: { A: 20, B: 0 }, gamesWon: { A: 0, B: 0 } });

    aggregate = accept(aggregate, command("RALLY_WON", { side: "B" }));
    aggregate = accept(aggregate, command("LET", { reason: "重发球" }));
    expect(applyCommand(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "过晚撤销" })).status).toBe("rejected");
  });

  it("逻辑位置、发接发和物理端更正是不同命令且不改比分", () => {
    let aggregate = tossAndOpen(createDoubles());
    const score = aggregate.state.score;
    aggregate = accept(
      aggregate,
      command("CORRECT_LOGICAL_COURTS", {
        reason: "现场位置纠正",
        logicalCourts: { A: { R: "A2", L: "A1" }, B: { R: "B2", L: "B1" } },
      }),
    );
    aggregate = accept(
      aggregate,
      command("CORRECT_SERVICE_ORDER", {
        reason: "发接发记录纠正",
        servingSide: "A",
        serverPlayerId: "A2",
        receiverPlayerId: "B2",
      }),
    );
    aggregate = accept(
      aggregate,
      command("CORRECT_PHYSICAL_ENDS", {
        reason: "场地端记录纠正",
        physicalEnds: { A: "END_2", B: "END_1" },
      }),
    );
    expect(aggregate.state.score).toEqual(score);
    expect(aggregate.events.slice(-3).map((event) => event.type)).toEqual([
      "CORRECT_LOGICAL_COURTS",
      "CORRECT_SERVICE_ORDER",
      "CORRECT_PHYSICAL_ENDS",
    ]);
  });

  it("漏做换边可以补记，物理核对事项只能由显式端位更正清除", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "漏换边准备", replacement: replacement(aggregate.state, 10, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    const interval = aggregate.state.pendingObligations.find((item) => item.type === "INTERVAL")!;
    const changeEnds = aggregate.state.pendingObligations.find((item) => item.type === "CHANGE_ENDS")!;
    aggregate = accept(aggregate, command("ACKNOWLEDGE_INTERVAL", { obligationId: interval.id }));
    aggregate = accept(
      aggregate,
      command("RECORD_MISSED_CHANGE_ENDS", { obligationId: changeEnds.id, reason: "裁判发现漏换边后补做" }),
    );
    aggregate = accept(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "阈值分误点" }));
    const review = aggregate.state.pendingObligations.find((item) => item.type === "PHYSICAL_ENDS_REVIEW")!;
    aggregate = accept(
      aggregate,
      command("CORRECT_PHYSICAL_ENDS", {
        reason: "已核对现场实际端位",
        physicalEnds: aggregate.state.physicalEnds!,
        fulfillsObligationId: review.id,
      }),
    );
    expect(aggregate.state.pendingObligations).toEqual([]);
  });

  it("暂停恢复和特殊结果保留真实比分，不补造未打局", () => {
    let aggregate = tossAndOpen(createSingles());
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = accept(aggregate, command("PAUSE_MATCH", { reason: "场地问题" }));
    expect(aggregate.state.phase).toBe("PAUSED");
    aggregate = accept(aggregate, command("RESUME_MATCH", { reason: "场地恢复" }));
    aggregate = accept(
      aggregate,
      command("RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "A", reason: "B 方退赛" }),
    );
    expect(aggregate.state).toMatchObject({ score: { A: 1, B: 0 }, specialOutcome: { type: "RET", winnerSide: "A" } });
    expect(aggregate.state.completedGames).toEqual([]);
    aggregate = accept(aggregate, command("SUBMIT_RESULT", { reason: "提交退赛事实" }));
    aggregate = accept(aggregate, command("CONFIRM_RESULT", { reason: "复核完成" }));
    expect(aggregate.state.phase).toBe("CONFIRMED");
    aggregate = accept(aggregate, command("REOPEN_RESULT", { reason: "发现记录错误" }));
    expect(aggregate.state.phase).toBe("SPECIAL_OUTCOME_PENDING_SUBMISSION");
  });

  it("S2-009：作废误记特殊结果后精确恢复比分、发接发和位置", () => {
    let aggregate = tossAndOpen(createDoubles());
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    const before = structuredClone(aggregate.state);
    const recorded = command("RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "B", reason: "A 方误记退赛" });
    aggregate = accept(aggregate, recorded);
    const invalidation = command("INVALIDATE_SPECIAL_OUTCOME", { reason: "现场核对后确认为误记" });
    aggregate = accept(aggregate, invalidation);

    expect(aggregate.state).toEqual({ ...before, version: before.version + 2 });
    expect(aggregate.events.at(-1)).toMatchObject({
      type: "INVALIDATE_SPECIAL_OUTCOME",
      metadata: { invalidatedCommandId: recorded.commandId },
    });
    expect(replayMatch(aggregate.initialState, aggregate.events)).toEqual(aggregate.state);

    const duplicate = applyCommand(aggregate, invalidation);
    expect(duplicate.status).toBe("duplicate");
    expect(
      applyCommand(aggregate, {
        ...invalidation,
        payload: { reason: "使用同一 ID 改写原因" },
      }),
    ).toMatchObject({ status: "rejected", error: { code: "command_id_reused" } });
  });

  it("S2-009：作废特殊结果恢复暂停、待办和赛前原状态", () => {
    const scenarios = [
      accept(tossAndOpen(createSingles()), command("PAUSE_MATCH", { reason: "场地问题" })),
      accept(
        accept(
          tossAndOpen(createSingles(singleGame21Demo)),
          command("CORRECT_SCORE_STATE", {
            reason: "准备间歇点",
            replacement: replacement(tossAndOpen(createSingles(singleGame21Demo)).state, 10, 0),
          }),
        ),
        command("RALLY_WON", { side: "A" }),
      ),
      accept(
        createSingles(),
        command("RECORD_COIN_TOSS", {
          valid: true,
          winnerSide: "A",
          winnerChoice: { kind: "SERVICE", decision: "SERVE" },
          loserChoice: { kind: "END", end: "END_2" },
        }),
      ),
    ];

    for (let aggregate of scenarios) {
      const before = structuredClone(aggregate.state);
      aggregate = accept(
        aggregate,
        command("RECORD_SPECIAL_OUTCOME", { type: "ABANDONED", reason: "临时记录中止" }),
      );
      aggregate = accept(aggregate, command("INVALIDATE_SPECIAL_OUTCOME", { reason: "中止记录不成立" }));
      expect(aggregate.state).toEqual({ ...before, version: before.version + 2 });
    }
  });

  it("S2-009：特殊结果不能直接覆盖，锁定后须先受控重开", () => {
    let aggregate = tossAndOpen(createSingles());
    const before = structuredClone(aggregate.state);
    aggregate = accept(
      aggregate,
      command("RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "A", reason: "B 方退赛" }),
    );
    expect(
      applyCommand(
        aggregate,
        command("RECORD_SPECIAL_OUTCOME", { type: "DSQ", winnerSide: "B", reason: "不允许直接覆盖" }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "special_outcome_already_recorded" } });

    aggregate = accept(aggregate, command("SUBMIT_RESULT", { reason: "提交特殊结果" }));
    expect(
      applyCommand(aggregate, command("INVALIDATE_SPECIAL_OUTCOME", { reason: "不能越过重开" })),
    ).toMatchObject({ status: "rejected", error: { code: "special_outcome_cannot_be_invalidated" } });
    aggregate = accept(aggregate, command("CONFIRM_RESULT", { reason: "复核锁定" }));
    expect(
      applyCommand(aggregate, command("INVALIDATE_SPECIAL_OUTCOME", { reason: "锁定后不能直接作废" })),
    ).toMatchObject({ status: "rejected", error: { code: "special_outcome_cannot_be_invalidated" } });

    aggregate = accept(aggregate, command("REOPEN_RESULT", { reason: "发现特殊结果误记" }));
    aggregate = accept(aggregate, command("INVALIDATE_SPECIAL_OUTCOME", { reason: "受控重开后作废" }));
    expect(aggregate.state).toEqual({ ...before, version: before.version + 5 });
  });

  it("同 commandId 同内容返回 duplicate，不同内容拒绝", () => {
    let aggregate = tossAndOpen(createSingles());
    const id = "99999999-9999-4999-8999-999999999999";
    const rally = command("RALLY_WON", { side: "A" }, id);
    aggregate = accept(aggregate, rally);
    const duplicate = applyCommand(aggregate, rally);
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.aggregate.state.score).toEqual({ A: 1, B: 0 });
    const mismatch = applyCommand(aggregate, command("RALLY_WON", { side: "B" }, id));
    expect(mismatch.status).toBe("rejected");
    expect(mismatch.aggregate).toEqual(aggregate);
  });

  it("非法命令零修改，屏幕翻转不属于比赛命令", () => {
    const aggregate = tossAndOpen(createSingles());
    const snapshot = structuredClone(aggregate);
    const result = applyCommand(aggregate, {
      commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      occurredAt: "2026-09-18T12:00:00.000Z",
      type: "FLIP_SCREEN_VIEW",
      payload: {},
    } as unknown as MatchCommand);
    expect(result.status).toBe("rejected");
    expect(aggregate).toEqual(snapshot);
  });

  it("拒绝负分、重复球员和非对角发接发且不产生半更新", () => {
    expect(() =>
      createMatchAggregate({
        matchId: "invalid-roster",
        format: "DOUBLES",
        players: { A: ["A1", "A1"], B: ["B1", "B2"] },
        ruleConfig: traditional21Demo,
        ruleConfigHash: hashRuleConfig(traditional21Demo),
      }),
    ).toThrow("球员");

    const aggregate = tossAndOpen(createDoubles());
    const before = structuredClone(aggregate);
    const invalidScore = replacement(aggregate.state, 0, 0);
    invalidScore.score.A = -1;
    expect(
      applyCommand(
        aggregate,
        command("CORRECT_SCORE_STATE", { reason: "非法负分", replacement: invalidScore }),
      ).status,
    ).toBe("rejected");
    expect(aggregate).toEqual(before);
    expect(
      applyCommand(
        aggregate,
        command("CORRECT_SERVICE_ORDER", {
          reason: "非对角接发",
          servingSide: "A",
          serverPlayerId: "A1",
          receiverPlayerId: "B2",
        }),
      ).status,
    ).toBe("rejected");
    expect(aggregate).toEqual(before);
  });

  it("S2-001：比分整体更正拒绝已结束局分、胜局矛盾和缺失阈值义务", () => {
    const aggregate = tossAndOpen(createSingles());
    const before = structuredClone(aggregate);

    const wonButStillInProgress = replacement(aggregate.state, 25, 3);
    expect(
      applyCommand(
        aggregate,
        command("CORRECT_SCORE_STATE", { reason: "已结束局不能继续进行", replacement: wonButStillInProgress }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "corrected_game_already_won" } });

    const inconsistentGames = replacement(aggregate.state, 5, 3);
    inconsistentGames.gamesWon = { A: 1, B: 0 };
    expect(
      applyCommand(
        aggregate,
        command("CORRECT_SCORE_STATE", { reason: "胜局数必须与历史局一致", replacement: inconsistentGames }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "corrected_games_inconsistent" } });

    const decidingGame = tossAndOpen(createSingles(singleGame21Demo));
    const missingThresholdObligations = replacement(decidingGame.state, 11, 0);
    expect(
      applyCommand(
        decidingGame,
        command("CORRECT_SCORE_STATE", {
          reason: "阈值待办不能静默丢失",
          replacement: missingThresholdObligations,
        }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "corrected_obligations_inconsistent" } });

    const completeThresholdState = replacement(decidingGame.state, 11, 0);
    completeThresholdState.phase = "OBLIGATIONS_PENDING";
    completeThresholdState.pendingObligations = [
      {
        id: "interval:game:1:threshold",
        type: "INTERVAL",
        gameNumber: 1,
        triggerScore: { A: 11, B: 0 },
      },
      {
        id: "change-ends:game:1:threshold",
        type: "CHANGE_ENDS",
        gameNumber: 1,
        triggerScore: { A: 11, B: 0 },
      },
    ];
    expect(
      applyCommand(
        decidingGame,
        command("CORRECT_SCORE_STATE", { reason: "显式保留阈值待办", replacement: completeThresholdState }),
      ).status,
    ).toBe("accepted");

    expect(aggregate).toEqual(before);
  });

  it("S2-007：已提交或确认结果拒绝全部四类更正命令", () => {
    let aggregate = tossAndOpen(createDoubles(singleGame21Demo));
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "准备结束比赛", replacement: replacement(aggregate.state, 20, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = accept(aggregate, command("SUBMIT_RESULT", { reason: "提交结果" }));
    const submittedBefore = structuredClone(aggregate);
    const submittedScore = replacement(aggregate.state, 5, 3);
    submittedScore.gamesWon = { A: 0, B: 0 };
    submittedScore.completedGames = [];
    expect(
      applyCommand(
        aggregate,
        command("CORRECT_SCORE_STATE", { reason: "不得覆盖已提交比分", replacement: submittedScore }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "result_locked" } });
    expect(aggregate).toEqual(submittedBefore);
    aggregate = accept(aggregate, command("CONFIRM_RESULT", { reason: "确认结果" }));
    const before = structuredClone(aggregate);
    const correctedScore = replacement(aggregate.state, 5, 3);
    correctedScore.gamesWon = { A: 0, B: 0 };
    correctedScore.completedGames = [];

    const lockedCorrections: MatchCommand[] = [
      command("CORRECT_SCORE_STATE", { reason: "不得覆盖已确认比分", replacement: correctedScore }),
      command("CORRECT_LOGICAL_COURTS", {
        reason: "不得覆盖已确认左右位置",
        logicalCourts: aggregate.state.logicalCourts!,
      }),
      command("CORRECT_SERVICE_ORDER", {
        reason: "不得覆盖已确认发接发",
        servingSide: aggregate.state.servingSide!,
        serverPlayerId: aggregate.state.serverPlayerId!,
        receiverPlayerId: aggregate.state.receiverPlayerId!,
      }),
      command("CORRECT_PHYSICAL_ENDS", {
        reason: "不得覆盖已确认场地端",
        physicalEnds: aggregate.state.physicalEnds!,
      }),
    ];

    for (const correction of lockedCorrections) {
      expect(applyCommand(aggregate, correction)).toMatchObject({
        status: "rejected",
        error: { code: "result_locked" },
      });
      expect(aggregate).toEqual(before);
    }

    const reopened = accept(aggregate, command("REOPEN_RESULT", { reason: "进入受控更正流程" }));
    expect(
      applyCommand(
        reopened,
        command("CORRECT_SCORE_STATE", { reason: "受控重开后修正比分", replacement: correctedScore }),
      ).status,
    ).toBe("accepted");
  });

  it("S2-007：比分整体更正只允许比赛进行中、待办中或刚结束一局", () => {
    const validSource = tossAndOpen(createSingles(singleGame21Demo));
    const scoreReplacement = replacement(validSource.state, 5, 3);

    const awaitingToss = createSingles(singleGame21Demo);
    expect(
      applyCommand(
        awaitingToss,
        command("CORRECT_SCORE_STATE", { reason: "不能绕过抛币", replacement: scoreReplacement }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "score_correction_not_allowed" } });

    let specialOutcome = tossAndOpen(createSingles(singleGame21Demo));
    specialOutcome = accept(
      specialOutcome,
      command("RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "B", reason: "A 方退赛" }),
    );
    expect(
      applyCommand(
        specialOutcome,
        command("CORRECT_SCORE_STATE", {
          reason: "特殊结果不能与进行中比分并存",
          replacement: replacement(specialOutcome.state, 5, 3),
        }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "score_correction_not_allowed" } });

    let paused = tossAndOpen(createSingles(singleGame21Demo));
    paused = accept(paused, command("PAUSE_MATCH", { reason: "场地暂停" }));
    expect(
      applyCommand(
        paused,
        command("CORRECT_SCORE_STATE", { reason: "暂停时不能隐式恢复", replacement: replacement(paused.state, 5, 3) }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "score_correction_not_allowed" } });

    let gameComplete = tossAndOpen(createSingles());
    gameComplete = accept(
      gameComplete,
      command("CORRECT_SCORE_STATE", { reason: "准备结束首局", replacement: replacement(gameComplete.state, 20, 0) }),
    );
    gameComplete = accept(gameComplete, command("RALLY_WON", { side: "A" }));
    const reopenGame = replacement(gameComplete.state, 20, 20);
    reopenGame.gamesWon = { A: 0, B: 0 };
    reopenGame.completedGames = [];
    expect(
      applyCommand(
        gameComplete,
        command("CORRECT_SCORE_STATE", { reason: "刚结束一局时更正局分", replacement: reopenGame }),
      ).status,
    ).toBe("accepted");
  });

  it("S2-002：物理端更正必须显式消费尚未处理的规则换边义务", () => {
    let aggregate = tossAndOpen(createSingles(singleGame21Demo));
    aggregate = accept(
      aggregate,
      command("CORRECT_SCORE_STATE", { reason: "准备换边阈值", replacement: replacement(aggregate.state, 10, 0) }),
    );
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    const interval = aggregate.state.pendingObligations.find((item) => item.type === "INTERVAL")!;
    const changeEnds = aggregate.state.pendingObligations.find((item) => item.type === "CHANGE_ENDS")!;
    const before = structuredClone(aggregate);

    expect(
      applyCommand(
        aggregate,
        command("CORRECT_PHYSICAL_ENDS", {
          reason: "现场已完成规则换边",
          physicalEnds: { A: "END_2", B: "END_1" },
        }),
      ),
    ).toMatchObject({ status: "rejected", error: { code: "change_ends_relationship_required" } });
    expect(aggregate).toEqual(before);

    aggregate = accept(
      aggregate,
      command("CORRECT_PHYSICAL_ENDS", {
        reason: "现场已完成规则换边",
        physicalEnds: { A: "END_2", B: "END_1" },
        fulfillsObligationId: changeEnds.id,
      }),
    );
    expect(aggregate.state.physicalEnds).toEqual({ A: "END_2", B: "END_1" });
    expect(aggregate.state.pendingObligations).not.toContainEqual(expect.objectContaining({ id: changeEnds.id }));
    aggregate = accept(aggregate, command("ACKNOWLEDGE_INTERVAL", { obligationId: interval.id }));
    expect(aggregate.state).toMatchObject({
      phase: "IN_PROGRESS",
      physicalEnds: { A: "END_2", B: "END_1" },
      pendingObligations: [],
    });
  });

  it("事件重放和 JSON 往返得到相同权威状态", () => {
    let aggregate = tossAndOpen(createDoubles());
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = accept(aggregate, command("LET", { reason: "擦网重发" }));
    const serialized = JSON.parse(JSON.stringify(aggregate)) as MatchAggregate;
    expect(replayMatch(serialized.initialState, serialized.events)).toEqual(serialized.state);
  });

  it("S2-003：事件重放重新执行命令并拒绝被篡改的状态快照", () => {
    let aggregate = tossAndOpen(createDoubles());
    aggregate = accept(aggregate, command("RALLY_WON", { side: "A" }));
    aggregate = accept(aggregate, command("LET", { reason: "擦网重发" }));
    const tamperedEvents = structuredClone(aggregate.events);
    tamperedEvents.at(-1)!.stateAfter.score = { A: 99, B: 99 };

    expect(() => replayMatch(aggregate.initialState, tamperedEvents)).toThrow("事件快照与命令重放结果不一致");
    expect(replayMatch(aggregate.initialState, aggregate.events)).toEqual(aggregate.state);

    aggregate = accept(aggregate, command("RALLY_WON", { side: "B" }));
    aggregate = accept(aggregate, command("UNDO_LAST_REVERSIBLE", { reason: "重放撤销事件" }));
    expect(replayMatch(aggregate.initialState, aggregate.events)).toEqual(aggregate.state);
  });

  it("冻结规则快照不随创建后默认对象变化", () => {
    const config = { ...traditional21Demo };
    const aggregate = createSingles(config);
    config.targetPoints = 15;
    expect(aggregate.state.ruleConfig.targetPoints).toBe(21);
  });

  it("固定种子的随机合法回合序列保持成员、比分和发接发不变量", () => {
    let seed = 20260918;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let aggregate = tossAndOpen(createDoubles());
    for (let index = 0; index < 18; index += 1) {
      aggregate = clearObligations(aggregate);
      aggregate = accept(aggregate, command("RALLY_WON", { side: random() < 0.5 ? "A" : "B" }));
      expect(aggregate.state.score.A).toBeGreaterThanOrEqual(0);
      expect(aggregate.state.score.B).toBeGreaterThanOrEqual(0);
      expect(aggregate.state.players).toEqual({ A: ["A1", "A2"], B: ["B1", "B2"] });
      expect(aggregate.state.players[aggregate.state.servingSide!]).toContain(aggregate.state.serverPlayerId);
      const receiverSide = aggregate.state.servingSide === "A" ? "B" : "A";
      expect(aggregate.state.players[receiverSide]).toContain(aggregate.state.receiverPlayerId);
    }
  });
});

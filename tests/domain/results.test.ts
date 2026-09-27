import { describe, expect, it } from "vitest";

import {
  factFromRecord,
  factFromState,
  isFinalGameScore,
  validateResultOnly,
  type GameScore,
  type MatchResultFact,
  type ResultOnlyInput,
} from "@/domain/results/match-result";
import { computePlacements } from "@/domain/results/placements";
import {
  applyRankingDecision,
  CAMPUS_DEMO_RANKING,
  computeGroupRanking,
  describeStep,
  type GroupRanking,
  type RankingMatch,
} from "@/domain/results/ranking";
import { createMatchAggregate, type MatchState } from "@/domain/rules/match-engine";
import { alternative3x15Demo, hashRuleConfig, singleGame21Demo, traditional21Demo } from "@/domain/rules/rule-profile";

function confirmed(games: [number, number][], stage: MatchResultFact["stage"] = "CONFIRMED"): MatchResultFact {
  const list: GameScore[] = games.map(([a, b]) => ({ a, b }));
  const won = list.reduce((acc, game) => ({ A: acc.A + (game.a > game.b ? 1 : 0), B: acc.B + (game.b > game.a ? 1 : 0) }), { A: 0, B: 0 });
  return { stage, source: "RESULT_ONLY", outcome: "NORMAL", winner: won.A > won.B ? "A" : "B", games: list, partial: null };
}

let seq = 0;
function match(sideA: string, sideB: string, fact: MatchResultFact): RankingMatch {
  seq += 1;
  return { id: `m${seq}`, code: `${sideA}-${sideB}`, sideA, sideB, fact };
}

const W = [[21, 10], [21, 10]] as [number, number][];
/** 三局险胜：2—1 局，21:19 19:21 21:19。 */
const CLOSE = [[21, 19], [19, 21], [21, 19]] as [number, number][];

function row(ranking: GroupRanking, entryId: string) {
  const found = ranking.rows.find((item) => item.entryId === entryId);
  if (!found) throw new Error(`没有 ${entryId}`);
  return found;
}

function order(ranking: GroupRanking) {
  return ranking.rows.map((item) => item.entryId);
}

/** 重新从比赛事实计算每一行的统计，用于核对解释与统计一致。 */
function recount(ranking: GroupRanking, matches: RankingMatch[]) {
  const counted = new Set(ranking.countedMatchCodes);
  for (const item of ranking.rows) {
    let won = 0;
    let gamesWon = 0;
    let gamesLost = 0;
    let pointsWon = 0;
    let pointsLost = 0;
    for (const m of matches) {
      if (!counted.has(m.code)) continue;
      const side = m.sideA === item.entryId ? "A" : m.sideB === item.entryId ? "B" : null;
      if (!side) continue;
      if (m.fact.winner === side) won += 1;
      for (const game of m.fact.games) {
        const mine = side === "A" ? game.a : game.b;
        const theirs = side === "A" ? game.b : game.a;
        pointsWon += mine;
        pointsLost += theirs;
        if (mine > theirs) gamesWon += 1;
        else gamesLost += 1;
      }
    }
    expect(item.won).toBe(won);
    expect(item.netGames).toBe(gamesWon - gamesLost);
    expect(item.netPoints).toBe(pointsWon - pointsLost);
    for (const step of item.steps) {
      if (step.kind === "WINS") expect(step.wins).toBe(item.won);
      if (step.kind === "NET_GAMES") expect(step.value).toBe(item.netGames);
      if (step.kind === "NET_POINTS") expect(step.value).toBe(item.netPoints);
    }
  }
}

describe("校园演示排名方案", () => {
  it("明确标注为演示方案，须组织者确认", () => {
    expect(CAMPUS_DEMO_RANKING.demo).toBe(true);
    expect(CAMPUS_DEMO_RANKING.name).toBe("校园演示排名方案");
    expect(CAMPUS_DEMO_RANKING.notice).toContain("组织者确认");
  });

  it("正常排名：胜场各不相同时按胜场排序", () => {
    const matches = [
      match("P1", "P2", confirmed(W)),
      match("P1", "P3", confirmed(W)),
      match("P2", "P3", confirmed(W)),
    ];
    const ranking = computeGroupRanking({ entryIds: ["P3", "P2", "P1"], matches });
    expect(ranking.status).toBe("READY");
    expect(order(ranking)).toEqual(["P1", "P2", "P3"]);
    expect(ranking.rows.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(ranking.rows.every((item) => item.basis === "WINS")).toBe(true);
    expect(describeStep(row(ranking, "P1").steps[0], (id) => id)).toBe("胜 2 场，胜场即可区分");
    recount(ranking, matches);
  });

  it("两方同胜场：看直接对赛，即使对方净胜分更高", () => {
    // P1、P2 都胜 2 场；P2 净胜分更高，但 P1 直接对赛赢了 P2。P3、P4 都胜 1 场，P4 直接对赛赢了 P3。
    const matches = [
      match("P1", "P2", confirmed(CLOSE)),
      match("P3", "P1", confirmed([[21, 19], [21, 19]])),
      match("P2", "P3", confirmed(W)),
      match("P1", "P4", confirmed([[21, 19], [21, 19]])),
      match("P2", "P4", confirmed(W)),
      match("P4", "P3", confirmed(W)),
    ];
    const ranking = computeGroupRanking({ entryIds: ["P1", "P2", "P3", "P4"], matches });
    expect(row(ranking, "P1").won).toBe(2);
    expect(row(ranking, "P2").won).toBe(2);
    expect(row(ranking, "P2").netPoints).toBeGreaterThan(row(ranking, "P1").netPoints);
    expect(order(ranking)).toEqual(["P1", "P2", "P4", "P3"]);
    expect(row(ranking, "P1").basis).toBe("HEAD_TO_HEAD");
    expect(describeStep(row(ranking, "P1").steps[1], (id) => id)).toBe("直接对赛胜 P2（P1-P2）");
    recount(ranking, matches);
  });

  it("三方循环相胜：比整个小组的净胜局，净胜局可区分时不再看直接对赛", () => {
    // P1 胜 P2、P2 胜 P3、P3 胜 P1，三方都胜 2 场（P4 全负）。
    const matches = [
      match("P1", "P2", confirmed(W)), // P1 +2 局
      match("P2", "P3", confirmed(CLOSE)), // P2 +1 局
      match("P3", "P1", confirmed(CLOSE)), // P3 +1 局
      match("P1", "P4", confirmed(W)),
      match("P2", "P4", confirmed(CLOSE)),
      match("P3", "P4", confirmed(W)),
    ];
    const ranking = computeGroupRanking({ entryIds: ["P1", "P2", "P3", "P4"], matches });
    // 净胜局：P1 = +2 -1 +2 = +3；P2 = -2 +1 +1 = 0；P3 = -1 +1 +2 = +2
    expect(row(ranking, "P1").netGames).toBe(3);
    expect(row(ranking, "P3").netGames).toBe(2);
    expect(row(ranking, "P2").netGames).toBe(0);
    expect(order(ranking)).toEqual(["P1", "P3", "P2", "P4"]);
    expect(row(ranking, "P1").basis).toBe("NET_GAMES");
    expect(row(ranking, "P3").basis).toBe("NET_GAMES");
    recount(ranking, matches);
  });

  it("净胜局分层后剩两方回到直接对赛，剩三方再比净胜分", () => {
    // 四方都胜 1 场以上的循环：P1 胜 P2、P2 胜 P3、P3 胜 P1；三人净胜局相同、净胜分不同。
    const matches = [
      match("P1", "P2", confirmed([[21, 15], [21, 15]])),
      match("P2", "P3", confirmed([[21, 17], [21, 17]])),
      match("P3", "P1", confirmed([[21, 19], [21, 19]])),
      match("P1", "P4", confirmed(W)),
      match("P2", "P4", confirmed(W)),
      match("P3", "P4", confirmed(W)),
    ];
    const ranking = computeGroupRanking({ entryIds: ["P1", "P2", "P3", "P4"], matches });
    expect(new Set([row(ranking, "P1").netGames, row(ranking, "P2").netGames, row(ranking, "P3").netGames]).size).toBe(1);
    // 净胜分：P1 = +12 -4 +22 = +30；P2 = -12 +8 +22 = +18；P3 = -8 +4 +22 = +18 → P2、P3 相同，回到直接对赛（P2 胜 P3）
    expect(row(ranking, "P1").netPoints).toBe(30);
    expect(row(ranking, "P2").netPoints).toBe(18);
    expect(row(ranking, "P3").netPoints).toBe(18);
    expect(order(ranking)).toEqual(["P1", "P2", "P3", "P4"]);
    expect(row(ranking, "P1").basis).toBe("NET_POINTS");
    expect(row(ranking, "P2").basis).toBe("HEAD_TO_HEAD");
    expect(row(ranking, "P3").steps.map((step) => step.kind)).toEqual(["WINS", "NET_GAMES", "NET_POINTS", "HEAD_TO_HEAD"]);
    recount(ranking, matches);
  });

  it("完全同分：并列待裁定，不按姓名或 ID 擅自定名次，须按抽签顺序确认", () => {
    const matches = [
      match("P1", "P2", confirmed(W)),
      match("P2", "P3", confirmed(W)),
      match("P3", "P1", confirmed(W)),
    ];
    const ranking = computeGroupRanking({ entryIds: ["P1", "P2", "P3"], matches });
    expect(ranking.status).toBe("NEEDS_DECISION");
    expect(ranking.unresolved).toEqual([["P1", "P2", "P3"]]);
    expect(ranking.rows.every((item) => item.position === 1 && item.basis === "UNRESOLVED")).toBe(true);
    expect(describeStep(row(ranking, "P1").steps.at(-1)!, (id) => id)).toContain("并列待裁定");

    expect(applyRankingDecision(ranking, null).error).toContain("抽签");
    expect(applyRankingDecision(ranking, ["P3", "P1", "P2"]).order).toEqual(["P3", "P1", "P2"]);
    expect(applyRankingDecision(ranking, ["P3", "P1"]).error).not.toBeNull();
  });

  it("有名次由成绩确定时不能手动改动，只能调整并列待裁定的几方", () => {
    const matches = [
      match("P1", "P2", confirmed(W)),
      match("P1", "P3", confirmed(W)),
      match("P1", "P4", confirmed(W)),
      match("P2", "P3", confirmed(W)),
      match("P3", "P4", confirmed(W)),
      match("P4", "P2", confirmed(W)),
    ];
    const ranking = computeGroupRanking({ entryIds: ["P1", "P2", "P3", "P4"], matches });
    expect(ranking.unresolved).toEqual([["P2", "P3", "P4"]]);
    expect(applyRankingDecision(ranking, ["P2", "P1", "P3", "P4"]).error).toContain("只能调整");
    expect(applyRankingDecision(ranking, ["P1", "P4", "P2", "P3"]).order).toEqual(["P1", "P4", "P2", "P3"]);
  });

  it("未正式确认的结果不参与正式榜，只能显示暂定", () => {
    const matches = [
      match("P1", "P2", confirmed(W)),
      match("P1", "P3", confirmed(W, "PENDING_REVIEW")),
      match("P2", "P3", confirmed(W, "IN_PROGRESS")),
    ];
    const ranking = computeGroupRanking({ entryIds: ["P1", "P2", "P3"], matches });
    expect(ranking.status).toBe("PROVISIONAL");
    expect(ranking.countedMatchCodes).toEqual(["P1-P2"]);
    expect(ranking.pendingMatchCodes).toEqual(["P1-P3", "P2-P3"]);
    expect(row(ranking, "P1").won).toBe(1);
    expect(row(ranking, "P3").played).toBe(0);
    expect(applyRankingDecision(ranking, null).error).toContain("暂定");
  });

  it("特殊结果阻止正式名次；裁判长排除该单位后按其余比赛排名，原比赛不删除", () => {
    const wo: MatchResultFact = { stage: "CONFIRMED", source: "LIVE", outcome: "WO", winner: "A", games: [], partial: null };
    const matches = [
      match("P1", "P2", confirmed(W)),
      match("P1", "P3", confirmed(W)),
      match("P2", "P3", confirmed(W)),
      match("P1", "P4", wo),
      match("P2", "P4", confirmed(W)),
      match("P3", "P4", confirmed(W)),
    ];
    const blocked = computeGroupRanking({ entryIds: ["P1", "P2", "P3", "P4"], matches });
    expect(blocked.status).toBe("BLOCKED");
    expect(blocked.blockers).toEqual([{ code: "SPECIAL_OUTCOME", matchCode: "P1-P4", entryIds: ["P1", "P4"], outcome: "WO" }]);
    expect(applyRankingDecision(blocked, null).error).toContain("特殊结果");

    const handled = computeGroupRanking({
      entryIds: ["P1", "P2", "P3", "P4"],
      matches,
      excluded: [{ entryId: "P4", reason: "赛前弃权，不能完成本组比赛" }],
    });
    expect(handled.status).toBe("READY");
    expect(order(handled)).toEqual(["P1", "P2", "P3"]);
    expect(handled.excludedMatchCodes).toEqual(["P1-P4", "P2-P4", "P3-P4"]);
    // 其他参赛者对被排除单位的胜场也同步排除。
    expect(row(handled, "P2").won).toBe(1);
    recount(handled, matches);
  });

  it("退赛保留实际比分，但同样只作为特殊结果阻止正式名次", () => {
    const ret: MatchResultFact = { stage: "CONFIRMED", source: "LIVE", outcome: "RET", winner: "B", games: [{ a: 21, b: 18 }], partial: { a: 5, b: 9 } };
    const ranking = computeGroupRanking({ entryIds: ["P1", "P2"], matches: [match("P1", "P2", ret)] });
    expect(ranking.status).toBe("BLOCKED");
    expect(ranking.rows.every((item) => item.played === 0)).toBe(true);
  });
});

describe("仅结果记录校验", () => {
  const config = traditional21Demo;
  const ok = (input: Partial<ResultOnlyInput>) =>
    validateResultOnly({ outcome: "NORMAL", winnerSide: null, games: [], partial: null, ...input }, config);

  it("一局比分必须恰好在结束的那一分停下", () => {
    expect(isFinalGameScore({ a: 21, b: 19 }, config)).toBe(true);
    expect(isFinalGameScore({ a: 23, b: 21 }, config)).toBe(true);
    expect(isFinalGameScore({ a: 30, b: 29 }, config)).toBe(true);
    expect(isFinalGameScore({ a: 21, b: 20 }, config)).toBe(false);
    expect(isFinalGameScore({ a: 25, b: 20 }, config)).toBe(false);
    expect(isFinalGameScore({ a: 31, b: 29 }, config)).toBe(false);
    expect(isFinalGameScore({ a: 15, b: 10 }, alternative3x15Demo)).toBe(true);
  });

  it("正常完赛：胜方由逐局比分推出，决出胜负后不能再有下一局", () => {
    const result = ok({ games: [{ a: 21, b: 15 }, { a: 18, b: 21 }, { a: 21, b: 19 }] });
    expect(result.ok && result.record.winnerSide).toBe("A");
    const extra = ok({ games: [{ a: 21, b: 15 }, { a: 21, b: 15 }, { a: 21, b: 19 }] });
    expect(extra.ok).toBe(false);
    expect(ok({ games: [{ a: 21, b: 15 }] }).ok).toBe(false);
    expect(ok({ games: [{ a: 21, b: 15 }, { a: 21, b: 15 }], winnerSide: "B" }).ok).toBe(false);
    const single = validateResultOnly({ outcome: "NORMAL", winnerSide: null, games: [{ a: 19, b: 21 }], partial: null }, singleGame21Demo);
    expect(single.ok && single.record.winnerSide).toBe("B");
  });

  it("弃权不补比分；退赛保留已完成局与中断局；终止不产生胜方", () => {
    expect(ok({ outcome: "WO", winnerSide: "A" }).ok).toBe(true);
    expect(ok({ outcome: "WO", winnerSide: "A", games: [{ a: 21, b: 0 }] }).ok).toBe(false);
    expect(ok({ outcome: "WO", winnerSide: null }).ok).toBe(false);
    expect(ok({ outcome: "RET", winnerSide: "B", games: [{ a: 21, b: 18 }], partial: { a: 5, b: 9 } }).ok).toBe(true);
    expect(ok({ outcome: "RET", winnerSide: "B", games: [{ a: 21, b: 18 }, { a: 21, b: 18 }] }).ok).toBe(false);
    expect(ok({ outcome: "RET", winnerSide: "B", partial: { a: 21, b: 9 } }).ok).toBe(false);
    expect(ok({ outcome: "ABANDONED", winnerSide: null, partial: { a: 11, b: 9 } }).ok).toBe(true);
    expect(ok({ outcome: "ABANDONED", winnerSide: "A" }).ok).toBe(false);
  });

  it("仅结果记录的事实标明来源，不含任何回合过程", () => {
    const result = ok({ games: [{ a: 21, b: 15 }, { a: 21, b: 15 }] });
    if (!result.ok) throw new Error("应通过");
    const fact = factFromRecord(result.record, "PENDING_REVIEW");
    expect(fact).toEqual({ stage: "PENDING_REVIEW", source: "RESULT_ONLY", outcome: "NORMAL", winner: "A", games: [{ a: 21, b: 15 }, { a: 21, b: 15 }], partial: null });
  });
});

describe("逐分记分状态的结果事实", () => {
  function state(patch: Partial<MatchState>): MatchState {
    const base = createMatchAggregate({
      matchId: "m",
      format: "SINGLES",
      players: { A: ["a"], B: ["b"] },
      ruleConfig: traditional21Demo,
      ruleConfigHash: hashRuleConfig(traditional21Demo),
    }).state;
    return { ...base, ...patch };
  }

  it("区分进行中、结束待提交、待复核与正式确认", () => {
    expect(factFromState(null).stage).toBe("NOT_STARTED");
    expect(factFromState(state({})).stage).toBe("NOT_STARTED");
    expect(factFromState(state({ phase: "IN_PROGRESS", version: 3 })).stage).toBe("IN_PROGRESS");
    const games = [{ number: 1, scoreA: 21, scoreB: 10, winnerSide: "A" as const }, { number: 2, scoreA: 21, scoreB: 12, winnerSide: "A" as const }];
    const ended = { gamesWon: { A: 2, B: 0 }, completedGames: games, version: 50 };
    expect(factFromState(state({ ...ended, phase: "MATCH_COMPLETE_PENDING_SUBMISSION" })).stage).toBe("PENDING_SUBMISSION");
    expect(factFromState(state({ ...ended, phase: "SUBMITTED" })).stage).toBe("PENDING_REVIEW");
    const fact = factFromState(state({ ...ended, phase: "CONFIRMED" }));
    expect(fact).toMatchObject({ stage: "CONFIRMED", outcome: "NORMAL", winner: "A", games: [{ a: 21, b: 10 }, { a: 21, b: 12 }] });
  });

  it("进行中的比赛没有胜方", () => {
    const fact = factFromState(state({ phase: "IN_PROGRESS", version: 3, gamesWon: { A: 1, B: 0 } }));
    expect(fact.winner).toBeNull();
    expect(fact.outcome).toBeNull();
  });
});

describe("最终名次", () => {
  it("有三四名赛：决出前四名，更早轮次负者只记并列名次", () => {
    const { placements, complete } = computePlacements({
      format: "KNOCKOUT",
      groups: [],
      qualifiersPerGroup: 0,
      knockout: [
        { code: "QF1", kind: "KNOCKOUT", round: 1, sideA: "E1", sideB: "E8", winner: "E1" },
        { code: "QF2", kind: "KNOCKOUT", round: 1, sideA: "E4", sideB: "E5", winner: "E4" },
        { code: "QF3", kind: "KNOCKOUT", round: 1, sideA: "E3", sideB: "E6", winner: "E3" },
        { code: "QF4", kind: "KNOCKOUT", round: 1, sideA: "E2", sideB: "E7", winner: "E2" },
        { code: "SF1", kind: "KNOCKOUT", round: 2, sideA: "E1", sideB: "E4", winner: "E1" },
        { code: "SF2", kind: "KNOCKOUT", round: 2, sideA: "E3", sideB: "E2", winner: "E2" },
        { code: "F", kind: "KNOCKOUT", round: 3, sideA: "E1", sideB: "E2", winner: "E2" },
        { code: "3P", kind: "THIRD_PLACE", round: 3, sideA: "E4", sideB: "E3", winner: "E3" },
      ],
    });
    expect(complete).toBe(true);
    expect(placements.slice(0, 4).map((item) => [item.entryId, item.label])).toEqual([
      ["E2", "冠军"],
      ["E1", "亚军"],
      ["E3", "季军"],
      ["E4", "第 4 名"],
    ]);
    expect(placements.slice(4).every((item) => item.place === 5 && item.tied && item.label === "并列第 5 名（八强）")).toBe(true);
  });

  it("没有三四名赛：两名半决赛负者并列第 3，不虚构第 4 名", () => {
    const { placements } = computePlacements({
      format: "KNOCKOUT",
      groups: [],
      qualifiersPerGroup: 0,
      knockout: [
        { code: "SF1", kind: "KNOCKOUT", round: 1, sideA: "E1", sideB: "E4", winner: "E1" },
        { code: "SF2", kind: "KNOCKOUT", round: 1, sideA: "E3", sideB: "E2", winner: "E2" },
        { code: "F", kind: "KNOCKOUT", round: 2, sideA: "E1", sideB: "E2", winner: "E1" },
      ],
    });
    expect(placements.map((item) => item.label)).toEqual(["冠军", "亚军", "并列第 3 名（四强）", "并列第 3 名（四强）"]);
    expect(placements.some((item) => item.place === 4)).toBe(false);
  });

  it("小组＋淘汰：未出线者只记小组未出线；未确认的淘汰赛名次待定", () => {
    const { placements, complete } = computePlacements({
      format: "GROUPS_KNOCKOUT",
      groups: [
        { code: "A", confirmedOrder: ["A1", "A2", "A3"], entryIds: ["A1", "A2", "A3"], excludedEntryIds: [] },
        { code: "B", confirmedOrder: null, entryIds: ["B1", "B2", "B3"], excludedEntryIds: [] },
      ],
      qualifiersPerGroup: 2,
      knockout: [
        { code: "SF1", kind: "KNOCKOUT", round: 1, sideA: "A1", sideB: null, winner: null },
        { code: "SF2", kind: "KNOCKOUT", round: 1, sideA: null, sideB: "A2", winner: null },
        { code: "F", kind: "KNOCKOUT", round: 2, sideA: null, sideB: null, winner: null },
      ],
    });
    expect(complete).toBe(false);
    expect(placements.find((item) => item.entryId === "A3")?.label).toBe("A 组未出线");
    expect(placements.find((item) => item.entryId === "B3")?.label).toBe("名次待定");
    expect(placements.find((item) => item.entryId === "A1")?.label).toBe("名次待定");
  });

  it("单循环：确认后的小组名次即最终名次", () => {
    const { placements } = computePlacements({
      format: "ROUND_ROBIN",
      groups: [{ code: "RR", confirmedOrder: ["P2", "P1"], entryIds: ["P1", "P2", "P3"], excludedEntryIds: ["P3"] }],
      qualifiersPerGroup: 0,
      knockout: [],
    });
    expect(placements.map((item) => [item.entryId, item.label])).toEqual([["P2", "第 1 名"], ["P1", "第 2 名"], ["P3", "排除，不计名次"]]);
  });
});

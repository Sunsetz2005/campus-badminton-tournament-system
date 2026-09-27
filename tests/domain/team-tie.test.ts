import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEAM_FORMAT,
  eligibleRubberKinds,
  validateTeamRoster,
  type TeamMemberInput,
} from "@/domain/registration/team-roster";
import { appearanceCounts, eligibleForRubber, validateLineup, type LineupRosterMember } from "@/domain/team/lineup";
import { applyConfirmedOrder, computeStandings, type StandingTie } from "@/domain/team/standings";
import { computeTie, tiePolicyFor, tieWinsNeeded, type RubberFact } from "@/domain/team/tie";

const RUBBERS = DEFAULT_TEAM_FORMAT.rubbers.map((kind, index) => ({ order: index + 1, kind }));

function member(name: string, gender: "MALE" | "FEMALE", kinds: string[], studentId = name): TeamMemberInput {
  return { displayName: name, studentId, gender, rubberKinds: kinds };
}

describe("团体名单报项", () => {
  it("按性别列出可报小场，按规范顺序去重", () => {
    expect(eligibleRubberKinds("MALE", DEFAULT_TEAM_FORMAT.rubbers)).toEqual(["MS", "MD", "XD"]);
    expect(eligibleRubberKinds("FEMALE", ["XD", "WS", "WS"])).toEqual(["WS", "XD"]);
  });

  it("合规名单：报项规范化；同一人可以报多项", () => {
    const { members, errors } = validateTeamRoster(DEFAULT_TEAM_FORMAT, [
      member("男一", "MALE", ["XD", "MS", "MD", "MS"], "S1"),
      member("男二", "MALE", ["MD"], "S2"),
      member("女一", "FEMALE", ["WS", "WD", "XD"], "S3"),
      member("女二", "FEMALE", ["WD"], "S4"),
    ]);
    expect(errors).toEqual([]);
    expect(members?.[0].rubberKinds).toEqual(["MS", "MD", "XD"]);
  });

  it("未报项、报了异性项目或本项目没有的小场、某小场报项人数不够：一次列出全部错误", () => {
    const format = { ...DEFAULT_TEAM_FORMAT, rubbers: DEFAULT_TEAM_FORMAT.rubbers.filter((kind) => kind !== "WD") };
    const { members, errors } = validateTeamRoster(format, [
      member("男一", "MALE", ["MS", "WS"], "S1"),
      member("男二", "MALE", [], "S2"),
      member("女一", "FEMALE", ["WD"], "S3"),
      member("女二", "FEMALE", ["XD"], "S4"),
    ]);
    expect(members).toBeNull();
    expect(errors).toEqual(
      expect.arrayContaining([
        "第 1 名队员的报项「女单」与性别「男」不符",
        "第 2 名队员的报项至少选 1 项",
        expect.stringContaining("第 3 名队员的报项只能从本项目的小场"),
      ]),
    );
    const coverage = validateTeamRoster(DEFAULT_TEAM_FORMAT, [
      member("男一", "MALE", ["MS", "MD"], "S1"),
      member("男二", "MALE", ["MS"], "S2"),
      member("女一", "FEMALE", ["WS", "WD", "XD"], "S3"),
      member("女二", "FEMALE", ["WD"], "S4"),
    ]);
    expect(coverage.errors).toEqual([
      "报「男双」的队员至少 2 人，当前 1 人",
      "报「混双」的队员至少要有 1 男 1 女，当前 0 男 1 女",
    ]);
  });
});

const ROSTER: LineupRosterMember[] = [
  { participantId: "m1", label: "男一", gender: "MALE", rubberKinds: ["MS", "MD", "XD"] },
  { participantId: "m2", label: "男二", gender: "MALE", rubberKinds: ["MD"] },
  { participantId: "m3", label: "男三", gender: "MALE", rubberKinds: ["XD"] },
  { participantId: "f1", label: "女一", gender: "FEMALE", rubberKinds: ["WS", "WD", "XD"] },
  { participantId: "f2", label: "女二", gender: "FEMALE", rubberKinds: ["WD"] },
];

const GOOD_LINEUP = [
  { order: 1, participantIds: ["m1"] },
  { order: 2, participantIds: ["f1"] },
  { order: 3, participantIds: ["m1", "m2"] },
  { order: 4, participantIds: ["f1", "f2"] },
  { order: 5, participantIds: ["m1", "f1"] },
];

describe("出场名单", () => {
  it("每个小场只能从报了该项且性别相符的队员里选", () => {
    expect(eligibleForRubber("MS", ROSTER).map((item) => item.participantId)).toEqual(["m1"]);
    expect(eligibleForRubber("XD", ROSTER).map((item) => item.participantId)).toEqual(["m1", "m3", "f1"]);
  });

  it("合规名单通过；同一队员上几个小场不设上限", () => {
    const { lineup, errors } = validateLineup(RUBBERS, ROSTER, GOOD_LINEUP);
    expect(errors).toEqual([]);
    expect(lineup).toHaveLength(5);
    expect(appearanceCounts(lineup ?? []).get("m1")).toBe(3);
  });

  it("人数不对、同一小场重复、未报该项、性别不符、混双不是一男一女、缺小场、多余小场：全部拒绝", () => {
    const { lineup, errors } = validateLineup(RUBBERS, ROSTER, [
      { order: 1, participantIds: ["m2"] },
      { order: 2, participantIds: ["f1", "f2"] },
      { order: 3, participantIds: ["m1", "m1"] },
      { order: 4, participantIds: ["f1", "m1"] },
      { order: 5, participantIds: ["m1", "m3"] },
      { order: 6, participantIds: ["m1"] },
    ]);
    expect(lineup).toBeNull();
    expect(errors).toEqual([
      "本场对抗没有第 6 场小场",
      "第 1 场男单：男二 报名时没有报「男单」",
      "第 2 场女单需要 1 名队员，当前 2 名",
      "第 3 场男双不能两个位置都选同一名队员",
      "第 4 场女双：男一 报名时没有报「女双」",
      "第 5 场混双必须一男一女",
    ]);
    const missing = validateLineup(RUBBERS, ROSTER, GOOD_LINEUP.slice(0, 4));
    expect(missing.errors).toEqual(["第 5 场混双需要 2 名队员，当前 0 名"]);
    const outsider = validateLineup(RUBBERS, ROSTER, [{ order: 1, participantIds: ["x9"] }, ...GOOD_LINEUP.slice(1)]);
    expect(outsider.errors).toEqual(["第 1 场男单选择的队员不在本队名单中"]);
  });
});

function rubber(order: number, patch: Partial<RubberFact> = {}): RubberFact {
  return { order, kind: RUBBERS[order - 1].kind, started: false, final: false, winner: null, games: [], ...patch };
}

const won = (winner: "A" | "B", games: { a: number; b: number }[] = winner === "A" ? [{ a: 21, b: 15 }, { a: 21, b: 18 }] : [{ a: 12, b: 21 }, { a: 19, b: 21 }]) =>
  ({ started: true, final: true, winner, games }) satisfies Partial<RubberFact>;

describe("对抗胜负", () => {
  it("小组赛打满、淘汰赛决出即止", () => {
    expect(tiePolicyFor("GROUP")).toBe("PLAY_ALL");
    expect(tiePolicyFor("KNOCKOUT")).toBe("STOP_WHEN_DECIDED");
    expect(tiePolicyFor("THIRD_PLACE")).toBe("STOP_WHEN_DECIDED");
    expect(tieWinsNeeded(5)).toBe(3);
    expect(tieWinsNeeded(3)).toBe(2);
  });

  it("只计锁定结果；未锁定的小场即使比完也不算", () => {
    const summary = computeTie(
      [rubber(1, won("A")), rubber(2, { started: true, final: false, winner: "A" }), rubber(3), rubber(4), rubber(5)],
      "PLAY_ALL",
    );
    expect(summary).toMatchObject({ rubbers: { A: 1, B: 0 }, games: { A: 2, B: 0 }, points: { A: 42, B: 33 }, winner: null, status: "IN_PROGRESS" });
  });

  it("小组赛 3:0 后胜负已定但仍要打满；五场锁定后才结束，统计全部小场", () => {
    const decided = computeTie([rubber(1, won("A")), rubber(2, won("A")), rubber(3, won("A")), rubber(4), rubber(5)], "PLAY_ALL");
    expect(decided).toMatchObject({ winner: "A", status: "DECIDED", complete: false, notPlayedOrders: [] });
    const finished = computeTie(
      [rubber(1, won("A")), rubber(2, won("A")), rubber(3, won("A")), rubber(4, won("B")), rubber(5, won("B"))],
      "PLAY_ALL",
    );
    expect(finished).toMatchObject({ winner: "A", status: "COMPLETE", complete: true, rubbers: { A: 3, B: 2 }, games: { A: 6, B: 4 } });
  });

  it("淘汰赛 3:0 后未开始的小场记为未进行；已开始的小场照常打完", () => {
    const summary = computeTie(
      [rubber(1, won("B")), rubber(2, won("B")), rubber(3, won("B")), rubber(4, { started: true }), rubber(5)],
      "STOP_WHEN_DECIDED",
    );
    expect(summary).toMatchObject({ winner: "B", status: "DECIDED", complete: false, notPlayedOrders: [5] });
    const done = computeTie(
      [rubber(1, won("B")), rubber(2, won("B")), rubber(3, won("B")), rubber(4, won("A")), rubber(5)],
      "STOP_WHEN_DECIDED",
    );
    expect(done).toMatchObject({ winner: "B", status: "COMPLETE", complete: true, rubbers: { A: 1, B: 3 }, notPlayedOrders: [5] });
  });

  it("结果重开后胜负撤回，未进行的小场恢复", () => {
    const reopened = computeTie(
      [rubber(1, won("B")), rubber(2, won("B")), rubber(3, { started: true }), rubber(4), rubber(5)],
      "STOP_WHEN_DECIDED",
    );
    expect(reopened).toMatchObject({ winner: null, status: "IN_PROGRESS", notPlayedOrders: [] });
  });

  it("中止等无胜方的小场不计胜负：全部锁定仍无人过半时为无法判定", () => {
    const summary = computeTie(
      [rubber(1, won("A")), rubber(2, won("A")), rubber(3, won("B")), rubber(4, won("B")), rubber(5, { started: true, final: true, winner: null })],
      "PLAY_ALL",
    );
    expect(summary).toMatchObject({ winner: null, status: "NO_RESULT", complete: true });
  });
});

function tie(sideA: string, sideB: string, rubbersA: number, rubbersB: number, games?: [number, number], points?: [number, number]): StandingTie {
  return {
    sideA,
    sideB,
    complete: true,
    winner: rubbersA > rubbersB ? "A" : "B",
    rubbers: { A: rubbersA, B: rubbersB },
    games: { A: games?.[0] ?? rubbersA * 2, B: games?.[1] ?? rubbersB * 2 },
    points: { A: points?.[0] ?? 0, B: points?.[1] ?? 0 },
  };
}

describe("小组积分榜", () => {
  it("按对抗胜场排名；两队胜场相同看相互间胜负", () => {
    const standings = computeStandings(
      ["A", "B", "C", "D"],
      [tie("A", "B", 3, 2), tie("A", "C", 3, 2), tie("D", "A", 3, 2), tie("B", "C", 3, 2), tie("B", "D", 3, 2), tie("C", "D", 3, 2)],
    );
    expect(standings.complete).toBe(true);
    expect(standings.rows.map((row) => [row.entryId, row.won, row.position, row.basis])).toEqual([
      ["A", 2, 1, "HEAD_TO_HEAD"],
      ["B", 2, 2, "HEAD_TO_HEAD"],
      ["C", 1, 3, "HEAD_TO_HEAD"],
      ["D", 1, 4, "HEAD_TO_HEAD"],
    ]);
    expect(standings.rows[0]).toMatchObject({ played: 3, rubbersWon: 8, rubbersLost: 7 });
    const clear = computeStandings(["A", "B", "C"], [tie("A", "B", 3, 2), tie("A", "C", 3, 2), tie("B", "C", 3, 2)]);
    expect(clear.rows.map((row) => row.basis)).toEqual(["WINS", "WINS", "WINS"]);
  });

  it("三队胜场相同：依次比较小场差、局差、分差；剩两队看相互胜负", () => {
    // A 胜 B、B 胜 C、C 胜 A（循环相克），各胜 D。
    const standings = computeStandings(
      ["A", "B", "C", "D"],
      [
        tie("A", "B", 3, 2),
        tie("B", "C", 3, 2),
        tie("C", "A", 3, 2),
        tie("A", "D", 5, 0),
        tie("B", "D", 4, 1),
        tie("C", "D", 4, 1, [8, 1]),
      ],
    );
    expect(standings.rows.map((row) => [row.entryId, row.position, row.basis])).toEqual([
      ["A", 1, "DIFFERENTIALS"],
      ["C", 2, "DIFFERENTIALS"],
      ["B", 3, "DIFFERENTIALS"],
      ["D", 4, "WINS"],
    ]);
  });

  it("三队各项都相同：须抽签，裁判长只能调整这几队的先后", () => {
    const standings = computeStandings(
      ["A", "B", "C", "D"],
      [tie("A", "B", 3, 2), tie("B", "C", 3, 2), tie("C", "A", 3, 2), tie("A", "D", 4, 1), tie("B", "D", 4, 1), tie("C", "D", 4, 1)],
    );
    expect(standings.unresolved).toEqual([["A", "B", "C"]]);
    expect(standings.rows.map((row) => row.position)).toEqual([1, 1, 1, 4]);
    expect(applyConfirmedOrder(standings, null).error).toContain("须抽签");
    expect(applyConfirmedOrder(standings, ["A", "B", "D", "C"]).error).toContain("只能调整须抽签");
    expect(applyConfirmedOrder(standings, ["C", "A", "B", "D"])).toEqual({ order: ["C", "A", "B", "D"], error: null });
  });

  it("未结束的对抗不计入，组内未全部结束不能确认名次；无须抽签时不接受手动改序", () => {
    const pending = { ...tie("A", "B", 3, 0), complete: false };
    const standings = computeStandings(["A", "B", "C"], [pending, tie("A", "C", 3, 2), tie("B", "C", 3, 2)]);
    expect(standings.complete).toBe(false);
    expect(standings.rows.find((row) => row.entryId === "A")?.played).toBe(1);
    expect(applyConfirmedOrder(standings, null).error).toContain("未结束");
    const done = computeStandings(["A", "B", "C"], [tie("A", "B", 3, 0), tie("A", "C", 3, 2), tie("B", "C", 3, 2)]);
    expect(applyConfirmedOrder(done, ["B", "A", "C"]).error).toContain("不能手动改动");
    expect(applyConfirmedOrder(done, null).order).toEqual(["A", "B", "C"]);
  });
});

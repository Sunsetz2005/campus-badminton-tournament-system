import { describe, expect, it } from "vitest";

import { validateTeamFormat } from "@/domain/registration/team-roster";
import { checkSchedule, warningDigest, type ScheduleCheckInput } from "@/domain/schedule/check";
import { projectDelays, type DelayItem } from "@/domain/schedule/delay";
import { MINUTE, type Placement, type ScheduleMatchFacts } from "@/domain/schedule/model";
import { suggestSchedule, type SuggestInput } from "@/domain/schedule/suggest";
import { appearanceErrors, validateLineup, type LineupRosterMember } from "@/domain/team/lineup";

const T0 = Date.UTC(2026, 9, 17, 1, 0); // 2026-10-17 09:00 +08:00

function match(id: string, overrides: Partial<ScheduleMatchFacts> = {}): ScheduleMatchFacts {
  return {
    id,
    code: id,
    label: id,
    competitionCode: "MS",
    stageOrder: 1,
    kind: "GROUP",
    groupKey: null,
    fixtureId: null,
    fixtureRound: 1,
    fixtureSequence: 1,
    rubberOrder: null,
    isTeam: false,
    status: "NOT_STARTED",
    actualStart: null,
    actualEnd: null,
    predecessors: [],
    confirmedEntries: [],
    candidateEntries: [],
    confirmedPersons: [],
    candidatePersons: [],
    hiddenPersons: false,
    ...overrides,
  };
}

function at(matchId: string, minutes: number, courtId: string | null = "c1", refereeId: string | null = "r1", duration = 30): Placement {
  return { matchId, courtId, start: T0 + minutes * MINUTE, durationMinutes: duration, refereeId, estimated: false };
}

function check(matches: ScheduleMatchFacts[], placements: Placement[], extra: Partial<ScheduleCheckInput> = {}) {
  return checkSchedule({
    matches,
    placements: new Map(placements.map((placement) => [placement.matchId, placement])),
    courts: [
      { id: "c1", code: "C1", name: "场地 1", active: true },
      { id: "c2", code: "C2", name: "场地 2", active: true },
      { id: "c3", code: "C3", name: "场地 3", active: false },
    ],
    referees: [{ id: "r1", name: "裁判甲" }, { id: "r2", name: "裁判乙" }],
    windows: [],
    names: new Map([["p-x", "张三"], ["p-y", "李四"], ["team-1", "数学学院"]]),
    ...extra,
  });
}

const codes = (result: ReturnType<typeof check>) => result.issues.map((issue) => `${issue.severity}:${issue.code}`);

describe("赛程冲突检查", () => {
  it("同一人同时报单打和双打：时间重叠是硬冲突，并写出是谁", () => {
    const singles = match("MS-1", { confirmedEntries: ["e-ms-x", "e-ms-q"], confirmedPersons: ["p-x", "p-q"] });
    const doubles = match("MD-1", { competitionCode: "MD", confirmedEntries: ["e-md-xy", "e-md-rs"], confirmedPersons: ["p-x", "p-y", "p-r", "p-s"] });
    const result = check([singles, doubles], [at("MS-1", 0, "c1", "r1"), at("MD-1", 15, "c2", "r2")]);
    expect(codes(result)).toEqual(["HARD:PERSON_OVERLAP"]);
    expect(result.issues[0].message).toContain("张三");
    // 错开后没有冲突。
    expect(check([singles, doubles], [at("MS-1", 0, "c1", "r1"), at("MD-1", 30, "c2", "r2")]).hardCount).toBe(0);
  });

  it("两个组合共享同一成员也按人检查", () => {
    const md = match("MD-1", { confirmedPersons: ["p-x", "p-y", "p-r", "p-s"] });
    const xd = match("XD-1", { confirmedPersons: ["p-y", "p-w", "p-t", "p-u"] });
    const result = check([md, xd], [at("MD-1", 0, "c1", "r1"), at("XD-1", 10, "c2", "r2")]);
    expect(codes(result)).toEqual(["HARD:PERSON_OVERLAP"]);
    expect(result.issues[0].message).toContain("李四");
  });

  it("同场地重叠、同裁判重叠、场地关闭、非裁判员都是硬冲突", () => {
    const a = match("A", { confirmedPersons: ["p1", "p2"] });
    const b = match("B", { confirmedPersons: ["p3", "p4"] });
    expect(codes(check([a, b], [at("A", 0, "c1", "r1"), at("B", 20, "c1", "r2")]))).toEqual(["HARD:COURT_OVERLAP"]);
    expect(codes(check([a, b], [at("A", 0, "c1", "r1"), at("B", 20, "c2", "r1")]))).toEqual(["HARD:REFEREE_OVERLAP"]);
    expect(codes(check([a], [at("A", 0, "c3", "r1")]))).toEqual(["HARD:COURT_CLOSED"]);
    expect(codes(check([a], [at("A", 0, "c1", "nobody")]))).toEqual(["HARD:REFEREE_NOT_ELIGIBLE"]);
  });

  it("淘汰赛依赖：前序未排是硬冲突，排在前序预计结束之前也是硬冲突；前序已实际结束就以实际时间为准", () => {
    const group = match("G1", { confirmedPersons: ["p1", "p2"] });
    const final = match("F", { kind: "KNOCKOUT", stageOrder: 2, predecessors: ["G1"], candidateEntries: ["e1", "e2"] });
    expect(codes(check([group, final], [at("F", 60, "c2", "r2")])).filter((code) => code.startsWith("HARD"))).toEqual(["HARD:DEPENDENCY_UNSCHEDULED"]);
    expect(codes(check([group, final], [at("G1", 0), at("F", 20, "c2", "r2")])).filter((code) => code.startsWith("HARD"))).toEqual(["HARD:DEPENDENCY_ORDER"]);
    const ended = { ...group, status: "ENDED" as const, actualStart: T0 - 60 * MINUTE, actualEnd: T0 - 10 * MINUTE };
    expect(check([ended, final], [at("G1", 0), at("F", 20, "c2", "r2")]).hardCount).toBe(0);
  });

  it("尚未确定的晋级来源：跨项目按候选集合保守检查，只给「暂定」警告；同项目两场未定对阵可以同时进行", () => {
    const semi1 = match("SF1", { kind: "KNOCKOUT", stageOrder: 2, candidateEntries: ["e1", "e2", "e3"], candidatePersons: ["p1", "p2", "p3"] });
    // 同一项目的另一场半决赛：签表上每个名次只流向一个位置，不会共用运动员。
    const sameEvent = match("SF2", { kind: "KNOCKOUT", stageOrder: 2, candidateEntries: ["e3", "e4"], candidatePersons: ["p3", "p4"] });
    expect(check([semi1, sameEvent], [at("SF1", 0, "c1", "r1"), at("SF2", 0, "c2", "r2")]).issues).toEqual([]);
    // 另一个项目里同一人（兼报）可能晋级：保守给暂定警告。
    const other = match("MD-SF", { competitionCode: "MD", kind: "KNOCKOUT", stageOrder: 2, candidatePersons: ["p3", "p9"] });
    const result = check([semi1, other], [at("SF1", 0, "c1", "r1"), at("MD-SF", 0, "c2", "r2")]);
    expect(codes(result)).toEqual(["WARNING:TENTATIVE_OVERLAP"]);
    expect(result.tentativeMatchIds.sort()).toEqual(["MD-SF", "SF1"]);
    expect(result.issues[0].message).toContain("暂定");
  });

  it("同一支队伍的两场不同对抗重叠是硬冲突；同一场对抗在两块场地并行的小场不算队伍冲突，但同一队员不行", () => {
    const tieA1 = match("T1-1", { isTeam: true, fixtureId: "f1", rubberOrder: 1, confirmedEntries: ["team-1", "team-2"] });
    const tieA2 = match("T1-2", { isTeam: true, fixtureId: "f1", rubberOrder: 2, confirmedEntries: ["team-1", "team-2"] });
    const tieB1 = match("T2-1", { isTeam: true, fixtureId: "f2", rubberOrder: 1, confirmedEntries: ["team-1", "team-3"] });
    expect(check([tieA1, tieA2], [at("T1-1", 0, "c1", "r1"), at("T1-2", 0, "c2", "r2")]).issues).toEqual([]);
    const cross = check([tieA1, tieB1], [at("T1-1", 0, "c1", "r1"), at("T2-1", 10, "c2", "r2")]);
    expect(codes(cross)).toEqual(["HARD:TEAM_OVERLAP"]);
    expect(cross.issues[0].message).toContain("数学学院");
    // 已提交但尚未公开的名单里同一队员上了两个并行小场：硬冲突，但解释里不写姓名。
    const hiddenA1 = { ...tieA1, confirmedPersons: ["p-x", "p-a"], hiddenPersons: true };
    const hiddenA2 = { ...tieA2, confirmedPersons: ["p-x", "p-b"], hiddenPersons: true };
    const hidden = check([hiddenA1, hiddenA2], [at("T1-1", 0, "c1", "r1"), at("T1-2", 0, "c2", "r2")]);
    expect(codes(hidden)).toEqual(["HARD:PERSON_OVERLAP"]);
    expect(hidden.issues[0].message).not.toContain("张三");
    expect(hidden.issues[0].message).toContain("不显示姓名");
  });

  it("两场都已开始或结束的重叠是既成事实，不再报排程冲突；草稿改了已开始的比赛是硬冲突", () => {
    const a = match("A", { status: "ENDED", actualStart: T0, actualEnd: T0 + 40 * MINUTE, confirmedPersons: ["p1"] });
    const b = match("B", { status: "IN_PROGRESS", actualStart: T0 + 10 * MINUTE, confirmedPersons: ["p1"] });
    expect(check([a, b], [at("A", 0, "c1", "r1"), at("B", 10, "c1", "r1")]).issues).toEqual([]);
    expect(codes(check([a, b], [at("A", 0), at("B", 10, "c2", "r2")], { lockedChanges: ["B"] }))).toEqual(["HARD:STARTED_MATCH_CHANGED"]);
  });

  it("警告：超出开放时段、未指派裁判；摘要随警告集合变化", () => {
    const a = match("A");
    const b = match("B");
    const windows = [{ start: T0, end: T0 + 60 * MINUTE }];
    const result = check([a, b], [at("A", 0, "c1", null), at("B", 45, "c2", "r2")], { windows });
    expect(codes(result).sort()).toEqual(["WARNING:NO_REFEREE", "WARNING:OUTSIDE_HOURS"]);
    expect(result.hardCount).toBe(0);
    const again = check([a, b], [at("A", 0, "c1", null), at("B", 45, "c2", "r2")], { windows });
    expect(warningDigest(again.issues)).toBe(warningDigest(result.issues));
    const changed = check([a, b], [at("A", 0, "c1", null), at("B", 0, "c2", null)], { windows });
    expect(warningDigest(changed.issues)).not.toBe(warningDigest(result.issues));
  });

  it("只看某场比赛时只返回与它有关的问题", () => {
    const a = match("A", { confirmedPersons: ["p1"] });
    const b = match("B", { confirmedPersons: ["p1"] });
    const c = match("C", { confirmedPersons: ["p9"] });
    const result = check([a, b, c], [at("A", 0, "c1", "r1"), at("B", 0, "c2", "r2"), at("C", 0, "c3", null)], { focus: new Set(["C"]) });
    expect(codes(result).sort()).toEqual(["HARD:COURT_CLOSED", "WARNING:NO_REFEREE"]);
  });
});

describe("自动排程建议", () => {
  const windows = [
    { start: T0, end: T0 + 9 * 60 * MINUTE },
    { start: T0 + 24 * 60 * MINUTE, end: T0 + 33 * 60 * MINUTE },
  ];
  const config = { matchMinutes: 30, rubberMinutes: 25, changeoverMinutes: 5, knockoutTieCourts: 2 };

  function tie(fixtureId: string, groupKey: string | null, round: number, entries: string[], extra: Partial<ScheduleMatchFacts> = {}) {
    return [1, 2, 3, 4, 5].map((order) =>
      match(`${fixtureId}-${order}`, {
        competitionCode: "TEAM",
        isTeam: true,
        fixtureId,
        groupKey,
        kind: groupKey ? "GROUP" : "KNOCKOUT",
        stageOrder: groupKey ? 1 : 2,
        fixtureRound: round,
        rubberOrder: order,
        confirmedEntries: entries,
        ...extra,
      }),
    );
  }

  function run(matches: ScheduleMatchFacts[], overrides: Partial<SuggestInput> = {}) {
    return suggestSchedule({
      matches,
      scope: new Set(matches.map((item) => item.id)),
      current: new Map(),
      courtIds: ["c1", "c2", "c3"],
      refereeIds: ["r1", "r2", "r3"],
      windows,
      notBefore: T0,
      config,
      ...overrides,
    });
  }

  it("团体小组赛一组一块场地、小场按顺序连打；淘汰赛两块场地并行且排在小组赛之后", () => {
    const groupA = [...tie("fa1", "TEAM:A", 1, ["t1", "t2"]), ...tie("fa2", "TEAM:A", 2, ["t1", "t3"])];
    const groupB = tie("fb1", "TEAM:B", 1, ["t4", "t5"]);
    const final = tie("ko", null, 1, [], { candidateEntries: ["t1", "t2", "t3", "t4", "t5"], predecessors: [...groupA, ...groupB].map((item) => item.id) });
    // 两个小组、两块场地：一组一块。
    const result = run([...groupA, ...groupB, ...final], { courtIds: ["c1", "c2"] });
    expect(result.unplaced).toEqual([]);
    const byId = new Map(result.placements.map((placement) => [placement.matchId, placement]));

    // A 组全部在同一块场地上，第一场对抗 09:00 起每 30 分钟一个小场，第二场对抗紧接着。
    const courtA = byId.get("fa1-1")!.courtId;
    expect(groupA.every((item) => byId.get(item.id)!.courtId === courtA)).toBe(true);
    expect(groupA.map((item) => (byId.get(item.id)!.start! - T0) / MINUTE)).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240, 270]);
    expect(byId.get("fa1-1")!.estimated).toBe(false);
    expect(byId.get("fa1-2")!.estimated).toBe(true);
    // B 组在另一块场地同时开打。
    expect(byId.get("fb1-1")!.courtId).not.toBe(courtA);
    expect(byId.get("fb1-1")!.start).toBe(T0);

    // 淘汰赛：两块场地，1/3/5 在一块、2/4 在另一块，第 1、2 场同时开始，且在全部小组赛结束之后。
    const koCourts = new Set(final.map((item) => byId.get(item.id)!.courtId));
    expect(koCourts.size).toBe(2);
    expect(byId.get("ko-1")!.start).toBe(byId.get("ko-2")!.start);
    expect(byId.get("ko-3")!.courtId).toBe(byId.get("ko-1")!.courtId);
    const groupEnd = Math.max(...[...groupA, ...groupB].map((item) => byId.get(item.id)!.start! + 25 * MINUTE));
    expect(byId.get("ko-1")!.start!).toBeGreaterThanOrEqual(groupEnd + 5 * MINUTE);

    // 建议本身通过检查：没有硬冲突。
    const verdict = checkSchedule({
      matches: [...groupA, ...groupB, ...final],
      placements: byId,
      courts: ["c1", "c2", "c3"].map((id) => ({ id, code: id, name: id, active: true })),
      referees: ["r1", "r2", "r3"].map((id) => ({ id, name: id })),
      windows,
      names: new Map(),
    });
    expect(verdict.hardCount).toBe(0);
  });

  it("场地多于小组：单循环一组也会用上全部场地，但同一支队伍不会同时打两场对抗", () => {
    const round1 = [...tie("r1a", "TEAM:A", 1, ["t1", "t2"]), ...tie("r1b", "TEAM:A", 1, ["t3", "t4"])];
    const round2 = [...tie("r2a", "TEAM:A", 2, ["t1", "t3"]), ...tie("r2b", "TEAM:A", 2, ["t2", "t4"])];
    const result = run([...round1, ...round2], { courtIds: ["c1", "c2"] });
    const byId = new Map(result.placements.map((placement) => [placement.matchId, placement]));
    // 第一轮两场对抗同时在两块场地开打，每场对抗的小场都在同一块场地上。
    expect(byId.get("r1a-1")!.start).toBe(T0);
    expect(byId.get("r1b-1")!.start).toBe(T0);
    expect(byId.get("r1a-1")!.courtId).not.toBe(byId.get("r1b-1")!.courtId);
    for (const key of ["r1a", "r1b", "r2a", "r2b"]) {
      expect(new Set([1, 2, 3, 4, 5].map((order) => byId.get(`${key}-${order}`)!.courtId)).size).toBe(1);
    }
    // 第二轮要等两支相关队伍都打完第一轮。
    expect(byId.get("r2a-1")!.start).toBe(T0 + 150 * MINUTE);
  });

  it("个人项目：同一人的单打与双打不会被排在同一时间；裁判不会同时执裁两场", () => {
    const ms = match("MS-1", { confirmedPersons: ["p-x", "p-q"] });
    const md = match("MD-1", { competitionCode: "MD", confirmedPersons: ["p-x", "p-y", "p-r", "p-s"] });
    const other = match("MS-2", { confirmedPersons: ["p-a", "p-b"], fixtureSequence: 2 });
    const result = run([ms, md, other], { refereeIds: ["r1"] });
    const byId = new Map(result.placements.map((placement) => [placement.matchId, placement]));
    const overlap = (left: Placement, right: Placement) =>
      left.start! < right.start! + right.durationMinutes * MINUTE && right.start! < left.start! + left.durationMinutes * MINUTE;
    expect(overlap(byId.get("MS-1")!, byId.get("MD-1")!)).toBe(false);
    const withReferee = result.placements.filter((placement) => placement.refereeId === "r1");
    for (const left of withReferee) for (const right of withReferee) if (left !== right) expect(overlap(left, right)).toBe(false);
    expect(result.placements.some((placement) => placement.refereeId === null)).toBe(true);
  });

  it("排程无解：没有场地、没有比赛日或时段内排不下时如实列出原因，不硬塞", () => {
    const ms = match("MS-1");
    expect(run([ms], { courtIds: [] }).unplaced).toEqual([{ matchId: "MS-1", reason: "NO_COURT" }]);
    expect(run([ms], { windows: [] }).unplaced).toEqual([{ matchId: "MS-1", reason: "NO_WINDOW" }]);
    expect(run([ms], { windows: [{ start: T0, end: T0 + 20 * MINUTE }] }).unplaced).toEqual([{ matchId: "MS-1", reason: "DOES_NOT_FIT" }]);
    const ko = match("KO", { predecessors: ["G-out-of-scope"] });
    const outside = match("G-out-of-scope");
    expect(run([ko, outside], { scope: new Set(["KO"]) }).unplaced).toEqual([{ matchId: "KO", reason: "PREDECESSOR_UNSCHEDULED" }]);
  });

  it("排不进当天就顺延到下一个比赛日；已开始的比赛与范围外的安排视为占用", () => {
    const long = tie("f1", "TEAM:A", 1, ["t1", "t2"]);
    const started = match("LIVE", { status: "IN_PROGRESS", actualStart: T0, confirmedPersons: ["p9"] });
    const result = run([...long, started], {
      courtIds: ["c1"],
      current: new Map([["LIVE", at("LIVE", 0, "c1", "r1", 60)]]),
      windows: [{ start: T0, end: T0 + 180 * MINUTE }, windows[1]],
    });
    const first = result.placements.find((placement) => placement.matchId === "f1-1")!;
    // 当天 09:00—12:00 场地 1 先被进行中的比赛占到 10:05，五个小场排不下，顺延到第二天。
    expect(first.start).toBe(windows[1].start);
  });

  it("同样的输入得到同样的建议", () => {
    const matches = [...tie("fa1", "TEAM:A", 1, ["t1", "t2"]), match("MS-1", { confirmedPersons: ["p1"] })];
    expect(run(matches)).toEqual(run(matches));
  });
});

describe("延误推算", () => {
  const item = (matchId: string, minutes: number, overrides: Partial<DelayItem> = {}): DelayItem => ({
    matchId,
    label: matchId,
    courtId: "c1",
    refereeId: null,
    persons: [],
    plannedStart: T0 + minutes * MINUTE,
    durationMinutes: 30,
    status: "NOT_STARTED",
    actualStart: null,
    actualEnd: null,
    ...overrides,
  });

  it("同场地上一场超时：后面的比赛顺延并有据标记", () => {
    const now = T0 + 50 * MINUTE;
    const result = projectDelays(
      [item("A", 0, { status: "IN_PROGRESS", actualStart: T0 }), item("B", 35), item("C", 70)],
      now,
      { changeoverMinutes: 5 },
    );
    expect(result.get("A")).toMatchObject({ overrun: true, delayed: false });
    expect(result.get("B")).toMatchObject({ delayed: true, evidenced: true, cause: "COURT", causeMatchId: "A", delayMinutes: 20 });
    expect(result.get("C")).toMatchObject({ delayed: true, evidenced: true, cause: "COURT", delayMinutes: 20 });
  });

  it("前一场晚结束同样顺延；只是过了计划时间还没开赛不算有据延误", () => {
    const late = projectDelays(
      [item("A", 0, { status: "ENDED", actualStart: T0, actualEnd: T0 + 45 * MINUTE }), item("B", 35)],
      T0 + 40 * MINUTE,
      { changeoverMinutes: 5 },
    );
    expect(late.get("B")).toMatchObject({ delayed: true, evidenced: true, delayMinutes: 15 });
    const idle = projectDelays([item("A", 0), item("B", 35)], T0 + 20 * MINUTE, { changeoverMinutes: 5 });
    expect(idle.get("A")).toMatchObject({ delayed: true, evidenced: false, cause: "LATE_START" });
    expect(idle.get("B")).toMatchObject({ delayed: true, evidenced: false });
  });

  it("裁判与运动员链：同一裁判或同一运动员的上一场未完，下一场也顺延", () => {
    const now = T0 + 45 * MINUTE;
    const result = projectDelays(
      [
        item("A", 0, { status: "IN_PROGRESS", actualStart: T0 + 10 * MINUTE, refereeId: "r1", persons: ["p1"] }),
        item("B", 35, { courtId: "c2", refereeId: "r1" }),
        item("C", 35, { courtId: "c3", persons: ["p1"] }),
      ],
      now,
      { changeoverMinutes: 5 },
    );
    expect(result.get("B")).toMatchObject({ cause: "REFEREE", evidenced: true });
    expect(result.get("C")).toMatchObject({ cause: "PLAYER", evidenced: true });
  });
});

describe("团体出场名单：兼项上限与同时进行的小场", () => {
  const roster: LineupRosterMember[] = [
    { participantId: "m1", label: "男1", gender: "MALE", rubberKinds: ["MS", "MD", "XD"] },
    { participantId: "m2", label: "男2", gender: "MALE", rubberKinds: ["MS", "MD", "XD"] },
    { participantId: "m3", label: "男3", gender: "MALE", rubberKinds: ["MS", "MD", "XD"] },
    { participantId: "m4", label: "男4", gender: "MALE", rubberKinds: ["MS", "MD", "XD"] },
    { participantId: "f1", label: "女1", gender: "FEMALE", rubberKinds: ["WS", "WD", "XD"] },
    { participantId: "f2", label: "女2", gender: "FEMALE", rubberKinds: ["WS", "WD", "XD"] },
  ];
  // 秩序册顺序：混双、男单、女单、男双、女双。
  const rubbers = [
    { order: 1, kind: "XD" as const },
    { order: 2, kind: "MS" as const },
    { order: 3, kind: "WS" as const },
    { order: 4, kind: "MD" as const },
    { order: 5, kind: "WD" as const },
  ];
  const limits = { MALE: 1, FEMALE: 2 };
  const good = [
    { order: 1, participantIds: ["m1", "f1"] },
    { order: 2, participantIds: ["m2"] },
    { order: 3, participantIds: ["f2"] },
    { order: 4, participantIds: ["m3", "m4"] },
    { order: 5, participantIds: ["f1", "f2"] },
  ];

  it("男队员不得兼项、女队员最多 2 项", () => {
    expect(validateLineup(rubbers, roster, good, { limits }).errors).toEqual([]);
    const maleTwice = good.map((item) => (item.order === 2 ? { order: 2, participantIds: ["m1"] } : item));
    expect(validateLineup(rubbers, roster, maleTwice, { limits }).errors).toEqual(["男1 在本场对抗里上了 2 个小场，男队员最多 1 个"]);
    // 不设上限时（4-D 的默认）同样的名单可以通过。
    expect(validateLineup(rubbers, roster, maleTwice).errors).toEqual([]);
  });

  it("赛程上同时进行的两个小场不能由同一名队员出场", () => {
    const errors = appearanceErrors(
      [
        { order: 1, kind: "XD", participantIds: ["m1", "f1"] },
        { order: 2, kind: "MS", participantIds: ["m2"] },
        { order: 3, kind: "WS", participantIds: ["f1"] },
      ],
      roster,
      { overlappingOrders: [[1, 2], [1, 3]] },
    );
    expect(errors).toEqual(["第 1 场与第 3 场在赛程上同时进行，女1 不能两场都出场"]);
  });

  it("设了兼项上限时，名单最少人数要够排满一场对抗", () => {
    const format = { rubbers: ["XD", "MS", "WS", "MD", "WD"] as const, rosterMin: 8, rosterMax: 12, minMale: 2, minFemale: 2 };
    expect(validateTeamFormat({ ...format, rubbers: [...format.rubbers], maxRubbersMale: 1, maxRubbersFemale: 2 })).toEqual([
      "男队员每场最多 1 项、每场对抗需要 4 男次，名单至少要 4 名男队员",
    ]);
    expect(validateTeamFormat({ ...format, rubbers: [...format.rubbers], minMale: 4, maxRubbersMale: 1, maxRubbersFemale: 2 })).toEqual([]);
    expect(validateTeamFormat({ ...format, rubbers: [...format.rubbers], maxRubbersMale: 0 })).toHaveLength(1);
  });
});

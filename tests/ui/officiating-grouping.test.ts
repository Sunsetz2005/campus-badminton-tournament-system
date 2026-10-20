import { describe, expect, it } from "vitest";

import {
  filterOfficiatingMatches,
  groupOfficiatingMatches,
  parseOfficiatingView,
  type GroupableMatch,
} from "@/features/officiating/grouping";

const TZ = "Asia/Shanghai";
const court = (id: string, sortOrder: number) => ({ id, name: `${sortOrder} 号场`, sortOrder });
const ms = { id: "ms", code: "MS", name: "男子单打" };
const wd = { id: "wd", code: "WD", name: "女子双打" };

function match(code: string, overrides: Partial<GroupableMatch> = {}): GroupableMatch {
  return { code, status: "NOT_STARTED", scheduledAt: null, sideA: "甲", sideB: "乙", court: null, competition: ms, ...overrides };
}

const matches: GroupableMatch[] = [
  match("M1", { court: court("c2", 2), scheduledAt: new Date("2026-11-02T01:00:00Z") }),
  match("M2", { court: court("c1", 1), scheduledAt: new Date("2026-11-02T02:00:00Z"), status: "IN_PROGRESS" }),
  match("M3", { court: court("c1", 1), scheduledAt: new Date("2026-11-02T01:00:00Z") }),
  match("M4", { court: court("c10", 10), scheduledAt: new Date("2026-11-03T01:00:00Z"), competition: wd, sideA: "张三" }),
  match("M5", { status: "ENDED", court: court("c1", 1), scheduledAt: new Date("2026-11-02T00:00:00Z") }),
  match("M6"),
];

describe("我的执裁：比赛分组", () => {
  it("未知查看方式回落到按场地", () => {
    expect(parseOfficiatingView(undefined)).toBe("court");
    expect(parseOfficiatingView("bogus")).toBe("court");
    expect(parseOfficiatingView("time")).toBe("time");
  });

  it("按场地：场地按排序号（10 号场排在 2 号场之后），组内进行中在前、再按时间，未排场地的放最后", () => {
    const groups = groupOfficiatingMatches(matches, "court", TZ);
    expect(groups.map((group) => group.title)).toEqual(["1 号场", "2 号场", "10 号场", "场地待定"]);
    expect(groups[0].matches.map((item) => item.code)).toEqual(["M2", "M3", "M5"]);
    expect(groups[0]).toMatchObject({ liveCount: 1, upcomingCount: 1 });
  });

  it("按时间：按赛事时区的比赛日分组、组内严格按时间，时间待定放最后", () => {
    const groups = groupOfficiatingMatches(matches, "time", TZ);
    expect(groups.map((group) => group.title)).toEqual(["11-02 周一", "11-03 周二", "时间待定"]);
    expect(groups[0].matches.map((item) => item.code)).toEqual(["M5", "M1", "M3", "M2"]);
  });

  it("按项目：按项目代码分组", () => {
    const groups = groupOfficiatingMatches(matches, "event", TZ);
    expect(groups.map((group) => group.title)).toEqual(["男子单打", "女子双打"]);
    expect(groups[1].matches.map((item) => item.code)).toEqual(["M4"]);
  });

  it("默认隐藏已结束；可按编号或选手名搜索", () => {
    expect(filterOfficiatingMatches(matches, { showFinished: false }).map((item) => item.code)).not.toContain("M5");
    expect(filterOfficiatingMatches(matches, { showFinished: true })).toHaveLength(6);
    expect(filterOfficiatingMatches(matches, { showFinished: false, query: "张三" }).map((item) => item.code)).toEqual(["M4"]);
    expect(filterOfficiatingMatches(matches, { showFinished: false, query: "m6" }).map((item) => item.code)).toEqual(["M6"]);
  });
});

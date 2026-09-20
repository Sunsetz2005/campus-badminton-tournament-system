import { describe, expect, it } from "vitest";

import { PUBLIC_PREVIEW_MATCHES, PUBLIC_PREVIEW_TOURNAMENT } from "@/features/public-preview/fixtures";
import { filterPreviewMatches, parseScheduleQuery, preserveScheduleParams, withScheduleQuery } from "@/features/public-preview/query";

const dates = PUBLIC_PREVIEW_TOURNAMENT.dates.map((item) => item.date);
const options = {
  competitions: [...new Set(PUBLIC_PREVIEW_MATCHES.map((match) => match.competitionCode))],
  courts: [...new Set(PUBLIC_PREVIEW_MATCHES.map((match) => match.court).filter((court): court is string => Boolean(court)))],
  dates,
  stages: [...new Set(PUBLIC_PREVIEW_MATCHES.map((match) => match.stageCode))],
};

describe("公开赛程预览查询", () => {
  it("解析三维状态并稳定忽略未知和过长值", () => {
    const params = new URLSearchParams({
      date: "2099-01-01",
      lifecycle: "SUSPENDED,IN_PROGRESS,SUSPENDED,UNKNOWN",
      verification: "LOCKED,PENDING_REVIEW",
      outcome: "RET,NORMAL",
      q: "甲".repeat(80),
    });
    const parsed = parseScheduleQuery(params, options, "2026-10-14");

    expect(parsed.value).toMatchObject({
      date: "2099-01-01",
      lifecycle: ["IN_PROGRESS", "SUSPENDED"],
      outcome: ["NORMAL", "RET"],
      verification: ["LOCKED", "PENDING_REVIEW"],
    });
    expect(parsed.value.q).toHaveLength(60);
    expect(parsed.issues.map((issue) => issue.reason)).toEqual(expect.arrayContaining(["INVALID_DATE", "UNKNOWN_OPTION", "TOO_LONG"]));
  });

  it("维度内使用 OR、维度间使用 AND，并保持服务端顺序与 A/B 身份", () => {
    const parsed = parseScheduleQuery(new URLSearchParams({
      date: "2026-10-14",
      lifecycle: "IN_PROGRESS,SUSPENDED",
      competition: "MS",
    }), options, "2026-10-14").value;
    const matches = filterPreviewMatches(PUBLIC_PREVIEW_MATCHES, parsed);

    expect(matches.map((match) => match.code)).toEqual(["MS-P101"]);
    expect(matches[0].sideA?.teamName).toBe("青岚一队");
    expect(matches[0].sideB?.teamName).toBe("澄海二队");
  });

  it("搜索只匹配公开 fixture 字段并正确查找双打第二名成员", () => {
    const parsed = parseScheduleQuery(new URLSearchParams({ date: "2026-10-14", q: "唐屿" }), options, "2026-10-14").value;
    expect(filterPreviewMatches(PUBLIC_PREVIEW_MATCHES, parsed).map((match) => match.code)).toEqual(["MD-P201"]);
  });

  it("只保留白名单查询参数，不接受任意 returnTo", () => {
    const input = new URLSearchParams({ date: "2026-10-14", q: "青岚", returnTo: "https://example.test" });
    expect(preserveScheduleParams(input, options).toString()).toBe("date=2026-10-14&q=%E9%9D%92%E5%B2%9A");
    expect(withScheduleQuery("/schedule", input, { court: "1号场" }, options)).not.toContain("returnTo");
  });

  it("规范化多值参数并丢弃未知单值选项", () => {
    const input = new URLSearchParams({
      competition: "UNKNOWN",
      date: "2026-10-14",
      lifecycle: "SUSPENDED,IN_PROGRESS,SUSPENDED,UNKNOWN",
      scenario: "ready",
    });

    expect(preserveScheduleParams(input, options).toString()).toBe("date=2026-10-14&lifecycle=IN_PROGRESS%2CSUSPENDED");
  });
});

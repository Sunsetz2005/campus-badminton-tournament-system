import { describe, expect, it } from "vitest";

import { isCalendarDate } from "@/domain/time/zoned-time";
import { scheduleDateIn, scheduleDateOption } from "@/server/services/public-projection";

describe("AUD-007 自然日校验", () => {
  it("拒绝不存在的日期与错误形状", () => {
    for (const value of ["2026-02-29", "2026-02-30", "2026-02-31", "2026-13-01", "2026-00-10", "2026-04-31", "2026-4-1", ""]) {
      expect(isCalendarDate(value), value).toBe(false);
    }
  });

  it("接受真实日期，包括闰日与月末", () => {
    for (const value of ["2028-02-29", "2026-02-28", "2026-12-31", "2026-01-01"]) {
      expect(isCalendarDate(value), value).toBe(true);
    }
  });
});

describe("AUD-009 日期标签与筛选值是同一天", () => {
  it.each(["UTC", "Asia/Shanghai", "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York"])("%s", (timeZone) => {
    // 赛事时区下真实的一个时刻 → 自然日 → 标签，标签必须仍是这一天。
    const isoDay = scheduleDateIn(timeZone, new Date("2026-10-15T10:30:00Z"));
    const option = scheduleDateOption(isoDay);
    const [, month, day] = isoDay.split("-").map(Number);
    expect(option.date).toBe(isoDay);
    expect(option.dayLabel).toBe(`${month}月${day}日`);
  });

  it("星期跟随日历日本身", () => {
    expect(scheduleDateOption("2026-10-15").weekdayLabel).toBe("周四");
    expect(scheduleDateOption("2026-03-08").dayLabel).toBe("3月8日");
  });
});

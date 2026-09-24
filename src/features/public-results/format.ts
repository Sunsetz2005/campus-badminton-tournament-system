import type { PublicMatchTime } from "./model";

// 全部公开时间都按赛事时区渲染，不按访问设备时区。
// 调用方传入 `Tournament.timezone`（已在服务端按 IANA 标识校验过）。
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();
const syncFormatters = new Map<string, Intl.DateTimeFormat>();

function cached(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) {
  const existing = cache.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("zh-CN", { ...options, timeZone });
  cache.set(timeZone, formatter);
  return formatter;
}

export function formatPreviewDateTime(value: string | null, timeZone: string = DEFAULT_TIME_ZONE) {
  if (!value) return "待定";
  return cached(dateTimeFormatters, timeZone, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatPreviewTime(time: PublicMatchTime, timeZone: string = DEFAULT_TIME_ZONE) {
  const clock = (value: string) =>
    cached(timeFormatters, timeZone, { hour: "2-digit", hour12: false, minute: "2-digit" }).format(new Date(value));

  switch (time.type) {
    case "FIXED":
      return { primary: clock(time.scheduledAt), secondary: "计划时间" };
    case "ESTIMATED":
      return { primary: clock(time.scheduledAt), secondary: "预计" };
    case "DELAYED":
      return {
        primary: clock(time.scheduledAt),
        secondary: `延后 · 原计划 ${clock(time.originalScheduledAt)}`,
      };
    case "AFTER_MATCH":
      return { primary: "前序比赛后", secondary: `等待 ${time.precedingMatchCode}` };
    case "TBD":
      return { primary: "时间待定", secondary: "以现场公告为准" };
  }
}

export function formatPreviewSyncTime(value: string, timeZone: string = DEFAULT_TIME_ZONE) {
  return cached(syncFormatters, timeZone, {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

const dayFormatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeZone: "UTC" });

/**
 * 赛事起止日期是 `@db.Date` 自然日，服务端已序列化成 `YYYY-MM-DD`。
 * 它不带时刻，因此按 UTC 渲染以避免任何时区把它前后挪一天。
 */
export function formatDateRange(startDate: string | null, endDate: string | null) {
  const day = (value: string) => dayFormatter.format(new Date(`${value}T00:00:00Z`));
  if (startDate && endDate) return startDate === endDate ? day(startDate) : `${day(startDate)} — ${day(endDate)}`;
  if (startDate) return `${day(startDate)} 起`;
  if (endDate) return `至 ${day(endDate)}`;
  return "日期待定";
}

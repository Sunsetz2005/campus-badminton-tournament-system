import type { PublicMatchTime } from "./model";

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "Asia/Shanghai",
});

export function formatPreviewDateTime(value: string | null) {
  return value ? dateTimeFormatter.format(new Date(value)) : "待定";
}

export function formatPreviewTime(time: PublicMatchTime) {
  switch (time.type) {
    case "FIXED":
      return { primary: timeFormatter.format(new Date(time.scheduledAt)), secondary: "计划时间" };
    case "ESTIMATED":
      return { primary: timeFormatter.format(new Date(time.scheduledAt)), secondary: "预计" };
    case "DELAYED":
      return {
        primary: timeFormatter.format(new Date(time.scheduledAt)),
        secondary: `延后 · 原计划 ${timeFormatter.format(new Date(time.originalScheduledAt))}`,
      };
    case "AFTER_MATCH":
      return { primary: "前序比赛后", secondary: `等待 ${time.precedingMatchCode}` };
    case "TBD":
      return { primary: "时间待定", secondary: "以现场公告为准" };
  }
}

export function formatPreviewSyncTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

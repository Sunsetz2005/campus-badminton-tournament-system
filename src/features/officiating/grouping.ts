import type { MatchScheduleStatus } from "@/domain/schedule/model";
import { utcToZonedLocal } from "@/domain/time/zoned-time";

/** 赛事内「我的执裁」的查看方式：按场地分组（默认）、按时间顺序、按比赛项目。 */
export type OfficiatingView = "court" | "time" | "event";

export const OFFICIATING_VIEWS: readonly { value: OfficiatingView; label: string }[] = [
  { value: "court", label: "按场地" },
  { value: "time", label: "按时间" },
  { value: "event", label: "按项目" },
];

export function parseOfficiatingView(value: string | undefined): OfficiatingView {
  return value === "time" || value === "event" ? value : "court";
}

export interface GroupableMatch {
  code: string;
  status: MatchScheduleStatus;
  scheduledAt: Date | null;
  sideA: string;
  sideB: string;
  court: { id: string; name: string; sortOrder: number } | null;
  competition: { id: string; code: string; name: string };
}

export interface MatchGroup<T> {
  key: string;
  title: string;
  matches: T[];
  liveCount: number;
  upcomingCount: number;
}

/** 进行中 → 待开赛 → 已结束 → 未进行。 */
const statusRank: Record<MatchScheduleStatus, number> = { IN_PROGRESS: 0, NOT_STARTED: 1, ENDED: 2, NOT_PLAYED: 3 };
export const isFinished = (status: MatchScheduleStatus) => status === "ENDED" || status === "NOT_PLAYED";

const timeOf = (match: GroupableMatch) => match.scheduledAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
const byTime = (left: GroupableMatch, right: GroupableMatch) => timeOf(left) - timeOf(right) || left.code.localeCompare(right.code);
const byStatusThenTime = (left: GroupableMatch, right: GroupableMatch) =>
  statusRank[left.status] - statusRank[right.status] || byTime(left, right);

/** 「只看未结束」和关键字（比赛编号、选手或队伍名）筛选。 */
export function filterOfficiatingMatches<T extends GroupableMatch>(matches: T[], options: { showFinished: boolean; query?: string }) {
  const query = options.query?.trim().toLowerCase();
  return matches.filter((match) => {
    if (!options.showFinished && isFinished(match.status)) return false;
    if (!query) return true;
    return [match.code, match.sideA, match.sideB].some((text) => text.toLowerCase().includes(query));
  });
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dayLabel(day: string) {
  const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
  return `${day.slice(5)} ${weekday}`;
}

function summarize<T extends GroupableMatch>(key: string, title: string, matches: T[]): MatchGroup<T> {
  return {
    key,
    title,
    matches,
    liveCount: matches.filter((match) => match.status === "IN_PROGRESS").length,
    upcomingCount: matches.filter((match) => match.status === "NOT_STARTED").length,
  };
}

/**
 * 把比赛分组：
 * - 按场地：场地按排序号，组内进行中在前、待开赛按计划时间；没排场地的放最后。
 * - 按时间：按赛事时区的比赛日分组，组内严格按计划时间；时间待定的放最后。
 * - 按项目：按项目代码，组内进行中在前、待开赛按计划时间。
 */
export function groupOfficiatingMatches<T extends GroupableMatch>(matches: T[], view: OfficiatingView, timeZone: string): MatchGroup<T>[] {
  const buckets = new Map<string, { title: string; order: [number, string]; matches: T[] }>();
  const put = (key: string, title: string, order: [number, string], match: T) => {
    const bucket = buckets.get(key) ?? { title, order, matches: [] };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  };
  for (const match of matches) {
    if (view === "court") {
      if (match.court) put(match.court.id, match.court.name, [match.court.sortOrder, match.court.name], match);
      else put("none", "场地待定", [Number.MAX_SAFE_INTEGER, ""], match);
    } else if (view === "time") {
      if (match.scheduledAt) {
        const day = utcToZonedLocal(match.scheduledAt, timeZone).slice(0, 10);
        put(day, dayLabel(day), [0, day], match);
      } else put("none", "时间待定", [1, ""], match);
    } else {
      put(match.competition.id, match.competition.name, [0, match.competition.code], match);
    }
  }
  return [...buckets.entries()]
    .sort(([, left], [, right]) => left.order[0] - right.order[0] || left.order[1].localeCompare(right.order[1], "zh-CN", { numeric: true }))
    .map(([key, bucket]) => summarize(key, bucket.title, bucket.matches.sort(view === "time" ? byTime : byStatusThenTime)));
}

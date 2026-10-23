/**
 * 延误统计（§8.10）：每场计划开始/结束与实际开始/结束的偏差，按场地汇总。只统计、不判错——
 * 判断延误提示是否命中，要在 C3 档、按 5 分钟阈值做（§5.4 陷阱一），这里先给出原始偏差。
 */
import type { TournamentData } from "./data";

function quantiles(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] * 10) / 10;
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), max: at(1), min: at(0) };
}

export function delayStats(data: TournamentData) {
  const minutes = (ms: number) => ms / 60_000;
  const played = data.matches.filter((match) => match.scheduledAt && match.startedAt);
  const startLag = played.map((match) => minutes(match.startedAt!.getTime() - match.scheduledAt!.getTime()));
  const endLag = played.filter((match) => match.endedAt && match.scheduledEndAt).map((match) => minutes(match.endedAt!.getTime() - match.scheduledEndAt!.getTime()));
  const duration = played.filter((match) => match.endedAt).map((match) => minutes(match.endedAt!.getTime() - match.startedAt!.getTime()));
  const byCourt: Record<string, ReturnType<typeof quantiles>> = {};
  for (const courtId of new Set(played.map((match) => match.courtId ?? "未排场地"))) {
    byCourt[courtId] = quantiles(played.filter((match) => (match.courtId ?? "未排场地") === courtId).map((match) => minutes(match.startedAt!.getTime() - match.scheduledAt!.getTime())));
  }
  return {
    note: "单位：分钟；正数=晚于计划。开始偏差为负表示提前开赛（允许，见 §5.3 情形 6）。",
    startLagMinutes: quantiles(startLag),
    endLagMinutes: quantiles(endLag),
    actualDurationMinutes: quantiles(duration),
    earlyStarts: startLag.filter((value) => value < 0).length,
    lateOverFiveMinutes: startLag.filter((value) => value > 5).length,
    byCourt,
  };
}

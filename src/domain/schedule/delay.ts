/**
 * 延误推算（纯函数）：已发布赛程 + 实际开始/结束 + 调用方传入的当前时刻 → 每场预计开始时间。
 *
 * 只沿「同一场地」「同一裁判」「同一名运动员」三条链往后推，前一场超时或迟迟未开始，后面的比赛顺延。
 * 结果只是提示，不会自动改动已发布的计划时间，也不会移动已经开始的比赛。
 */

import { MINUTE, type MatchScheduleStatus } from "./model";

export const DEFAULT_DELAY_THRESHOLD_MINUTES = 5;

export interface DelayItem {
  matchId: string;
  label: string;
  courtId: string | null;
  refereeId: string | null;
  persons: readonly string[];
  plannedStart: number;
  durationMinutes: number;
  status: MatchScheduleStatus;
  actualStart: number | null;
  actualEnd: number | null;
}

export type DelayCause = "COURT" | "REFEREE" | "PLAYER" | "LATE_START";

export interface DelayProjection {
  matchId: string;
  projectedStart: number;
  projectedEnd: number;
  delayMinutes: number;
  /** 尚未开始且预计开始比计划晚超过阈值。 */
  delayed: boolean;
  /**
   * 延误有现场事实为据：由一场已开始（进行中或已结束）的比赛超时或晚结束一路顺延而来。
   * 仅仅「过了计划时间还没开」不算（可能只是没人开赛，也可能是陈旧数据），公开赛程只展示有据的延误。
   */
  evidenced: boolean;
  /** 进行中且已超过预计时长。 */
  overrun: boolean;
  cause: DelayCause | null;
  causeMatchId: string | null;
  causeLabel: string | null;
}

export function projectDelays(
  items: readonly DelayItem[],
  now: number,
  options: { changeoverMinutes: number; thresholdMinutes?: number },
): Map<string, DelayProjection> {
  const threshold = (options.thresholdMinutes ?? DEFAULT_DELAY_THRESHOLD_MINUTES) * MINUTE;
  const changeover = options.changeoverMinutes * MINUTE;
  const ordered = [...items]
    .filter((item) => item.status !== "NOT_PLAYED")
    .sort((left, right) => left.plannedStart - right.plannedStart || left.matchId.localeCompare(right.matchId));

  const lastOnCourt = new Map<string, { end: number; item: DelayItem }>();
  const lastOnReferee = new Map<string, { end: number; item: DelayItem }>();
  const lastForPerson = new Map<string, { end: number; item: DelayItem }>();
  const result = new Map<string, DelayProjection>();

  for (const item of ordered) {
    const duration = item.durationMinutes * MINUTE;
    let projectedStart: number;
    let projectedEnd: number;
    let cause: DelayCause | null = null;
    let causeItem: DelayItem | null = null;
    let overrun = false;

    if (item.status === "ENDED") {
      projectedStart = item.actualStart ?? item.plannedStart;
      projectedEnd = item.actualEnd ?? projectedStart + duration;
    } else if (item.status === "IN_PROGRESS") {
      projectedStart = item.actualStart ?? item.plannedStart;
      const expectedEnd = projectedStart + duration;
      overrun = now > expectedEnd;
      projectedEnd = Math.max(expectedEnd, now);
    } else {
      projectedStart = item.plannedStart;
      const consider = (previous: { end: number; item: DelayItem } | undefined, why: DelayCause, gap: number) => {
        if (!previous) return;
        const earliest = previous.end + gap;
        if (earliest > projectedStart) {
          projectedStart = earliest;
          cause = why;
          causeItem = previous.item;
        }
      };
      if (item.courtId) consider(lastOnCourt.get(item.courtId), "COURT", changeover);
      if (item.refereeId) consider(lastOnReferee.get(item.refereeId), "REFEREE", 0);
      for (const person of item.persons) consider(lastForPerson.get(person), "PLAYER", 0);
      if (now > projectedStart) {
        projectedStart = now;
        cause = cause ?? "LATE_START";
      }
      projectedEnd = projectedStart + duration;
    }

    const delay = projectedStart - item.plannedStart;
    const notStarted = item.status === "NOT_STARTED";
    const chosenCause = cause as DelayCause | null;
    const chosenItem = causeItem as DelayItem | null;
    const delayed = notStarted && delay > threshold;
    const causeProjection = chosenItem ? result.get(chosenItem.matchId) : undefined;
    const evidenced =
      delayed &&
      chosenCause !== null &&
      chosenCause !== "LATE_START" &&
      chosenItem !== null &&
      (chosenItem.status === "IN_PROGRESS" || chosenItem.status === "ENDED" || Boolean(causeProjection?.evidenced));
    result.set(item.matchId, {
      matchId: item.matchId,
      projectedStart,
      projectedEnd,
      delayMinutes: Math.max(0, Math.round(delay / MINUTE)),
      delayed,
      evidenced,
      overrun,
      cause: notStarted && delay > threshold ? chosenCause : null,
      causeMatchId: notStarted && delay > threshold ? chosenItem?.matchId ?? null : null,
      causeLabel: notStarted && delay > threshold ? chosenItem?.label ?? null : null,
    });

    const mark = { end: projectedEnd, item };
    if (item.courtId) lastOnCourt.set(item.courtId, mark);
    if (item.refereeId) lastOnReferee.set(item.refereeId, mark);
    for (const person of item.persons) lastForPerson.set(person, mark);
  }
  return result;
}

export function delayCauseText(projection: DelayProjection) {
  if (!projection.delayed) return null;
  switch (projection.cause) {
    case "COURT":
      return `同场地前一场 ${projection.causeLabel ?? ""} 尚未结束`;
    case "REFEREE":
      return `裁判的上一场 ${projection.causeLabel ?? ""} 尚未结束`;
    case "PLAYER":
      return `运动员的上一场 ${projection.causeLabel ?? ""} 尚未结束`;
    case "LATE_START":
      return "已过计划时间仍未开赛";
    default:
      return null;
  }
}

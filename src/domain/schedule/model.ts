/**
 * 赛程与裁判排班的纯规则共用模型。无 IO、无框架、不读当前时间（需要时由调用方传入）。
 *
 * 时间一律用 epoch 毫秒；赛事时区与「比赛日开放时段」的换算在服务端完成后再传进来。
 * 预计时长只是排程与推算延误的依据，不是保证时长。
 *
 * 休息间隔按 2026-09-25 用户决定不在系统内检查（由线下裁判控场），这里只处理硬冲突与需要确认的警告。
 */

export const MINUTE = 60_000;

export interface Interval {
  start: number;
  end: number;
}

export type MatchScheduleStatus = "NOT_STARTED" | "IN_PROGRESS" | "ENDED" | "NOT_PLAYED";

/**
 * 一场比赛与排程有关的事实。
 *
 * - `confirmed*`：已经确定会在这场比赛出场的报名单位/人员；
 * - `candidate*`：一侧尚未确定（待晋级）时的候选集合，只用于保守检查与「暂定」标记；
 * - 团体小场以队伍（报名单位）为占用单位；上场队员只在已提交出场名单后才进入人员集合，
 *   对方尚未公开的名单在解释里隐去姓名（`hiddenPersons`）。
 */
export interface ScheduleMatchFacts {
  id: string;
  code: string;
  label: string;
  competitionCode: string;
  /** 1 = 小组/循环阶段，2 = 淘汰阶段。 */
  stageOrder: number;
  kind: "GROUP" | "KNOCKOUT" | "THIRD_PLACE" | "STANDALONE";
  /** 同一项目同一小组的比赛共享同一个键；淘汰赛为 null。 */
  groupKey: string | null;
  fixtureId: string | null;
  fixtureRound: number;
  fixtureSequence: number;
  rubberOrder: number | null;
  isTeam: boolean;
  status: MatchScheduleStatus;
  actualStart: number | null;
  actualEnd: number | null;
  /** 必须先结束的比赛（淘汰来源对阵的全部比赛、小组名次来源小组的全部比赛）。 */
  predecessors: readonly string[];
  confirmedEntries: readonly string[];
  candidateEntries: readonly string[];
  confirmedPersons: readonly string[];
  candidatePersons: readonly string[];
  hiddenPersons: boolean;
}

/** 一场比赛在某个版本（草稿或已发布）里的安排。 */
export interface Placement {
  matchId: string;
  courtId: string | null;
  start: number | null;
  durationMinutes: number;
  refereeId: string | null;
  estimated: boolean;
}

export interface CourtFacts {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export interface RefereeFacts {
  id: string;
  name: string;
}

export function overlaps(left: Interval, right: Interval) {
  return left.start < right.end && right.start < left.end;
}

export function plannedInterval(placement: Placement | undefined): Interval | null {
  if (!placement || placement.start === null) return null;
  return { start: placement.start, end: placement.start + placement.durationMinutes * MINUTE };
}

/**
 * 检查冲突时一场比赛占用的时间：
 * - 未进行的小场不占用；
 * - 已结束且有实际起止的，用实际起止；
 * - 进行中的用实际开始 + 预计时长（超时属于延误推算，不当作排程冲突）；
 * - 其余用计划时间。
 */
export function occupiedInterval(match: ScheduleMatchFacts, placement: Placement | undefined): Interval | null {
  if (match.status === "NOT_PLAYED") return null;
  if (match.status === "ENDED" && match.actualStart !== null && match.actualEnd !== null && match.actualEnd > match.actualStart) {
    return { start: match.actualStart, end: match.actualEnd };
  }
  const planned = plannedInterval(placement);
  if (match.status === "IN_PROGRESS" && match.actualStart !== null) {
    const duration = (placement?.durationMinutes ?? 0) * MINUTE;
    return { start: match.actualStart, end: match.actualStart + Math.max(duration, MINUTE) };
  }
  return planned;
}

/** 前序比赛「结束」的时刻：已结束取实际结束，否则取占用区间的结束；没有安排返回 null。 */
export function effectiveEnd(match: ScheduleMatchFacts, placement: Placement | undefined): number | null {
  if (match.status === "ENDED" && match.actualEnd !== null) return match.actualEnd;
  return occupiedInterval(match, placement)?.end ?? null;
}

export function isMovable(match: ScheduleMatchFacts) {
  return match.status === "NOT_STARTED";
}

export function intersection(left: readonly string[], right: readonly string[]) {
  const set = new Set(left);
  return [...new Set(right.filter((item) => set.has(item)))];
}

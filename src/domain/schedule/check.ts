/**
 * 赛程冲突检查（纯函数）。
 *
 * 硬冲突（HARD）阻止发布，不能被确认放宽；警告（WARNING）需要发布者逐项看过并确认。
 * 对尚未确定的晋级来源只做保守的「暂定」检查，绝不承诺未知对阵没有冲突。
 */

import {
  effectiveEnd,
  intersection,
  isMovable,
  occupiedInterval,
  overlaps,
  plannedInterval,
  type CourtFacts,
  type Interval,
  type Placement,
  type RefereeFacts,
  type ScheduleMatchFacts,
} from "./model";

export type ScheduleIssueCode =
  | "COURT_OVERLAP"
  | "COURT_CLOSED"
  | "COURT_UNKNOWN"
  | "PERSON_OVERLAP"
  | "TEAM_OVERLAP"
  | "REFEREE_OVERLAP"
  | "REFEREE_NOT_ELIGIBLE"
  | "DEPENDENCY_ORDER"
  | "DEPENDENCY_UNSCHEDULED"
  | "TENTATIVE_OVERLAP"
  | "OUTSIDE_HOURS"
  | "NO_REFEREE"
  | "STARTED_MATCH_CHANGED";

export type ScheduleIssueSeverity = "HARD" | "WARNING";

export interface ScheduleIssue {
  /** 稳定键：同一问题在两次检查之间保持不变，用于发布时核对「确认过的警告」。 */
  key: string;
  code: ScheduleIssueCode;
  severity: ScheduleIssueSeverity;
  matchIds: string[];
  message: string;
}

export const ISSUE_TITLE: Record<ScheduleIssueCode, string> = {
  COURT_OVERLAP: "同一场地时间重叠",
  COURT_CLOSED: "场地已关闭",
  COURT_UNKNOWN: "场地不存在",
  PERSON_OVERLAP: "同一名运动员同时出场",
  TEAM_OVERLAP: "同一支队伍同时进行两场对抗",
  REFEREE_OVERLAP: "同一名裁判同时执裁",
  REFEREE_NOT_ELIGIBLE: "指派的人不是本赛事裁判员",
  DEPENDENCY_ORDER: "排在前序比赛结束之前",
  DEPENDENCY_UNSCHEDULED: "前序比赛尚未排定",
  TENTATIVE_OVERLAP: "暂定：晋级者可能冲突",
  OUTSIDE_HOURS: "超出比赛日开放时段",
  NO_REFEREE: "尚未指派裁判",
  STARTED_MATCH_CHANGED: "已开始的比赛不能再调整",
};

export interface ScheduleCheckInput {
  matches: readonly ScheduleMatchFacts[];
  placements: ReadonlyMap<string, Placement>;
  courts: readonly CourtFacts[];
  /** 本赛事持有裁判员角色的人。 */
  referees: readonly RefereeFacts[];
  /** 是否要求逐场指派主裁判；共用裁判账号模式不指派，也就不提示「尚未指派裁判」。缺省为要求。 */
  refereesRequired?: boolean;
  /** 比赛日开放时段；为空表示未设置，不做该项检查。 */
  windows: readonly Interval[];
  /** 人员/队伍 ID → 显示名，只用于解释文字。 */
  names: ReadonlyMap<string, string>;
  /** 只检查这些比赛涉及的问题；缺省检查全部。 */
  focus?: ReadonlySet<string>;
  /** 草稿里改动过、但在改动之后已经开始的比赛：草稿不能发布，只能放弃这些改动。 */
  lockedChanges?: readonly string[];
}

export interface ScheduleCheckResult {
  issues: ScheduleIssue[];
  hardCount: number;
  warningCount: number;
  scheduledCount: number;
  unscheduledCount: number;
  /** 至少有一侧待晋级确定、按候选集合保守检查的比赛。 */
  tentativeMatchIds: string[];
}

function pairKey(code: ScheduleIssueCode, ids: readonly string[], extra = "") {
  return `${code}:${[...ids].sort().join("+")}${extra ? `:${extra}` : ""}`;
}

function nameList(ids: readonly string[], names: ReadonlyMap<string, string>, limit = 4) {
  const labels = ids.map((id) => names.get(id) ?? "（未命名）");
  return labels.length > limit ? `${labels.slice(0, limit).join("、")} 等 ${labels.length} 人` : labels.join("、");
}

export function checkSchedule(input: ScheduleCheckInput): ScheduleCheckResult {
  const { matches, placements, names } = input;
  const byId = new Map(matches.map((match) => [match.id, match]));
  const courtById = new Map(input.courts.map((court) => [court.id, court]));
  const refereeIds = new Set(input.referees.map((referee) => referee.id));
  const refereeName = new Map(input.referees.map((referee) => [referee.id, referee.name]));
  const issues = new Map<string, ScheduleIssue>();
  const focus = input.focus;
  const inFocus = (...ids: string[]) => !focus || ids.some((id) => focus.has(id));

  const add = (issue: ScheduleIssue) => {
    if (!inFocus(...issue.matchIds)) return;
    if (!issues.has(issue.key)) issues.set(issue.key, issue);
  };

  for (const matchId of input.lockedChanges ?? []) {
    const match = byId.get(matchId);
    add({
      key: pairKey("STARTED_MATCH_CHANGED", [matchId]),
      code: "STARTED_MATCH_CHANGED",
      severity: "HARD",
      matchIds: [matchId],
      message: `${match?.label ?? "该比赛"} 已经开始，草稿里对它的时间、场地或裁判改动不能发布；请放弃这场的草稿改动（临时换裁判请由裁判长操作）。`,
    });
  }

  let scheduledCount = 0;
  let unscheduledCount = 0;
  const tentative = new Set<string>();
  const noReferee: string[] = [];

  // --- 单场检查 -------------------------------------------------------------
  for (const match of matches) {
    if (match.status === "NOT_PLAYED") continue;
    if (match.candidateEntries.length || match.candidatePersons.length) tentative.add(match.id);
    const placement = placements.get(match.id);
    const planned = plannedInterval(placement);
    if (!planned) {
      if (match.status === "NOT_STARTED") unscheduledCount += 1;
      continue;
    }
    scheduledCount += 1;
    if (!isMovable(match)) continue;

    if (placement?.courtId) {
      const court = courtById.get(placement.courtId);
      if (!court) {
        add({ key: pairKey("COURT_UNKNOWN", [match.id]), code: "COURT_UNKNOWN", severity: "HARD", matchIds: [match.id], message: `${match.label}：安排的场地不属于本赛事。` });
      } else if (!court.active) {
        add({
          key: pairKey("COURT_CLOSED", [match.id], court.id),
          code: "COURT_CLOSED",
          severity: "HARD",
          matchIds: [match.id],
          message: `${match.label}：${court.name} 已关闭，需要改到其他场地。`,
        });
      }
    }
    if (placement?.refereeId && !refereeIds.has(placement.refereeId)) {
      add({
        key: pairKey("REFEREE_NOT_ELIGIBLE", [match.id], placement.refereeId),
        code: "REFEREE_NOT_ELIGIBLE",
        severity: "HARD",
        matchIds: [match.id],
        message: `${match.label}：指派的人没有本赛事裁判员角色，不能执裁。`,
      });
    }
    if (!placement?.refereeId && input.refereesRequired !== false) noReferee.push(match.id);

    if (input.windows.length && !input.windows.some((window) => planned.start >= window.start && planned.end <= window.end)) {
      add({
        key: pairKey("OUTSIDE_HOURS", [match.id]),
        code: "OUTSIDE_HOURS",
        severity: "WARNING",
        matchIds: [match.id],
        message: `${match.label}：不在已设置的比赛日开放时段内（按预计时长推算）。`,
      });
    }

    // 依赖：前序比赛必须先结束。同一场比赛的同类问题合并成一条，列出最先的一场与总数。
    const unscheduled: ScheduleMatchFacts[] = [];
    const tooEarly: { match: ScheduleMatchFacts; end: number }[] = [];
    for (const predecessorId of match.predecessors) {
      const predecessor = byId.get(predecessorId);
      if (!predecessor || predecessor.status === "NOT_PLAYED") continue;
      const end = effectiveEnd(predecessor, placements.get(predecessorId));
      if (end === null) unscheduled.push(predecessor);
      else if (planned.start < end) tooEarly.push({ match: predecessor, end });
    }
    const more = (count: number) => (count > 1 ? ` 等 ${count} 场` : "");
    if (unscheduled.length) {
      const first = [...unscheduled].sort((left, right) => left.code.localeCompare(right.code))[0];
      add({
        key: pairKey("DEPENDENCY_UNSCHEDULED", [match.id]),
        code: "DEPENDENCY_UNSCHEDULED",
        severity: "HARD",
        matchIds: [match.id, ...unscheduled.map((item) => item.id)],
        message: `${match.label} 依赖 ${first.label}${more(unscheduled.length)}，这些比赛还没有排定时间，无法保证先后顺序。`,
      });
    }
    if (tooEarly.length) {
      const last = [...tooEarly].sort((left, right) => right.end - left.end)[0];
      add({
        key: pairKey("DEPENDENCY_ORDER", [match.id]),
        code: "DEPENDENCY_ORDER",
        severity: "HARD",
        matchIds: [match.id, ...tooEarly.map((item) => item.match.id)],
        message: `${match.label} 排在前序比赛 ${last.match.label}${more(tooEarly.length)} 预计结束之前；晋级者尚未产生就不能开赛。`,
      });
    }
  }

  if (noReferee.length) {
    add({
      key: pairKey("NO_REFEREE", noReferee),
      code: "NO_REFEREE",
      severity: "WARNING",
      matchIds: noReferee,
      message: `${noReferee.length} 场已排时间的比赛还没有指派主裁判；发布后这些比赛不会出现在任何裁判的「我的执裁」里。`,
    });
  }

  // --- 两两重叠检查（按开始时间扫描） -------------------------------------
  const timed = matches
    .map((match) => ({ match, interval: occupiedInterval(match, placements.get(match.id)), placement: placements.get(match.id) }))
    .filter((item): item is { match: ScheduleMatchFacts; interval: Interval; placement: Placement | undefined } => item.interval !== null)
    .sort((left, right) => left.interval.start - right.interval.start);

  const active: typeof timed = [];
  for (const current of timed) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].interval.end <= current.interval.start) active.splice(index, 1);
    }
    for (const other of active) {
      if (!overlaps(current.interval, other.interval)) continue;
      // 两场都已开始或结束属于既成事实，不再作为排程问题。
      if (!isMovable(current.match) && !isMovable(other.match)) continue;
      comparePair(current, other);
    }
    active.push(current);
  }

  function comparePair(
    left: { match: ScheduleMatchFacts; placement: Placement | undefined },
    right: { match: ScheduleMatchFacts; placement: Placement | undefined },
  ) {
    const ids = [left.match.id, right.match.id];
    const labels = `${left.match.label} 与 ${right.match.label}`;
    const leftCourt = left.placement?.courtId ?? null;
    const rightCourt = right.placement?.courtId ?? null;
    if (leftCourt && leftCourt === rightCourt) {
      const court = courtById.get(leftCourt);
      add({
        key: pairKey("COURT_OVERLAP", ids),
        code: "COURT_OVERLAP",
        severity: "HARD",
        matchIds: ids,
        message: `${labels} 在 ${court?.name ?? "同一场地"} 的时间重叠。`,
      });
    }
    const leftReferee = left.placement?.refereeId ?? null;
    if (leftReferee && leftReferee === (right.placement?.refereeId ?? null)) {
      add({
        key: pairKey("REFEREE_OVERLAP", ids, leftReferee),
        code: "REFEREE_OVERLAP",
        severity: "HARD",
        matchIds: ids,
        message: `${labels} 时间重叠，但都指派给了 ${refereeName.get(leftReferee) ?? "同一名裁判"}。`,
      });
    }

    const samePersons = intersection(left.match.confirmedPersons, right.match.confirmedPersons);
    if (samePersons.length) {
      const hidden = left.match.hiddenPersons || right.match.hiddenPersons;
      add({
        key: pairKey("PERSON_OVERLAP", ids),
        code: "PERSON_OVERLAP",
        severity: "HARD",
        matchIds: ids,
        message: hidden
          ? `${labels} 时间重叠，某队已提交的出场名单中有队员同时出场（名单尚未公开，不显示姓名）。`
          : `${labels} 时间重叠，${nameList(samePersons, names)} 同时出场。`,
      });
    }
    const sameFixture = left.match.fixtureId !== null && left.match.fixtureId === right.match.fixtureId;
    if (!sameFixture) {
      const sameTeams = left.match.isTeam && right.match.isTeam ? intersection(left.match.confirmedEntries, right.match.confirmedEntries) : [];
      if (sameTeams.length) {
        add({
          key: pairKey("TEAM_OVERLAP", ids),
          code: "TEAM_OVERLAP",
          severity: "HARD",
          matchIds: ids,
          message: `${labels} 时间重叠，${nameList(sameTeams, names)} 不能同时进行两场对抗。`,
        });
      }
    }
    // 待晋级候选者的暂定冲突只在不同项目之间提示：同一项目的签表里，每个名次/胜负者只流向唯一位置，
    // 同一人可能出现的后续比赛都受前序约束（另有依赖检查），两场未定对阵不会共用运动员（见 suggest.ts 文件头）。
    if (!samePersons.length && left.match.competitionCode !== right.match.competitionCode) {
      const leftAll = [...left.match.confirmedPersons, ...left.match.candidatePersons];
      const rightAll = [...right.match.confirmedPersons, ...right.match.candidatePersons];
      const personRisk = intersection(leftAll, rightAll);
      const leftEntries = [...left.match.confirmedEntries, ...left.match.candidateEntries];
      const rightEntries = [...right.match.confirmedEntries, ...right.match.candidateEntries];
      const entryRisk = sameFixture ? [] : intersection(leftEntries, rightEntries);
      const confirmedTeams = left.match.isTeam && right.match.isTeam ? intersection(left.match.confirmedEntries, right.match.confirmedEntries) : [];
      const risky = personRisk.length || entryRisk.filter((id) => !confirmedTeams.includes(id)).length;
      if (risky) {
        const who = entryRisk.length ? nameList(entryRisk, names) : "部分候选运动员";
        add({
          key: pairKey("TENTATIVE_OVERLAP", ids),
          code: "TENTATIVE_OVERLAP",
          severity: "WARNING",
          matchIds: ids,
          message: `${labels} 时间重叠；若 ${who} 晋级或出场则会冲突。该安排为暂定，晋级确定后须重新检查。`,
        });
      }
    }
  }

  const list = [...issues.values()].sort(
    (left, right) =>
      (left.severity === right.severity ? 0 : left.severity === "HARD" ? -1 : 1) || left.key.localeCompare(right.key),
  );
  return {
    issues: list,
    hardCount: list.filter((issue) => issue.severity === "HARD").length,
    warningCount: list.filter((issue) => issue.severity === "WARNING").length,
    scheduledCount,
    unscheduledCount,
    tentativeMatchIds: [...tentative],
  };
}

/** 警告摘要：发布时核对发布者确认的就是当前这一组警告，警告变化后必须重新确认。 */
export function warningDigest(issues: readonly ScheduleIssue[]) {
  return issues
    .filter((issue) => issue.severity === "WARNING")
    .map((issue) => issue.key)
    .sort()
    .join("|");
}

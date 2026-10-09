/**
 * 自动排程建议（纯函数、确定性）。
 *
 * 这是「可解释的建议」，不是全局最优：按 项目 → 阶段 → 轮次 → 小组 → 对阵顺序 逐个放进
 * 最早可行的场地与时间，排不下的比赛原样列出原因，由人工调整后再检查。
 *
 * 场地规则（2026-09-25 按用户的校园联赛实际做法）：
 * - 团体赛小组阶段一组固定一块场地，同组对抗在该场地上按轮次依次进行，每场对抗的小场按顺序连打
 *   （场地多于小组时各组分到多块场地，同组对抗在本组场地之间择早）；
 * - 团体赛淘汰阶段一场对抗同时占用若干块场地（默认 2 块），小场轮流分配到这些场地上；
 * - 个人项目每场比赛选最早空出的场地。
 *
 * 占用检查：场地、队伍/运动员、前序比赛结束时间、比赛日开放时段。
 * 待晋级的候选者只对**其他项目**保守占用（同一人兼报单打和双打）。同一项目内不必：每个小组名次、
 * 每个「某场胜者/负者」只流向签表上唯一一个位置，同一人可能出现的后续比赛都排在其前序之后，
 * 所以同项目两场未定对阵（如两场半决赛、决赛与三四名赛）不会共用运动员，可以同时进行。
 * 不检查休息间隔（由线下裁判控场）；相邻两场之间只留换场时间。
 */

import { MINUTE, overlaps, type Interval, type Placement, type ScheduleMatchFacts, occupiedInterval, effectiveEnd, isMovable } from "./model";

export interface SuggestConfig {
  matchMinutes: number;
  rubberMinutes: number;
  changeoverMinutes: number;
  knockoutTieCourts: number;
  /** 起始时刻取整的粒度（分钟）。 */
  stepMinutes?: number;
}

export interface SuggestInput {
  matches: readonly ScheduleMatchFacts[];
  /** 本次要（重新）排的比赛；其余比赛的现有安排视为已占用。 */
  scope: ReadonlySet<string>;
  /** 当前生效的安排（草稿优先，其次已发布）。 */
  current: ReadonlyMap<string, Placement>;
  /** 可用（未关闭）的场地，按场地顺序。 */
  courtIds: readonly string[];
  /** 可指派的裁判，按顺序。 */
  refereeIds: readonly string[];
  /** 比赛日开放时段，按时间排序。 */
  windows: readonly Interval[];
  notBefore: number;
  config: SuggestConfig;
}

export type UnplacedReason = "NO_COURT" | "NO_WINDOW" | "PREDECESSOR_UNSCHEDULED" | "DOES_NOT_FIT";

export const UNPLACED_TEXT: Record<UnplacedReason, string> = {
  NO_COURT: "没有可用（未关闭）的场地",
  NO_WINDOW: "没有设置比赛日开放时段",
  PREDECESSOR_UNSCHEDULED: "前序比赛尚未排定，无法确定最早开赛时间",
  DOES_NOT_FIT: "在已设置的比赛日开放时段内排不下",
};

export interface SuggestResult {
  placements: Placement[];
  unplaced: { matchId: string; reason: UnplacedReason }[];
}

interface Unit {
  key: string;
  matches: ScheduleMatchFacts[];
  isTeam: boolean;
  kind: ScheduleMatchFacts["kind"];
  groupKey: string | null;
  sort: (string | number)[];
}

class Busy {
  private readonly map = new Map<string, Interval[]>();
  add(key: string, interval: Interval) {
    const list = this.map.get(key) ?? [];
    list.push(interval);
    this.map.set(key, list);
  }
  /** 与 [start, end) 冲突的占用里最晚的结束时刻；没有冲突返回 null。 */
  conflictEnd(key: string, interval: Interval): number | null {
    let latest: number | null = null;
    for (const busy of this.map.get(key) ?? []) {
      if (overlaps(busy, interval)) latest = latest === null ? busy.end : Math.max(latest, busy.end);
    }
    return latest;
  }
}

function compareSort(left: (string | number)[], right: (string | number)[]) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }
  return 0;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items;
  return [...combinations(rest, size - 1).map((combo) => [first, ...combo]), ...combinations(rest, size)];
}

interface EntityClaim {
  key: string;
  competitionCode: string;
  /** 候选（待晋级）占用；同项目内不与其他占用冲突，见文件头说明。 */
  tentative: boolean;
}

function entityClaims(match: ScheduleMatchFacts): EntityClaim[] {
  const claim = (key: string, tentative: boolean) => ({ key, competitionCode: match.competitionCode, tentative });
  return [
    ...match.confirmedEntries.map((id) => claim(`E:${id}`, false)),
    ...match.candidateEntries.map((id) => claim(`E:${id}`, true)),
    ...match.confirmedPersons.map((id) => claim(`P:${id}`, false)),
    ...match.candidatePersons.map((id) => claim(`P:${id}`, true)),
  ];
}

/** 两处占用可能是同一人同时出场：跨项目一律算；同项目只有双方都已确定才算。 */
function claimsClash(left: Omit<EntityClaim, "key">, right: Omit<EntityClaim, "key">) {
  return left.competitionCode !== right.competitionCode || (!left.tentative && !right.tentative);
}

/** 一个排程单位（同一项目）的占用；同一键既有确定又有候选时按确定处理。 */
function unitClaims(matches: readonly ScheduleMatchFacts[]): EntityClaim[] {
  const byKey = new Map<string, EntityClaim>();
  for (const claim of matches.flatMap(entityClaims)) {
    const existing = byKey.get(claim.key);
    if (!existing || (existing.tentative && !claim.tentative)) byKey.set(claim.key, claim);
  }
  return [...byKey.values()];
}

class EntityBusy {
  private readonly map = new Map<string, (Interval & Omit<EntityClaim, "key">)[]>();
  add(claim: EntityClaim, interval: Interval) {
    const list = this.map.get(claim.key) ?? [];
    list.push({ ...interval, competitionCode: claim.competitionCode, tentative: claim.tentative });
    this.map.set(claim.key, list);
  }
  conflictEnd(claim: EntityClaim, interval: Interval): number | null {
    let latest: number | null = null;
    for (const busy of this.map.get(claim.key) ?? []) {
      if (overlaps(busy, interval) && claimsClash(busy, claim)) latest = latest === null ? busy.end : Math.max(latest, busy.end);
    }
    return latest;
  }
}

export function suggestSchedule(input: SuggestInput): SuggestResult {
  const step = (input.config.stepMinutes ?? 5) * MINUTE;
  const changeover = input.config.changeoverMinutes * MINUTE;
  const align = (value: number) => Math.ceil(value / step) * step;
  const byId = new Map(input.matches.map((match) => [match.id, match]));
  const windows = [...input.windows].sort((left, right) => left.start - right.start);

  const courtBusy = new Busy();
  const entityBusy = new EntityBusy();
  const refereeBusy = new Busy();
  const ends = new Map<string, number>();
  const placements = new Map<string, Placement>();

  // 不在本次范围、或已经开始/结束的比赛：现有安排视为占用。
  const movable = (match: ScheduleMatchFacts) => input.scope.has(match.id) && isMovable(match);
  for (const match of input.matches) {
    if (movable(match)) continue;
    const placement = input.current.get(match.id);
    const interval = occupiedInterval(match, placement);
    const end = effectiveEnd(match, placement);
    if (end !== null) ends.set(match.id, end);
    if (!interval) continue;
    const padded = { start: interval.start, end: interval.end + changeover };
    if (placement?.courtId) courtBusy.add(placement.courtId, padded);
    if (placement?.refereeId) refereeBusy.add(placement.refereeId, padded);
    for (const claim of unitClaims([match])) entityBusy.add(claim, padded);
  }

  // 组成排程单位：团体对抗整场一个单位，个人比赛一场一个单位。
  const units = new Map<string, Unit>();
  for (const match of input.matches) {
    if (!movable(match)) continue;
    const key = match.isTeam && match.fixtureId ? `F:${match.fixtureId}` : `M:${match.id}`;
    const unit = units.get(key) ?? {
      key,
      matches: [],
      isTeam: match.isTeam,
      kind: match.kind,
      groupKey: match.groupKey,
      sort: [match.competitionCode, match.stageOrder, match.fixtureRound, match.groupKey ?? "", match.fixtureSequence, match.code],
    };
    unit.matches.push(match);
    units.set(key, unit);
  }
  const orderedUnits = [...units.values()].sort((left, right) => compareSort(left.sort, right.sort));
  for (const unit of orderedUnits) unit.matches.sort((left, right) => (left.rubberOrder ?? 0) - (right.rubberOrder ?? 0));

  // 小组赛场地归属：小组数不少于场地数时一组一块场地（按首次出现的顺序轮流分配，多出的小组共用）；
  // 场地多于小组时把场地分给各组（如单循环 1 组 + 2 块场地，两块场地都用上），同组对抗在本组场地之间择早，
  // 每场对抗仍在一块场地上连打。
  const groupKeys: string[] = [];
  for (const unit of orderedUnits) {
    if (unit.isTeam && unit.groupKey && !groupKeys.includes(unit.groupKey)) groupKeys.push(unit.groupKey);
  }
  const groupCourts = new Map<string, string[]>();
  if (input.courtIds.length) {
    if (groupKeys.length >= input.courtIds.length) {
      groupKeys.forEach((key, index) => groupCourts.set(key, [input.courtIds[index % input.courtIds.length]]));
    } else {
      const base = Math.floor(input.courtIds.length / groupKeys.length);
      const extra = input.courtIds.length % groupKeys.length;
      let cursor = 0;
      groupKeys.forEach((key, index) => {
        const size = base + (index < extra ? 1 : 0);
        groupCourts.set(key, input.courtIds.slice(cursor, cursor + size));
        cursor += size;
      });
    }
  }

  const unplaced: SuggestResult["unplaced"] = [];
  const markUnplaced = (unit: Unit, reason: UnplacedReason) => {
    for (const match of unit.matches) unplaced.push({ matchId: match.id, reason });
  };

  for (const unit of orderedUnits) {
    if (!input.courtIds.length) {
      markUnplaced(unit, "NO_COURT");
      continue;
    }
    if (!windows.length) {
      markUnplaced(unit, "NO_WINDOW");
      continue;
    }
    // 前序比赛结束后才能开赛。
    let lower = input.notBefore;
    let missingPredecessor = false;
    for (const match of unit.matches) {
      for (const predecessorId of match.predecessors) {
        if (unit.matches.some((item) => item.id === predecessorId)) continue;
        const predecessor = byId.get(predecessorId);
        if (!predecessor || predecessor.status === "NOT_PLAYED") continue;
        const end = ends.get(predecessorId);
        if (end === undefined) missingPredecessor = true;
        else lower = Math.max(lower, end + changeover);
      }
    }
    if (missingPredecessor) {
      markUnplaced(unit, "PREDECESSOR_UNSCHEDULED");
      continue;
    }
    lower = align(lower);

    const duration = (unit.isTeam ? input.config.rubberMinutes : input.config.matchMinutes) * MINUTE;
    let courtOptions: string[][];
    if (unit.isTeam && unit.groupKey) {
      courtOptions = (groupCourts.get(unit.groupKey) ?? []).map((id) => [id]);
    } else if (unit.isTeam) {
      const size = Math.max(1, Math.min(input.config.knockoutTieCourts, input.courtIds.length, unit.matches.length));
      const combos = combinations(input.courtIds, size);
      courtOptions = combos.length <= 200 ? combos : [input.courtIds.slice(0, size)];
    } else {
      courtOptions = input.courtIds.map((id) => [id]);
    }

    let best: { start: number; courts: string[] } | null = null;
    for (const courts of courtOptions) {
      const start = earliestStart(unit, courts, lower, duration);
      if (start !== null && (!best || start < best.start)) best = { start, courts };
    }
    if (!best) {
      markUnplaced(unit, "DOES_NOT_FIT");
      continue;
    }
    commit(unit, best.courts, best.start, duration);
  }

  function layout(unit: Unit, courts: string[], start: number, duration: number) {
    const perCourt = new Map<string, number>();
    return unit.matches.map((match, index) => {
      const courtId = courts[index % courts.length];
      const position = perCourt.get(courtId) ?? 0;
      perCourt.set(courtId, position + 1);
      const begin = start + position * (duration + changeover);
      return { match, courtId, interval: { start: begin, end: begin + duration } };
    });
  }

  function earliestStart(unit: Unit, courts: string[], lower: number, duration: number): number | null {
    const entities = unitClaims(unit.matches);
    let candidate = lower;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const slots = layout(unit, courts, candidate, duration);
      const span = { start: candidate, end: Math.max(...slots.map((slot) => slot.interval.end)) };
      const window = windows.find((item) => item.end > candidate);
      if (!window) return null;
      if (candidate < window.start) {
        candidate = align(window.start);
        continue;
      }
      if (span.end > window.end) {
        const next = windows.find((item) => item.start > window.start);
        if (!next) return null;
        candidate = align(next.start);
        continue;
      }
      let pushTo: number | null = null;
      for (const slot of slots) {
        const blocked = courtBusy.conflictEnd(slot.courtId, slot.interval);
        if (blocked !== null) pushTo = Math.max(pushTo ?? 0, blocked);
      }
      for (const claim of entities) {
        const blocked = entityBusy.conflictEnd(claim, span);
        if (blocked !== null) pushTo = Math.max(pushTo ?? 0, blocked);
      }
      if (pushTo === null) return candidate;
      candidate = align(Math.max(pushTo, candidate + step));
    }
    return null;
  }

  function commit(unit: Unit, courts: string[], start: number, duration: number) {
    const slots = layout(unit, courts, start, duration);
    const spanEnd = Math.max(...slots.map((slot) => slot.interval.end));
    for (const slot of slots) {
      courtBusy.add(slot.courtId, { start: slot.interval.start, end: slot.interval.end + changeover });
      ends.set(slot.match.id, slot.interval.end);
      placements.set(slot.match.id, {
        matchId: slot.match.id,
        courtId: slot.courtId,
        start: slot.interval.start,
        durationMinutes: duration / MINUTE,
        refereeId: null,
        estimated: false,
      });
    }
    for (const claim of unitClaims(unit.matches)) {
      entityBusy.add(claim, { start, end: spanEnd + changeover });
    }
  }

  // 裁判：按时间顺序给每场挑一名空闲裁判，优先「本场地」的固定裁判，其次当前执裁最少的。
  const homeCourt = new Map<string, string>();
  input.refereeIds.forEach((refereeId, index) => {
    if (index < input.courtIds.length) homeCourt.set(refereeId, input.courtIds[index]);
  });
  const load = new Map<string, number>(input.refereeIds.map((id) => [id, 0]));
  const chronological = [...placements.values()].sort(
    (left, right) => (left.start as number) - (right.start as number) || left.matchId.localeCompare(right.matchId),
  );
  for (const placement of chronological) {
    const interval = { start: placement.start as number, end: (placement.start as number) + placement.durationMinutes * MINUTE };
    const candidates = input.refereeIds
      .filter((id) => refereeBusy.conflictEnd(id, interval) === null)
      .sort(
        (left, right) =>
          Number(homeCourt.get(right) === placement.courtId) - Number(homeCourt.get(left) === placement.courtId) ||
          (load.get(left) ?? 0) - (load.get(right) ?? 0) ||
          input.refereeIds.indexOf(left) - input.refereeIds.indexOf(right),
      );
    const chosen = candidates[0];
    if (!chosen) continue;
    placement.refereeId = chosen;
    load.set(chosen, (load.get(chosen) ?? 0) + 1);
    refereeBusy.add(chosen, { start: interval.start, end: interval.end + changeover });
  }

  // 「预计」：紧接同场地上一场之后开始的比赛，开赛时间取决于前一场何时结束。
  const byCourt = new Map<string, { start: number; end: number; matchId: string | null }[]>();
  for (const match of input.matches) {
    const placement = placements.get(match.id) ?? (movable(match) ? undefined : input.current.get(match.id));
    const interval = placement ? occupiedInterval(match, placement) : null;
    if (!placement?.courtId || !interval) continue;
    const list = byCourt.get(placement.courtId) ?? [];
    list.push({ ...interval, matchId: placements.has(match.id) ? match.id : null });
    byCourt.set(placement.courtId, list);
  }
  for (const list of byCourt.values()) {
    list.sort((left, right) => left.start - right.start);
    list.forEach((item, index) => {
      if (!item.matchId || index === 0) return;
      const previous = list[index - 1];
      const placement = placements.get(item.matchId) as Placement;
      placement.estimated = item.start - previous.end <= changeover;
    });
  }

  return {
    placements: [...placements.values()].sort((left, right) => left.matchId.localeCompare(right.matchId)),
    unplaced,
  };
}

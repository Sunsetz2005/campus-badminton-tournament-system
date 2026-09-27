import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { RUBBER_LABEL, type RubberKind } from "@/domain/registration/team-roster";
import { projectDelays, type DelayProjection } from "@/domain/schedule/delay";
import { MINUTE, type CourtFacts, type Interval, type MatchScheduleStatus, type Placement, type RefereeFacts, type ScheduleMatchFacts } from "@/domain/schedule/model";
import { zonedLocalToUtc } from "@/domain/time/zoned-time";

/**
 * 赛程事实的读取：把数据库里的比赛、对阵来源、名单、场地、裁判和草稿/已发布安排
 * 换成纯规则需要的形状。管理端工作台、裁判列表、队伍负责人页面和公开赛程共用这一份读取。
 */

type Client = Prisma.TransactionClient | typeof prisma;

export interface ScheduleConfigValue {
  matchMinutes: number;
  rubberMinutes: number;
  changeoverMinutes: number;
  knockoutTieCourts: number;
  lineupDeadlineMinutes: number;
}

/** 项目默认值：须由组织者按规程确认。预计时长不是保证时长。 */
export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfigValue = {
  matchMinutes: 30,
  rubberMinutes: 25,
  changeoverMinutes: 5,
  knockoutTieCourts: 2,
  lineupDeadlineMinutes: 30,
};

export async function loadScheduleConfig(client: Client, tournamentId: string): Promise<ScheduleConfigValue> {
  const row = await client.scheduleConfig.findUnique({ where: { tournamentId } });
  if (!row) return { ...DEFAULT_SCHEDULE_CONFIG };
  return {
    matchMinutes: row.matchMinutes,
    rubberMinutes: row.rubberMinutes,
    changeoverMinutes: row.changeoverMinutes,
    knockoutTieCourts: row.knockoutTieCourts,
    lineupDeadlineMinutes: row.lineupDeadlineMinutes,
  };
}

export function minuteText(minute: number) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

/** 比赛日（赛事时区的日期 + 当天分钟）→ UTC 时段。日期或时区无效时返回 null，由调用方拒绝。 */
export function dayWindow(day: string, startMinute: number, endMinute: number, timeZone: string): Interval | null {
  const start = zonedLocalToUtc(`${day}T${minuteText(startMinute)}`, timeZone);
  let end: Date | null;
  if (endMinute >= 1440) {
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    end = zonedLocalToUtc(`${next.toISOString().slice(0, 10)}T00:00`, timeZone);
  } else {
    end = zonedLocalToUtc(`${day}T${minuteText(endMinute)}`, timeZone);
  }
  if (!start || !end || end <= start) return null;
  return { start: start.getTime(), end: end.getTime() };
}

const scheduleMatchSelect = {
  id: true,
  code: true,
  groupId: true,
  courtId: true,
  fixtureId: true,
  rubberKind: true,
  rubberOrder: true,
  notPlayedAt: true,
  lifecycleStatus: true,
  verificationStatus: true,
  version: true,
  scheduledAt: true,
  scheduledEndAt: true,
  scheduleEstimated: true,
  startedAt: true,
  endedAt: true,
  publishedAt: true,
  sideAEntryId: true,
  sideBEntryId: true,
  stage: {
    select: {
      code: true,
      name: true,
      order: true,
      competition: { select: { code: true, name: true, entryType: true } },
    },
  },
  group: { select: { code: true } },
  players: { select: { side: true, participantId: true } },
  officialAssignments: {
    where: { active: true, role: "MAIN_REFEREE" as const },
    orderBy: { createdAt: "asc" as const },
    select: { userId: true },
  },
  scheduleSlot: {
    select: { courtId: true, startsAt: true, durationMinutes: true, refereeUserId: true, estimated: true, updatedAt: true },
  },
} satisfies Prisma.MatchSelect;

export type ScheduleMatchRow = Prisma.MatchGetPayload<{ select: typeof scheduleMatchSelect }>;

const fixtureSelect = {
  id: true,
  code: true,
  label: true,
  kind: true,
  round: true,
  sequence: true,
  groupId: true,
  lineupsRevealedAt: true,
  sideASource: true,
  sideAEntryId: true,
  sideAGroupId: true,
  sideARank: true,
  sideAFixtureId: true,
  sideBSource: true,
  sideBEntryId: true,
  sideBGroupId: true,
  sideBRank: true,
  sideBFixtureId: true,
  sideAGroup: { select: { code: true } },
  sideBGroup: { select: { code: true } },
  sideAFixture: { select: { code: true, label: true } },
  sideBFixture: { select: { code: true, label: true } },
} satisfies Prisma.FixtureSelect;

type FixtureRow = Prisma.FixtureGetPayload<{ select: typeof fixtureSelect }>;

export function matchStatusOf(match: Pick<ScheduleMatchRow, "notPlayedAt" | "lifecycleStatus" | "version">): MatchScheduleStatus {
  if (match.notPlayedAt) return "NOT_PLAYED";
  if (match.lifecycleStatus === "ENDED_PENDING_SUBMISSION" || match.lifecycleStatus === "SUBMITTED") return "ENDED";
  if (match.lifecycleStatus === "IN_PROGRESS" || match.lifecycleStatus === "SUSPENDED" || match.version > 0) return "IN_PROGRESS";
  return "NOT_STARTED";
}

export function defaultDurationOf(match: Pick<ScheduleMatchRow, "rubberKind">, config: ScheduleConfigValue) {
  return match.rubberKind ? config.rubberMinutes : config.matchMinutes;
}

export function publishedPlacementOf(match: ScheduleMatchRow, config: ScheduleConfigValue): Placement {
  const start = match.scheduledAt?.getTime() ?? null;
  const end = match.scheduledEndAt?.getTime() ?? null;
  return {
    matchId: match.id,
    courtId: match.courtId,
    start,
    durationMinutes: start !== null && end !== null ? Math.round((end - start) / MINUTE) : defaultDurationOf(match, config),
    refereeId: match.officialAssignments[0]?.userId ?? null,
    estimated: start !== null && match.scheduleEstimated,
  };
}

export function draftPlacementOf(match: ScheduleMatchRow, config: ScheduleConfigValue): Placement {
  const slot = match.scheduleSlot;
  if (!slot) return publishedPlacementOf(match, config);
  return {
    matchId: match.id,
    courtId: slot.courtId,
    start: slot.startsAt?.getTime() ?? null,
    durationMinutes: slot.durationMinutes,
    refereeId: slot.refereeUserId,
    estimated: slot.estimated,
  };
}

export function samePlacement(left: Placement, right: Placement) {
  return (
    left.courtId === right.courtId &&
    left.start === right.start &&
    (left.start === null || left.durationMinutes === right.durationMinutes) &&
    left.refereeId === right.refereeId &&
    left.estimated === right.estimated
  );
}

export interface ScheduleFacts {
  timeZone: string;
  config: ScheduleConfigValue;
  rows: ScheduleMatchRow[];
  rowById: Map<string, ScheduleMatchRow>;
  facts: ScheduleMatchFacts[];
  factById: Map<string, ScheduleMatchFacts>;
  published: Map<string, Placement>;
  draft: Map<string, Placement>;
  courts: (CourtFacts & { sortOrder: number })[];
  referees: RefereeFacts[];
  days: { id: string; day: string; startMinute: number; endMinute: number }[];
  windows: Interval[];
  names: Map<string, string>;
  /** 每场比赛两侧的显示文字（未定一侧写来源，如「A 组第 1 名」）。 */
  sideLabels: Map<string, { A: string; B: string }>;
  fixtureById: Map<string, FixtureRow>;
}

export async function loadScheduleFacts(client: Client, tournamentId: string): Promise<ScheduleFacts> {
  const [tournament, config, rows, fixtures, entries, courts, refereeRoles, days] = await Promise.all([
    client.tournament.findUniqueOrThrow({ where: { id: tournamentId }, select: { timezone: true } }),
    loadScheduleConfig(client, tournamentId),
    client.match.findMany({ where: { stage: { competition: { tournamentId } } }, select: scheduleMatchSelect, orderBy: { code: "asc" } }),
    client.fixture.findMany({ where: { competition: { tournamentId } }, select: fixtureSelect }),
    client.entry.findMany({
      where: { competition: { tournamentId } },
      select: {
        id: true,
        code: true,
        displayName: true,
        entryType: true,
        members: { select: { participantId: true, participant: { select: { displayName: true } } } },
      },
    }),
    client.court.findMany({ where: { tournamentId }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }),
    client.roleAssignment.findMany({
      where: { tournamentId, role: "REFEREE", user: { status: "ACTIVE" } },
      select: { user: { select: { id: true, name: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    client.scheduleDay.findMany({ where: { tournamentId }, orderBy: { day: "asc" } }),
  ]);

  const names = new Map<string, string>();
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    names.set(entry.id, entry.displayName);
    for (const member of entry.members) names.set(member.participantId, member.participant.displayName);
  }

  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const groupEntries = new Map<string, Set<string>>();
  for (const fixture of fixtures) {
    if (!fixture.groupId) continue;
    const set = groupEntries.get(fixture.groupId) ?? new Set<string>();
    if (fixture.sideAEntryId) set.add(fixture.sideAEntryId);
    if (fixture.sideBEntryId) set.add(fixture.sideBEntryId);
    groupEntries.set(fixture.groupId, set);
  }
  const matchesByFixture = new Map<string, string[]>();
  const matchesByGroup = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.fixtureId) continue;
    matchesByFixture.set(row.fixtureId, [...(matchesByFixture.get(row.fixtureId) ?? []), row.id]);
    const groupId = fixtureById.get(row.fixtureId)?.groupId;
    if (groupId) matchesByGroup.set(groupId, [...(matchesByGroup.get(groupId) ?? []), row.id]);
  }

  // 一侧的报名单位：已确定直接取；未确定按来源展开候选集合（小组全部成员 / 前序对阵两侧的候选）。
  const sideMemo = new Map<string, { confirmed: string[]; candidates: string[] }>();
  function sideEntries(fixture: FixtureRow, side: "A" | "B", depth = 0): { confirmed: string[]; candidates: string[] } {
    const memoKey = `${fixture.id}:${side}`;
    const cached = sideMemo.get(memoKey);
    if (cached) return cached;
    const entryId = side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId;
    const source = side === "A" ? fixture.sideASource : fixture.sideBSource;
    let value: { confirmed: string[]; candidates: string[] };
    if (entryId) value = { confirmed: [entryId], candidates: [] };
    else if (source === "GROUP_RANK") {
      const groupId = side === "A" ? fixture.sideAGroupId : fixture.sideBGroupId;
      value = { confirmed: [], candidates: [...(groupId ? groupEntries.get(groupId) ?? [] : [])] };
    } else {
      const sourceId = side === "A" ? fixture.sideAFixtureId : fixture.sideBFixtureId;
      const upstream = sourceId ? fixtureById.get(sourceId) : undefined;
      if (!upstream || depth > 12) value = { confirmed: [], candidates: [] };
      else {
        const left = sideEntries(upstream, "A", depth + 1);
        const right = sideEntries(upstream, "B", depth + 1);
        value = { confirmed: [], candidates: [...new Set([...left.confirmed, ...left.candidates, ...right.confirmed, ...right.candidates])] };
      }
    }
    sideMemo.set(memoKey, value);
    return value;
  }

  function sourceText(fixture: FixtureRow, side: "A" | "B") {
    const source = side === "A" ? fixture.sideASource : fixture.sideBSource;
    if (source === "GROUP_RANK") {
      const group = side === "A" ? fixture.sideAGroup : fixture.sideBGroup;
      const rank = side === "A" ? fixture.sideARank : fixture.sideBRank;
      return `${group?.code ?? "?"} 组第 ${rank ?? "?"} 名`;
    }
    const upstream = side === "A" ? fixture.sideAFixture : fixture.sideBFixture;
    return `${upstream?.label ?? upstream?.code ?? "前序对阵"}${source === "FIXTURE_LOSER" ? "负者" : "胜者"}`;
  }

  const sideLabels = new Map<string, { A: string; B: string }>();
  const facts: ScheduleMatchFacts[] = rows.map((row) => {
    const fixture = row.fixtureId ? fixtureById.get(row.fixtureId) : undefined;
    const isTeam = row.stage.competition.entryType === "TEAM";
    const sides = (["A", "B"] as const).map((side) => {
      const entryId = side === "A" ? row.sideAEntryId : row.sideBEntryId;
      if (entryId) return { confirmed: [entryId], candidates: [] as string[] };
      return fixture ? sideEntries(fixture, side) : { confirmed: [] as string[], candidates: [] as string[] };
    });
    const label = (side: "A" | "B") => {
      const entryId = side === "A" ? row.sideAEntryId : row.sideBEntryId;
      if (entryId) return names.get(entryId) ?? "（未命名）";
      return fixture ? sourceText(fixture, side) : "待定";
    };
    sideLabels.set(row.id, { A: label("A"), B: label("B") });

    const confirmedEntries = sides.flatMap((side) => side.confirmed);
    const candidateEntries = [...new Set(sides.flatMap((side) => side.candidates))].filter((id) => !confirmedEntries.includes(id));
    const membersOf = (ids: readonly string[]) => ids.flatMap((id) => entryById.get(id)?.members.map((member) => member.participantId) ?? []);
    const confirmedPersons = isTeam ? row.players.map((player) => player.participantId) : membersOf(confirmedEntries);
    const candidatePersons = isTeam ? [] : membersOf(candidateEntries).filter((id) => !confirmedPersons.includes(id));

    const predecessors = new Set<string>();
    if (fixture) {
      for (const side of ["A", "B"] as const) {
        const source = side === "A" ? fixture.sideASource : fixture.sideBSource;
        if (source === "GROUP_RANK") {
          const groupId = side === "A" ? fixture.sideAGroupId : fixture.sideBGroupId;
          for (const id of groupId ? matchesByGroup.get(groupId) ?? [] : []) predecessors.add(id);
        } else if (source === "FIXTURE_WINNER" || source === "FIXTURE_LOSER") {
          const sourceId = side === "A" ? fixture.sideAFixtureId : fixture.sideBFixtureId;
          for (const id of sourceId ? matchesByFixture.get(sourceId) ?? [] : []) predecessors.add(id);
        }
      }
    }
    const rubber = row.rubberKind && row.rubberOrder ? ` · 第 ${row.rubberOrder} 场${RUBBER_LABEL[row.rubberKind as RubberKind] ?? row.rubberKind}` : "";
    const where = fixture?.label ?? (row.group ? `${row.stage.name} ${row.group.code} 组` : row.stage.name);

    return {
      id: row.id,
      code: row.code,
      label: `${row.stage.competition.code} ${where} ${label("A")} vs ${label("B")}${rubber}`,
      competitionCode: row.stage.competition.code,
      stageOrder: row.stage.order,
      kind: fixture?.kind ?? "STANDALONE",
      groupKey: fixture?.groupId ? `${row.stage.competition.code}:${fixture.groupId}` : null,
      fixtureId: row.fixtureId,
      fixtureRound: fixture?.round ?? 0,
      fixtureSequence: fixture?.sequence ?? 0,
      rubberOrder: row.rubberOrder,
      isTeam,
      status: matchStatusOf(row),
      actualStart: row.startedAt?.getTime() ?? null,
      actualEnd: row.endedAt?.getTime() ?? null,
      predecessors: [...predecessors].filter((id) => id !== row.id),
      confirmedEntries,
      candidateEntries,
      confirmedPersons,
      candidatePersons,
      hiddenPersons: isTeam && row.players.length > 0 && !fixture?.lineupsRevealedAt,
    };
  });

  const published = new Map(rows.map((row) => [row.id, publishedPlacementOf(row, config)]));
  const draft = new Map(rows.map((row) => [row.id, draftPlacementOf(row, config)]));
  const dayRows = days.map((day) => ({
    id: day.id,
    day: day.day.toISOString().slice(0, 10),
    startMinute: day.startMinute,
    endMinute: day.endMinute,
  }));
  const windows = dayRows
    .map((day) => dayWindow(day.day, day.startMinute, day.endMinute, tournament.timezone))
    .filter((window): window is Interval => window !== null);

  return {
    timeZone: tournament.timezone,
    config,
    rows,
    rowById: new Map(rows.map((row) => [row.id, row])),
    facts,
    factById: new Map(facts.map((fact) => [fact.id, fact])),
    published,
    draft,
    courts: courts.map((court) => ({ id: court.id, code: court.code, name: court.name, active: court.active, sortOrder: court.sortOrder })),
    referees: refereeRoles.map((item) => ({ id: item.user.id, name: item.user.name })),
    days: dayRows,
    windows,
    names,
    sideLabels,
    fixtureById,
  };
}

// ---------------------------------------------------------------------------
// 已发布赛程的延误推算（管理端看板、裁判列表、公开赛程共用）
// ---------------------------------------------------------------------------

/**
 * 按已发布安排与实际开始/结束推算延误。只读取推算需要的列，不涉及任何姓名。
 * `now` 由调用方传入服务器时间，推算结果只是提示，不改动计划时间。
 */
export async function loadPublishedDelays(client: Client, tournamentId: string, now: Date): Promise<Map<string, DelayProjection>> {
  const [config, rows] = await Promise.all([
    loadScheduleConfig(client, tournamentId),
    client.match.findMany({
      where: { stage: { competition: { tournamentId } }, scheduledAt: { not: null } },
      select: {
        id: true,
        code: true,
        courtId: true,
        rubberKind: true,
        notPlayedAt: true,
        lifecycleStatus: true,
        version: true,
        scheduledAt: true,
        scheduledEndAt: true,
        startedAt: true,
        endedAt: true,
        sideAEntryId: true,
        sideBEntryId: true,
        players: { select: { participantId: true } },
        sideAEntry: { select: { entryType: true, members: { select: { participantId: true } } } },
        sideBEntry: { select: { entryType: true, members: { select: { participantId: true } } } },
        officialAssignments: { where: { active: true, role: "MAIN_REFEREE" }, select: { userId: true }, take: 1 },
      },
    }),
  ]);
  const persons = (row: (typeof rows)[number]) => {
    if (row.rubberKind) return row.players.map((player) => player.participantId);
    return [...(row.sideAEntry?.members ?? []), ...(row.sideBEntry?.members ?? [])].map((member) => member.participantId);
  };
  return projectDelays(
    rows.map((row) => {
      const start = (row.scheduledAt as Date).getTime();
      const end = row.scheduledEndAt?.getTime() ?? null;
      return {
        matchId: row.id,
        label: row.code,
        courtId: row.courtId,
        refereeId: row.officialAssignments[0]?.userId ?? null,
        persons: persons(row),
        plannedStart: start,
        durationMinutes: end !== null ? Math.round((end - start) / MINUTE) : row.rubberKind ? config.rubberMinutes : config.matchMinutes,
        status: matchStatusOf(row),
        actualStart: row.startedAt?.getTime() ?? null,
        actualEnd: row.endedAt?.getTime() ?? null,
      };
    }),
    now.getTime(),
    { changeoverMinutes: config.changeoverMinutes },
  );
}

// ---------------------------------------------------------------------------
// 团体对抗出场名单与赛程的联动
// ---------------------------------------------------------------------------

export interface FixtureScheduleFacts {
  /** 该对抗第一个小场的计划开始（已发布）。 */
  firstStart: Date | null;
  /** 出场名单截止时刻；未排赛程时为 null（不设截止）。 */
  deadline: Date | null;
  deadlineMinutes: number;
  /** 计划时间重叠的小场序号对（淘汰赛多块场地同时打）。 */
  overlappingOrders: [number, number][];
}

export async function loadFixtureScheduleFacts(client: Client, tournamentId: string, fixtureId: string): Promise<FixtureScheduleFacts> {
  const [config, matches] = await Promise.all([
    loadScheduleConfig(client, tournamentId),
    client.match.findMany({
      where: { fixtureId, notPlayedAt: null },
      select: { rubberKind: true, rubberOrder: true, scheduledAt: true, scheduledEndAt: true },
      orderBy: { rubberOrder: "asc" },
    }),
  ]);
  const timed = matches
    .filter((match) => match.scheduledAt && match.rubberOrder)
    .map((match) => {
      const start = (match.scheduledAt as Date).getTime();
      const end = match.scheduledEndAt?.getTime() ?? start + (match.rubberKind ? config.rubberMinutes : config.matchMinutes) * MINUTE;
      return { order: match.rubberOrder as number, start, end };
    });
  const overlappingOrders: [number, number][] = [];
  for (let left = 0; left < timed.length; left += 1) {
    for (let right = left + 1; right < timed.length; right += 1) {
      if (timed[left].start < timed[right].end && timed[right].start < timed[left].end) {
        overlappingOrders.push([timed[left].order, timed[right].order]);
      }
    }
  }
  const firstStart = timed.length ? new Date(Math.min(...timed.map((item) => item.start))) : null;
  return {
    firstStart,
    deadline: firstStart ? new Date(firstStart.getTime() - config.lineupDeadlineMinutes * MINUTE) : null,
    deadlineMinutes: config.lineupDeadlineMinutes,
    overlappingOrders,
  };
}

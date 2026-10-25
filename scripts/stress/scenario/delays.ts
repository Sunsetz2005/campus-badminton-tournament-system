/**
 * 延误七情形（§5.3）。赛程发布后挑选目标比赛并注入「强制长局」/「复核延后」，运行中采样系统给出的延误推算与公开显示，
 * 结束后按情形汇总「期望 / 实际」。只记录事实与对照，不判 bug——延误语义只在 C3 档下解读（§5.4 陷阱一）。
 *
 *   D1 同场地上一场超时        某块场地第 4 场强制长局 → 同场地后续场次 cause=COURT、公开赛程只在有据时显示
 *   D2 场地空着但选手在别场    兼项选手两场相邻、前一场强制长局 → 后一场 cause=PLAYER，场地空等
 *   D3 淘汰下一轮等两场上游    一场半决赛强制长局 + 复核延后 → 决赛在两场都锁定前不能开赛，记录结束→锁定→开赛
 *   D4 团体某小场拖很久        小组对抗第 3 小场强制长局 → 同对抗后续小场、该队下一轮顺延；是否出现 TEAM_OVERLAP
 *   D5 延误累积到当天最后一场  前两轮全部强制长局；发布后把第 1 天开放时段收到计划最后结束 + 5 分钟 → 观察实际超出时段的表现
 *   D6 提前结束、场地提前空出  运行中把一场后面的小组赛改到当前空闲的场地并重新发布；再尝试改一场已开始的比赛
 *   D7 团体延误与名单截止      团体半决赛的复核延后到决赛名单截止（按计划时间）之后 → 决赛对阵确定时截止已过，负责人提交被拒、管理员代交
 */
import { loadPublishedDelays } from "../../../src/server/services/schedule-facts";
import { loadScheduleWorkspace } from "../../../src/server/services/schedule-service";
import { sleep } from "../core/clock";
import { Client } from "../core/http";
import { fixturesOf, matchesOfTournament, playersOfMatches, prisma } from "../core/db";
import { localDate, localDateTime } from "../core/time";
import type { LiveRegistry } from "../live/venue";
import type { RunContext, TournamentRuntime } from "./context";
import { addFinding } from "./context";

export type DelayScenarioId = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7";

export interface DelayScenario {
  id: DelayScenarioId;
  title: string;
  constructed: boolean;
  /** 注入点（被强制拉长、被延后复核的比赛）。 */
  causes: string[];
  /** 需要观察延误表现的比赛。 */
  watch: string[];
  expected: string;
  note?: string;
  action?: Record<string, unknown>;
  observed?: Record<string, unknown>;
}

/** 运行中逐场累计的延误观察：系统推算（与裁判「我的执裁」、排班页同源）与公开赛程的显示。 */
export interface DelayObservation {
  firstDelayedAt: number | null;
  maxDelayMinutes: number;
  causes: string[];
  evidenced: boolean;
  shownDelayedPublic: boolean;
  overrunSeen: boolean;
}

type MatchRow = Awaited<ReturnType<typeof matchesOfTournament>>[number];

const TITLES: Record<DelayScenarioId, string> = {
  D1: "同场地上一场超时",
  D2: "场地空着但选手在别场",
  D3: "淘汰下一轮等两场上游，一场拖后",
  D4: "团体某小场拖很久",
  D5: "延误累积到当天最后一场",
  D6: "提前结束、场地提前空出",
  D7: "团体延误与名单截止",
};

function scenario(id: DelayScenarioId, expected: string, extra: Partial<DelayScenario> = {}): DelayScenario {
  return { id, title: TITLES[id], constructed: false, causes: [], watch: [], expected, ...extra };
}

const time = (value: Date | null) => value?.getTime() ?? Number.MAX_SAFE_INTEGER;

export async function planDelayScenarios(context: RunContext, tournament: TournamentRuntime) {
  const matches = (await matchesOfTournament(tournament.id)).filter((match) => match.scheduledAt && !match.notPlayedAt);
  const slotMs = (context.clock.profile.matchMinutes + context.clock.profile.changeoverMinutes) * 60_000;
  const firstStart = Math.min(...matches.map((match) => time(match.scheduledAt)));
  const long = (match: MatchRow, why: string) => {
    if (tournament.forced.has(match.code)) return false;
    tournament.forced.set(match.code, { kind: "LONG", why });
    return true;
  };
  const free = (match: MatchRow) => !tournament.forced.has(match.code);
  const list: DelayScenario[] = [];

  // D5：前两轮（计划开始早于首场 + 2 个时段）全部强制长局。
  const d5 = scenario("D5", "各轮计划/实际偏差逐轮放大；实际结束超出比赛日开放时段时系统的表现＝设计未定义（预计无任何提示，只有 OUTSIDE_HOURS 针对计划时间）");
  for (const match of matches.filter((item) => time(item.scheduledAt) < firstStart + 2 * slotMs)) if (long(match, "D5 前两轮系统性超时")) d5.causes.push(match.code);
  d5.constructed = d5.causes.length > 0;
  list.push(d5);

  const individual = matches.filter((match) => !match.rubberKind);
  const byCourt = new Map<string, MatchRow[]>();
  for (const match of individual) if (match.courtId) byCourt.set(match.courtId, [...(byCourt.get(match.courtId) ?? []), match]);
  for (const rows of byCourt.values()) rows.sort((x, y) => time(x.scheduledAt) - time(y.scheduledAt));

  // D1：个人比赛最多的场地，第 4 场强制长局，观察同场地后 3 场。
  const d1 = scenario("D1", "同场地后续场次 delayed、cause=COURT；公开赛程只在有据（前一场已开始且超时）时显示延误");
  const court = [...byCourt.entries()].sort((x, y) => y[1].length - x[1].length)[0];
  if (court) {
    const rows = court[1];
    const target = rows.slice(3).find(free);
    if (target && long(target, "D1 同场地超时")) {
      d1.causes.push(target.code);
      d1.watch = rows.filter((row) => time(row.scheduledAt) > time(target.scheduledAt)).slice(0, 3).map((row) => row.code);
      d1.constructed = d1.watch.length > 0;
    }
  }
  if (!d1.constructed) d1.note = "没有一块场地排了 4 场以上的个人比赛";
  list.push(d1);

  // D2：兼项选手的两场相邻比赛（不同场地），前一场强制长局。
  const d2 = scenario("D2", "后一场 cause=PLAYER；守纪律的现场让场地空等（违规开赛是否被阻止留到 M5 违规模式）");
  const players = await playersOfMatches(individual.map((match) => match.code));
  let best: { first: MatchRow; second: MatchRow; gap: number } | null = null;
  const byPerson = new Map<string, MatchRow[]>();
  for (const match of individual) for (const person of players.get(match.code) ?? []) byPerson.set(person, [...(byPerson.get(person) ?? []), match]);
  for (const rows of byPerson.values()) {
    rows.sort((x, y) => time(x.scheduledAt) - time(y.scheduledAt));
    for (let index = 0; index + 1 < rows.length; index += 1) {
      const [first, second] = [rows[index], rows[index + 1]];
      if (first.courtId === second.courtId || !free(first) || !free(second)) continue;
      if (time(first.scheduledAt) < firstStart + 2 * slotMs) continue; // 避开 D5 的前两轮
      const gap = time(second.scheduledAt) - time(first.scheduledEndAt);
      if (gap >= 0 && gap <= 2 * slotMs && (!best || gap < best.gap)) best = { first, second, gap };
    }
  }
  if (best && long(best.first, "D2 兼项选手前一场超时")) {
    d2.causes.push(best.first.code);
    d2.watch.push(best.second.code);
    d2.constructed = true;
    d2.note = `两场计划间隔 ${Math.round(best.gap / 60_000)} 分钟`;
  } else d2.note = "没有找到不同场地、计划相邻的兼项比赛";
  list.push(d2);

  // D3：个人淘汰赛的一场半决赛强制长局，并让裁判长延后复核。
  const d3 = scenario("D3", "决赛在两场半决赛都锁定前对阵不完整、不能开赛；记录「结束→锁定→回填→开赛」各段耗时");
  const knockout = individual.filter((match) => match.fixture?.kind === "KNOCKOUT" && match.fixture.code.startsWith("SF"));
  const semis = new Map<string, MatchRow[]>();
  for (const match of knockout) semis.set(match.stage.competition.code, [...(semis.get(match.stage.competition.code) ?? []), match]);
  const event = [...semis.entries()].find(([, rows]) => rows.length >= 2 && rows.every(free));
  if (event) {
    const [code, rows] = event;
    const target = rows.sort((x, y) => x.code.localeCompare(y.code))[0];
    long(target, "D3 半决赛拖后");
    tournament.reviewHolds.set(target.code, 20 * 60); // 现实 20 分钟，按压缩档折算
    d3.causes.push(target.code);
    d3.watch = individual.filter((match) => match.stage.competition.code === code && (match.fixture?.code === "F" || match.fixture?.code === "3P")).map((match) => match.code);
    d3.action = { otherSemi: rows.filter((row) => row !== target).map((row) => row.code), reviewHoldRealSeconds: 20 * 60 };
    d3.constructed = true;
  } else d3.note = "没有带两场半决赛的个人淘汰赛";
  list.push(d3);

  // D4：团体小组对抗第 3 小场强制长局（避开强制同分的小组）。
  const d4 = scenario("D4", "同对抗后续小场、该队下一轮对抗顺延；记录是否出现 TEAM_OVERLAP");
  const team = tournament.plan.team;
  if (team && team.rubbers.length >= 3) {
    const tiedGroups = new Set(tournament.tieScenarios.filter((item) => item.id === "T3").map((item) => item.group));
    const competition = tournament.competitions.get(team.code)!;
    const fixtures = await fixturesOf(competition.id);
    const groupCodes = new Map((await prisma.group.findMany({ where: { stage: { competitionId: competition.id } }, select: { id: true, code: true } })).map((group) => [group.id, group.code]));
    const fixture = fixtures.find((item) => item.groupId && !tiedGroups.has(groupCodes.get(item.groupId) ?? "") && item.matches.length >= 3 && item.matches.every((rubber) => free(matches.find((match) => match.code === rubber.code) ?? ({ code: rubber.code } as MatchRow))));
    const third = fixture?.matches.find((rubber) => rubber.rubberOrder === 3);
    const thirdRow = third && matches.find((match) => match.code === third.code);
    if (fixture && thirdRow && long(thirdRow, "D4 团体第 3 小场拖长")) {
      d4.causes.push(thirdRow.code);
      const sides = [fixture.sideAEntryId, fixture.sideBEntryId];
      const later = fixtures
        .filter((item) => item.id !== fixture.id && (sides.includes(item.sideAEntryId) || sides.includes(item.sideBEntryId)))
        .filter((item) => time(item.matches[0]?.scheduledAt ?? null) > time(thirdRow.scheduledAt))
        .sort((x, y) => time(x.matches[0]?.scheduledAt ?? null) - time(y.matches[0]?.scheduledAt ?? null))[0];
      d4.watch = [...fixture.matches.filter((rubber) => (rubber.rubberOrder ?? 0) > 3).map((rubber) => rubber.code), ...(later?.matches.map((rubber) => rubber.code) ?? [])];
      d4.action = { fixture: fixture.code, nextFixture: later?.code ?? null };
      d4.constructed = true;
    } else d4.note = "没有可用的团体小组对抗";
  } else d4.note = "本赛事没有至少 3 个小场的团体项目";
  list.push(d4);

  list.push(scenario("D6", "允许提前开赛；改到空场需重新发布赛程版本，版本差异记录移动；已开始的比赛不能再改（拒绝）"));
  // D7：团体半决赛（SF1）各小场的复核延后到决赛名单截止过去 1 分钟——裁判长被耽搁、决赛对阵迟迟确定不了。
  const d7 = scenario("D7", "截止按计划时间计算、不随延误顺延：负责人提交得 409 lineup_deadline_passed，只能管理员代交并标逾期；是否应顺延＝设计未定义");
  if (team) {
    const competition = tournament.competitions.get(team.code)!;
    const fixtures = await fixturesOf(competition.id);
    const semi = fixtures.find((item) => item.code === "SF1");
    const final = fixtures.find((item) => item.code === "F");
    const finalStart = final?.matches.map((rubber) => rubber.scheduledAt?.getTime() ?? Infinity).sort((a, b) => a - b)[0];
    if (semi && final && finalStart && Number.isFinite(finalStart)) {
      const deadline = finalStart - context.clock.profile.lineupDeadlineMinutes * 60_000;
      const until = deadline + 60_000;
      for (const rubber of semi.matches) {
        tournament.reviewHoldUntil.set(rubber.code, until);
        d7.causes.push(rubber.code);
      }
      d7.watch = final.matches.map((rubber) => rubber.code);
      d7.action = { semi: semi.code, final: final.code, finalFirstRubberPlanned: new Date(finalStart).toISOString(), lineupDeadline: new Date(deadline).toISOString(), reviewHeldUntil: new Date(until).toISOString() };
      d7.constructed = true;
    } else d7.note = "团体项目没有半决赛 SF1 与决赛 F";
  } else d7.note = "本赛事没有团体项目";
  list.push(d7);

  tournament.delayScenarios = list;
  for (const item of list) context.log(`延误情形 ${item.id} ${item.title}：${item.constructed ? `注入 ${item.causes.length} 场，观察 ${item.watch.length} 场` : item.note ?? "运行中构造"}`);
  return list;
}

/** D5：把第 1 天开放时段收到「计划最后结束 + 5 分钟」，让累积延误必然超出时段。只影响提示，不移动已排比赛。 */
export async function narrowFirstDay(context: RunContext, tournament: TournamentRuntime, startsAt: Date) {
  const d5 = tournament.delayScenarios.find((item) => item.id === "D5");
  if (!d5) return;
  const matches = (await matchesOfTournament(tournament.id)).filter((match) => match.scheduledEndAt);
  const lastEnd = new Date(Math.max(...matches.map((match) => match.scheduledEndAt!.getTime())));
  const closeAt = new Date(Math.ceil((lastEnd.getTime() + 5 * 60_000) / 300_000) * 300_000);
  if (localDate(closeAt) !== localDate(startsAt)) {
    d5.note = `${d5.note ?? ""}计划最后结束跨过午夜，未收窄开放时段`.trim();
    return;
  }
  const nextDay = new Date(startsAt.getTime() + 24 * 3600_000);
  const result = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/schedule/days`, {
    days: [
      { date: localDate(startsAt), start: localDateTime(startsAt).slice(11), end: localDateTime(closeAt).slice(11) },
      { date: localDate(nextDay), start: "00:00", end: "24:00" },
    ],
  }, { route: "/api/admin/tournaments/[slug]/schedule/days" });
  d5.action = { ...(d5.action ?? {}), firstDayClosesAt: closeAt.toISOString(), plannedLastEnd: lastEnd.toISOString(), status: result.status, code: result.code };
}

/** 运行中采样：系统延误推算 + 公开赛程显示。 */
export async function delayWatchLoop(options: { context: RunContext; tournament: TournamentRuntime; registry: LiveRegistry; observations: Map<string, DelayObservation>; intervalMs?: number }) {
  const { context, tournament, registry, observations } = options;
  const codeById = new Map((await matchesOfTournament(tournament.id)).map((match) => [match.id, match.code]));
  const sampler = new Client(context.origin, `delay-watch-${tournament.plan.key}`, context.metrics, context.nextIp());
  while (!registry.stop) {
    try {
      const delays = await loadPublishedDelays(prisma, tournament.id, new Date());
      for (const [matchId, delay] of delays) {
        const code = codeById.get(matchId);
        if (!code) continue;
        const item = observations.get(code) ?? { firstDelayedAt: null, maxDelayMinutes: 0, causes: [], evidenced: false, shownDelayedPublic: false, overrunSeen: false };
        if (delay.delayed) {
          item.firstDelayedAt ??= Date.now();
          item.maxDelayMinutes = Math.max(item.maxDelayMinutes, delay.delayMinutes);
          if (delay.cause && !item.causes.includes(delay.cause)) item.causes.push(delay.cause);
          item.evidenced ||= delay.evidenced;
        }
        item.overrunSeen ||= delay.overrun;
        observations.set(code, item);
      }
      const schedule = await sampler.call<unknown>("GET", `/api/public/tournaments/${tournament.slug}/schedule`, undefined, { route: "/api/public/tournaments/[slug]/schedule" });
      for (const code of delayedCodes(schedule.json)) {
        const item = observations.get(code);
        if (item) item.shownDelayedPublic = true;
      }
    } catch (error) {
      context.log(`延误采样失败：${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(options.intervalMs ?? 10_000);
  }
}

function delayedCodes(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) delayedCodes(item, found);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && (record.time as { type?: string } | undefined)?.type === "DELAYED") found.push(record.code);
    for (const child of Object.values(record)) if (child && typeof child === "object") delayedCodes(child, found);
  }
  return found;
}

/**
 * D6：运行中改场并重新发布。时机：已锁定约 1/4 的比赛之后。
 * 挑一场计划在 2 个时段以后、尚未开始的小组赛，改到「现在起空闲足够长」的场地，开始时间取下一个整分钟；
 * 发布后再尝试改一场进行中的比赛（预计拒绝）。草稿里留下的改动最后放弃。
 */
export async function rescheduleLoop(options: { context: RunContext; tournament: TournamentRuntime; registry: LiveRegistry }) {
  const { context, tournament, registry } = options;
  const d6 = tournament.delayScenarios.find((item) => item.id === "D6");
  if (!d6) return;
  const slug = tournament.slug;
  while (!registry.stop) {
    await sleep(5000);
    const matches = await matchesOfTournament(tournament.id);
    const locked = matches.filter((match) => match.verificationStatus === "LOCKED").length;
    if (locked < matches.length / 4) continue;
    const profile = context.clock.profile;
    const slotMs = (profile.matchMinutes + profile.changeoverMinutes) * 60_000;
    const now = Date.now();
    const start = new Date(Math.ceil((now + 60_000) / 60_000) * 60_000);
    const workspace = await loadScheduleWorkspace(tournament.id, new Date());
    const busyUntil = new Map<string, number>();
    for (const match of matches) {
      if (!match.courtId) continue;
      if (match.lifecycleStatus === "IN_PROGRESS") busyUntil.set(match.courtId, Number.MAX_SAFE_INTEGER);
    }
    const nextStart = (courtId: string) =>
      Math.min(...matches.filter((match) => match.courtId === courtId && ["SCHEDULED", "READY"].includes(match.lifecycleStatus) && match.scheduledAt && !match.notPlayedAt).map((match) => match.scheduledAt!.getTime()), Number.MAX_SAFE_INTEGER);
    const idleCourt = workspace.courts.find((court) => !busyUntil.has(court.id) && nextStart(court.id) - start.getTime() >= slotMs);
    // 现场允许提前开赛，场地一空就会接着打本场地的下一场；真正「空出来」的通常是本场地已无后续比赛的场地。
    // 被移动的比赛：双方已确定、计划在至少一个时段之后、尚未开始的个人比赛（小组赛优先）。
    const candidates = workspace.publishedRows.filter((row) => {
      const match = matches.find((item) => item.code === row.code);
      return Boolean(
        match && row.movable && !row.isTeam && match.sideAEntryId && match.sideBEntryId && ["SCHEDULED", "READY"].includes(match.lifecycleStatus) &&
          match.scheduledAt && match.scheduledAt.getTime() > now + slotMs && !tournament.forced.has(match.code) && row.published.courtId !== idleCourt?.id,
      );
    });
    if (!idleCourt || !candidates.length) {
      if (locked > matches.length * 0.85) {
        d6.note = idleCourt ? "没有可移动的后续个人比赛" : "运行到 85% 仍没有出现空闲足够长的场地";
        return;
      }
      continue;
    }
    // 逐个试候选（小组赛优先）：改到空场后草稿若有硬冲突（例如选手此刻在别场），放弃这场草稿改动、换下一场。
    const ordered = [...candidates.filter((row) => matches.find((item) => item.code === row.code)?.groupId), ...candidates.filter((row) => !matches.find((item) => item.code === row.code)?.groupId)];
    let target: (typeof candidates)[number] | null = null;
    let patch: Awaited<ReturnType<typeof context.admin.call<{ hardCount: number; warningCount: number }>>> | null = null;
    let after: Awaited<ReturnType<typeof loadScheduleWorkspace>> | null = null;
    let hard: string[] = [];
    // 延误会让进行中的比赛与本场地/本人后续计划重叠，草稿检查在移动前就可能有硬冲突；
    // 只把「移动后新增、且涉及被移动比赛」的硬冲突算作这次移动造成的。
    const codeOf = new Map(matches.map((match) => [match.id, match.code]));
    const hardKeys = (issues: typeof workspace.draftCheck.issues) => issues.filter((issue) => issue.severity === "HARD");
    const baseline = hardKeys(workspace.draftCheck.issues);
    const baselineKeys = new Set(baseline.map((issue) => issue.key));
    d6.action = {
      ...(d6.action ?? {}),
      baselineHard: baseline.slice(0, 20).map((issue) => ({ code: issue.code, matches: issue.matchIds.map((id) => codeOf.get(id) ?? id) })),
    };
    const triedCodes = new Set((((d6.action?.tried as { code: string }[]) ?? [])).map((item) => item.code));
    for (const row of ordered.filter((item) => !triedCodes.has(item.code)).slice(0, 8)) {
      const attempt = await context.admin.call<{ hardCount: number; warningCount: number }>("PATCH", `/api/admin/tournaments/${slug}/schedule/slots/${row.code}`, {
        courtCode: idleCourt.code,
        start: localDateTime(start).slice(0, 16),
        durationMinutes: row.published.durationMinutes,
        refereeUserId: row.published.refereeId,
      }, { route: "/api/admin/tournaments/[slug]/schedule/slots/[matchCode]" });
      const workspaceAfter = await loadScheduleWorkspace(tournament.id, new Date());
      const movedId = matches.find((item) => item.code === row.code)?.id;
      const issues = hardKeys(workspaceAfter.draftCheck.issues)
        .filter((issue) => !baselineKeys.has(issue.key) && (!movedId || issue.matchIds.includes(movedId)))
        .map((issue) => issue.code);
      d6.action = { ...(d6.action ?? {}), tried: [...(((d6.action?.tried as unknown[]) ?? [])), { code: row.code, status: attempt.status, hard: issues, baselineHard: baseline.length }] };
      if (attempt.ok && !issues.length) {
        target = row;
        patch = attempt;
        after = workspaceAfter;
        hard = issues;
        break;
      }
      await context.admin.call("POST", `/api/admin/tournaments/${slug}/schedule/slots/${row.code}/discard`, undefined, { route: "/api/admin/tournaments/[slug]/schedule/slots/[matchCode]/discard" });
    }
    if (!target || !patch || !after) {
      if (locked > matches.length * 0.85) {
        d6.note = "空出的场地有，但候选比赛移过去都会与选手的其他比赛冲突";
        return;
      }
      continue;
    }
    const before = { court: target.published.courtCode, start: target.published.start };
    const publish = await context.admin.call<{ version: number }>("POST", `/api/admin/tournaments/${slug}/schedule/publish`, { warningDigest: after.warningDigest, note: "仿真 D6：改到空闲场地提前开赛" }, {
      route: "/api/admin/tournaments/[slug]/schedule/publish",
    });
    const publication = publish.ok ? (await loadScheduleWorkspace(tournament.id, new Date())).publications[0] : null;
    // 再尝试改一场进行中的比赛（预计拒绝：已开始的比赛时间/场地冻结）。
    const live = matches.find((match) => match.lifecycleStatus === "IN_PROGRESS");
    let startedAttempt: Record<string, unknown> | null = null;
    if (live) {
      const row = after.publishedRows.find((item) => item.code === live.code);
      const moved = await context.admin.call("PATCH", `/api/admin/tournaments/${slug}/schedule/slots/${live.code}`, {
        courtCode: idleCourt.code,
        start: localDateTime(start).slice(0, 16),
        durationMinutes: row?.published.durationMinutes ?? profile.matchMinutes,
        refereeUserId: row?.published.refereeId ?? null,
      }, { route: "/api/admin/tournaments/[slug]/schedule/slots/[matchCode]" });
      startedAttempt = { match: live.code, status: moved.status, code: moved.code, message: moved.message };
      if (moved.ok) {
        addFinding(context, { kind: "unexpected", area: "赛程", title: `D6 进行中的比赛 ${live.code} 的草稿安排被接受`, detail: startedAttempt });
        await context.admin.call("POST", `/api/admin/tournaments/${slug}/schedule/slots/${live.code}/discard`, {}, { route: "/api/admin/tournaments/[slug]/schedule/slots/[matchCode]/discard" });
      }
    }
    if (!publish.ok) {
      await context.admin.call("POST", `/api/admin/tournaments/${slug}/schedule/discard`, {}, { route: "/api/admin/tournaments/[slug]/schedule/discard" });
    }
    d6.constructed = true;
    d6.causes = [];
    d6.watch = [target.code];
    d6.action = {
      tried: d6.action?.tried ?? [],
      moved: target.code,
      from: before,
      to: { court: idleCourt.code, start: start.toISOString() },
      draftStatus: patch.status,
      draftHard: hard,
      baselineHard: d6.action?.baselineHard ?? [],
      publishStatus: publish.status,
      publishCode: publish.code,
      publishMessage: publish.ok ? null : publish.message,
      version: publish.json?.version ?? null,
      changes: publication?.changes ?? null,
      startedAttempt,
    };
    context.log(`D6：${target.code} 由 ${before.court} 改到 ${idleCourt.code}，发布 ${publish.status}${publish.ok ? ` 第 ${publish.json?.version} 版` : ` ${publish.code}`}`);
    return;
  }
}

/** 运行结束后：按情形汇总期望与实际。 */
export async function summarizeDelayScenarios(
  tournament: TournamentRuntime,
  observations: Map<string, DelayObservation>,
  extras: { reviews: { matchCode: string; confirmedAt: number | null }[]; lineups: { fixture: string; by: string; code: string | null }[] },
) {
  const matches = await matchesOfTournament(tournament.id);
  const byCode = new Map(matches.map((match) => [match.code, match]));
  const describe = (code: string) => {
    const match = byCode.get(code);
    const observed = observations.get(code);
    return {
      code,
      plannedStart: match?.scheduledAt?.toISOString() ?? null,
      actualStart: match?.startedAt?.toISOString() ?? null,
      startLagMinutes: match?.scheduledAt && match.startedAt ? Math.round((match.startedAt.getTime() - match.scheduledAt.getTime()) / 6000) / 10 : null,
      actualEnd: match?.endedAt?.toISOString() ?? null,
      delayedShown: Boolean(observed?.firstDelayedAt),
      maxDelayMinutes: observed?.maxDelayMinutes ?? 0,
      causes: observed?.causes ?? [],
      evidenced: observed?.evidenced ?? false,
      publicShownDelayed: observed?.shownDelayedPublic ?? false,
    };
  };
  for (const item of tournament.delayScenarios) {
    const causes = item.causes.map((code) => {
      const match = byCode.get(code);
      return {
        code,
        plannedMinutes: match?.scheduledAt && match.scheduledEndAt ? Math.round((match.scheduledEndAt.getTime() - match.scheduledAt.getTime()) / 60_000) : null,
        actualMinutes: match?.startedAt && match.endedAt ? Math.round((match.endedAt.getTime() - match.startedAt.getTime()) / 6000) / 10 : null,
        overrunSeen: observations.get(code)?.overrunSeen ?? false,
      };
    });
    const observed: Record<string, unknown> = { causes, watch: item.watch.map(describe) };
    if (item.id === "D3" && item.causes[0]) {
      const semi = byCode.get(item.causes[0]);
      const other = ((item.action?.otherSemi as string[] | undefined) ?? []).map((code) => byCode.get(code));
      const final = item.watch.map((code) => byCode.get(code)).find((match) => match?.fixture?.code === "F");
      const lockedAt = (code: string | undefined) => (code ? extras.reviews.find((review) => review.matchCode === code && review.confirmedAt)?.confirmedAt ?? null : null);
      observed.timeline = {
        delayedSemiEnded: semi?.endedAt?.toISOString() ?? null,
        delayedSemiLocked: lockedAt(semi?.code) ? new Date(lockedAt(semi?.code)!).toISOString() : null,
        otherSemiLocked: other.map((match) => (lockedAt(match?.code) ? new Date(lockedAt(match?.code)!).toISOString() : null)),
        finalStarted: final?.startedAt?.toISOString() ?? null,
        finalStartedBeforeBothLocked: Boolean(final?.startedAt && [semi, ...other].some((match) => !lockedAt(match?.code) || lockedAt(match?.code)! > final.startedAt!.getTime())),
      };
    }
    if (item.id === "D5") {
      const closesAt = item.action?.firstDayClosesAt ? new Date(item.action.firstDayClosesAt as string).getTime() : null;
      const beyond = closesAt ? matches.filter((match) => match.endedAt && match.endedAt.getTime() > closesAt) : [];
      const workspace = await loadScheduleWorkspace(tournament.id, new Date());
      observed.window = {
        firstDayClosesAt: item.action?.firstDayClosesAt ?? null,
        endedAfterClose: beyond.length,
        lastActualEnd: new Date(Math.max(...matches.filter((match) => match.endedAt).map((match) => match.endedAt!.getTime()))).toISOString(),
        publishedWarnings: workspace.publishedCheck.warningCount,
        outsideHoursInDraft: workspace.draftCheck.issues.filter((issue) => issue.code === "OUTSIDE_HOURS").length,
      };
      // 逐轮偏差：按计划开始时间分桶（每个时段一轮）。
      const played = matches.filter((match) => match.scheduledAt && match.startedAt).sort((x, y) => x.scheduledAt!.getTime() - y.scheduledAt!.getTime());
      const first = played[0]?.scheduledAt?.getTime() ?? 0;
      const rounds = new Map<number, number[]>();
      const slot = played.length ? (played[0].scheduledEndAt!.getTime() - played[0].scheduledAt!.getTime()) : 1;
      for (const match of played) {
        const round = Math.floor((match.scheduledAt!.getTime() - first) / slot) + 1;
        rounds.set(round, [...(rounds.get(round) ?? []), (match.startedAt!.getTime() - match.scheduledAt!.getTime()) / 60_000]);
      }
      observed.lagByRound = [...rounds.entries()].map(([round, lags]) => ({ round, matches: lags.length, meanLagMinutes: Math.round((lags.reduce((sum, value) => sum + value, 0) / lags.length) * 10) / 10 }));
    }
    if (item.id === "D7") {
      const fallbacks = extras.lineups.filter((record) => record.by === "admin");
      const rejected = extras.lineups.filter((record) => record.code === "lineup_deadline_passed");
      if (!rejected.length) item.constructed = false;
      observed.lineup = { managerRejected: rejected.length, adminSubmitted: fallbacks.length, fixtures: [...new Set(rejected.map((record) => record.fixture))] };
      if (!rejected.length) item.note = `${item.note ?? ""}本次运行没有出现名单截止先于开赛的情况（未触发）`.trim();
    }
    item.observed = observed;
  }
  return tournament.delayScenarios;
}

/**
 * 赛务异常（测试方案 §6，M5，`--scenarios ops`）。
 *
 * 两段：
 * 1. `planOps`（抽签与赛程发布之后、开赛之前）：选定构造对象并登记到运行状态——指定场次的特殊结果（`specials`）、
 *    按双方决定特殊结果的规则（`specialHooks`）、退出比赛的报名单位（`withdrawn`）、暂缓开赛与暂缓确认名次，
 *    以及「预计卡住」的项目（`expectedStuck`，运行结束时这些项目里缺一方的比赛单独列出，不算未完成）。
 * 2. `opsLoop`（现场）：裁判长处理特殊结果（排除）、逐项观察并记下期望 / 实际，§6.2 增补与撤销重抽、§6.6 现场异常、
 *    §6.7 组合压力窗口。
 *
 * 所有写入都走接口；判断「期望」时只读数据库与公开接口。结论分「符合 / 不符 / 设计未定义 / 预计卡住·已证实 /
 * 预计卡住·未证实 / 不可测 / 未触发」。系统缺口只记录，不绕过。
 */
import { randomUUID } from "node:crypto";

import { loadIndividualGroupRanking } from "../../../src/server/services/results-service";
import { loadGroupStandings } from "../../../src/server/services/team-tie-service";
import { loadScheduleWorkspace } from "../../../src/server/services/schedule-service";
import { sleep } from "../core/clock";
import { entriesOf, fixturesOf, groupsOf, matchesOfTournament, pendingRegistrations, prisma } from "../core/db";
import { Client, type CallResult } from "../core/http";
import type { Rng } from "../core/rng";
import type { Server } from "../core/server";
import { ceilMinute, localDateTime } from "../core/time";
import { addFinding, recordProbe, type ProbeVerdict, type RunContext, type TournamentRuntime } from "../scenario/context";
import { drawCompetition } from "../scenario/draw";
import type { ReviewRecord } from "./chief";
import { brief, driver, injectionLoop, toRally, withBorrowed, type Env } from "./injections";
import type { Control, MatchStateView } from "./referee";
import type { LiveRegistry } from "./venue";

type Side = "A" | "B";
const other = (side: Side): Side => (side === "A" ? "B" : "A");

interface OpsEnv extends Env {
  reviews: ReviewRecord[];
  plan: OpsPlan;
}

export interface OpsPlan {
  /** WS 第一轮：赛前弃权、中途退赛（借用执裁）、双方弃权。 */
  woKo: string | null;
  retKo: string | null;
  abandonKo: string | null;
  /** MS 一个 4 人组里 3 人退出。 */
  shrink: { competition: string; group: string; groupId: string; withdrawn: string[]; remaining: string } | null;
  /** MD 一个 4 人组里一对中途退赛（先 RET、之后各场弃权）。 */
  groupWithdraw: { competition: string; group: string; groupId: string; entryId: string } | null;
  /** XD 一个 4 人组里一对打完 3 场后被查实冒名顶替。 */
  dsq: { competition: string; group: string; groupId: string; entryId: string } | null;
  /** 团体：一队打完第一场对抗后退出；最后一场小组对抗不交名单。 */
  team: { entryId: string; teamKey: string; group: string; groupId: string; first: string; middle: string[]; last: string } | null;
  /** 组合压力窗口里整体退出的学院（运行中选定）。 */
  chaosUnit: string | null;
}

function verdictOf(ok: boolean | ProbeVerdict): ProbeVerdict {
  return typeof ok === "string" ? ok : ok ? "符合" : "不符";
}

function record(env: { context: RunContext }, item: { id: string; group: string; title: string; expected: string; actual: string; ok: boolean | ProbeVerdict; match?: string; detail?: Record<string, unknown> }) {
  recordProbe(env.context, { id: item.id, group: item.group, title: item.title, expected: item.expected, actual: item.actual, verdict: verdictOf(item.ok), match: item.match, detail: item.detail });
}

async function waitUntil<T>(registry: LiveRegistry, check: () => Promise<T | null | undefined | false>, intervalMs = 2000, timeoutMs = Number.MAX_SAFE_INTEGER): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (!registry.stop && Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

const matchByCode = (code: string) =>
  prisma.match.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      lifecycleStatus: true,
      verificationStatus: true,
      outcomeType: true,
      version: true,
      startedAt: true,
      scheduledAt: true,
      courtId: true,
      sideAEntryId: true,
      sideBEntryId: true,
      fixtureId: true,
      games: { select: { number: true, scoreA: true, scoreB: true, completed: true }, orderBy: { number: "asc" } },
      resultRevisions: { select: { revision: true, status: true, returnedAt: true }, orderBy: { revision: "asc" } },
    },
  });

/** 下一轮里由本对阵胜者填入的一侧。 */
async function winnerTarget(fixtureId: string) {
  const row = await prisma.fixture.findFirst({
    where: { OR: [{ sideAFixtureId: fixtureId, sideASource: "FIXTURE_WINNER" }, { sideBFixtureId: fixtureId, sideBSource: "FIXTURE_WINNER" }] },
    select: { id: true, code: true, sideAFixtureId: true, sideAEntryId: true, sideBEntryId: true },
  });
  if (!row) return null;
  const side: Side = row.sideAFixtureId === fixtureId ? "A" : "B";
  return { id: row.id, code: row.code, side, entryId: side === "A" ? row.sideAEntryId : row.sideBEntryId };
}

async function publicMatch(env: Env, code: string) {
  return env.context.admin.call<{ match: { court: string | null; lifecycle: string; outcome: string; winnerSide: Side | null; games: { number: number; scoreA: number | null; scoreB: number | null; status?: string }[]; sideA: unknown; sideB: unknown } }>(
    "GET",
    `/api/public/tournaments/${env.tournament.slug}/matches/${code}`,
    undefined,
    { route: "/api/public/tournaments/[slug]/matches/[code]" },
  );
}

/** 公开投影里的局分：有比分的局「A:B（状态）」，未开始的局省略。 */
function publicGames(result: Awaited<ReturnType<typeof publicMatch>>) {
  return (result.json?.match?.games ?? [])
    .filter((game) => game.scoreA !== null && game.scoreA !== undefined)
    .map((game) => `${game.scoreA}:${game.scoreB}${game.status && game.status !== "COMPLETED" ? `（${game.status}）` : ""}`);
}

/**
 * 裁判长接管一场比赛并依次发命令（复核、重开、补录特殊结果等），结束时释放。
 * 受理的 commandId 记进 reviews，判定的「请求↔事件一一对应」会把它们并入本场。
 */
async function asChief<T>(env: OpsEnv, code: string, reason: string, body: (send: (type: string, payload: Record<string, unknown>) => Promise<CallResult<{ state?: MatchStateView }>>, read: () => Promise<MatchStateView | null>) => Promise<T>) {
  const chief = env.tournament.chiefs[env.tournament.chiefs.length - 1];
  const takeover = await chief.client.call<Control>("POST", `/api/matches/${code}/control/takeover`, { deviceSessionId: randomUUID(), reason }, { route: "/api/matches/[code]/control/takeover" });
  if (!takeover.ok) return { takeover, value: null as T | null };
  const control = takeover.json!;
  const auth = { Authorization: `Bearer ${control.controlToken}` };
  const read = async () => (await chief.client.call<{ state: MatchStateView }>("GET", `/api/matches/${code}/state`, undefined, { route: "/api/matches/[code]/state" })).json?.state ?? null;
  const send = async (type: string, payload: Record<string, unknown>) => {
    const state = await read();
    const commandId = randomUUID();
    const result = await chief.client.call<{ state?: MatchStateView }>("POST", `/api/matches/${code}/commands`, {
      commandId,
      occurredAt: new Date().toISOString(),
      expectedVersion: state?.version ?? 0,
      scoringSessionId: control.sessionId,
      takeoverGeneration: control.takeoverGeneration,
      type,
      payload,
    }, { route: "/api/matches/[code]/commands", headers: auth, note: type });
    env.reviews.push({ matchCode: code, chief: chief.login, submittedSeenAt: Date.now(), confirmedAt: type === "CONFIRM_RESULT" && result.ok ? Date.now() : null, commandId: result.ok ? commandId : null, status: result.status, code: result.code });
    return result;
  };
  try {
    return { takeover, value: await body(send, read) };
  } finally {
    await chief.client.call("DELETE", `/api/matches/${code}/control`, { scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration }, { route: "/api/matches/[code]/control", headers: auth });
  }
}

// ---------------------------------------------------------------- 规划

interface GroupView {
  id: string;
  code: string;
  entries: string[];
  codes: string[];
}

async function individualGroups(competitionId: string): Promise<GroupView[]> {
  const fixtures = await fixturesOf(competitionId);
  const groups = await groupsOf(competitionId);
  return groups.map((group) => {
    const entries = new Set<string>();
    const codes: string[] = [];
    for (const fixture of fixtures.filter((item) => item.groupId === group.id)) {
      if (fixture.sideAEntryId) entries.add(fixture.sideAEntryId);
      if (fixture.sideBEntryId) entries.add(fixture.sideBEntryId);
      codes.push(...fixture.matches.map((match) => match.code));
    }
    return { id: group.id, code: group.code, entries: [...entries].sort(), codes };
  });
}

export async function planOps(context: RunContext, tournament: TournamentRuntime): Promise<OpsPlan> {
  const rng = context.rng.fork("ops:plan");
  // 避开强制同分（M3）用到的小组与场次：两边的构造互相会破坏。
  const free = (group: GroupView) => group.entries.length === 4 && !group.codes.some((code) => tournament.forced.has(code));
  const plan: OpsPlan = { woKo: null, retKo: null, abandonKo: null, shrink: null, groupWithdraw: null, dsq: null, team: null, chaosUnit: null };

  // §6.1 / §6.4 淘汰赛：WS 第一轮三场——赛前弃权、中途退赛、双方都弃权。
  const ws = tournament.competitions.get("WS");
  if (ws) {
    const first = (await fixturesOf(ws.id))
      .filter((fixture) => fixture.round === 1 && fixture.sideAEntryId && fixture.sideBEntryId && fixture.matches.length === 1 && !tournament.forced.has(fixture.matches[0].code))
      .sort((left, right) => (left.matches[0].scheduledAt?.getTime() ?? 0) - (right.matches[0].scheduledAt?.getTime() ?? 0));
    if (first.length >= 3) {
      plan.woKo = first[0].matches[0].code;
      plan.retKo = first[1].matches[0].code;
      plan.abandonKo = first[2].matches[0].code;
      const loser: Side = rng.chance(0.5) ? "A" : "B";
      tournament.specials.set(plan.woKo, { type: "WO", loser, at: null, reason: "仿真：赛前弃权（单场）" });
      tournament.specials.set(plan.abandonKo, { type: "ABANDONED", loser: null, at: null, reason: "仿真：双方均未到场" });
      tournament.heldMatches.add(plan.retKo);
      tournament.expectedStuck.set("WS", "双方弃权的淘汰赛对阵记为中止、没有胜者，下一轮签位为空，系统没有一方空位自动晋级（§6.1）");
    }
  }

  // §6.1 大面积弃权：MS 一个 4 人组里 3 人退出，只剩 1 人而出线名额是 2。
  const ms = tournament.competitions.get("MS");
  if (ms) {
    const group = (await individualGroups(ms.id)).find(free);
    if (group) {
      const remaining = rng.pick(group.entries);
      const withdrawn = group.entries.filter((id) => id !== remaining);
      for (const id of withdrawn) tournament.withdrawn.set(id, { reason: "大面积弃权（同组 3 人退出）", at: Date.now() });
      plan.shrink = { competition: "MS", group: group.code, groupId: group.id, withdrawn, remaining };
      tournament.expectedStuck.set("MS", "小组排除后剩余人数少于出线名额，名次确认把缺的名次写成空签位，淘汰对阵缺一方（§6.1）");
    }
  }

  // §6.1 小组赛选手中途弃权：MD 一个 4 人组里一对，第一场第 1 局打到 10 分时退赛，之后各场弃权。
  const md = tournament.competitions.get("MD");
  if (md) {
    const group = (await individualGroups(md.id)).find(free);
    if (group) {
      const entryId = rng.pick(group.entries);
      plan.groupWithdraw = { competition: "MD", group: group.code, groupId: group.id, entryId };
      tournament.hookedEntries.add(entryId);
      let calls = 0;
      tournament.specialHooks.push((match) => {
        if (match.competitionCode !== "MD" || (match.sideAEntryId !== entryId && match.sideBEntryId !== entryId)) return null;
        const side: Side = match.sideAEntryId === entryId ? "A" : "B";
        calls += 1;
        if (calls === 1) return { type: "RET", loser: side, at: { game: 1, points: 10 }, reason: "仿真：伤病退赛（小组赛中途）" };
        tournament.withdrawn.set(entryId, { reason: "小组赛中途伤病退出", at: Date.now() });
        return { type: "WO", loser: side, at: null, reason: "仿真：已因伤退出比赛，后续弃权" };
      });
    }
  }

  // §6.1 赛后取消资格追溯：XD 一个 4 人组里一对，3 场全部锁定后被查实冒名顶替。名次暂缓确认，直到追溯处理完。
  const xd = tournament.competitions.get("XD");
  if (xd) {
    const group = (await individualGroups(xd.id)).find(free);
    if (group) {
      plan.dsq = { competition: "XD", group: group.code, groupId: group.id, entryId: rng.pick(group.entries) };
      tournament.rankingHolds.add(`XD/${group.code}`);
    }
  }

  // §6.1 团体小组某队中途退出：打完第一场对抗后退出，中间几场小场按弃权录；最后一场不交名单。
  const teamPlan = tournament.plan.team;
  const teamCompetition = teamPlan ? tournament.competitions.get(teamPlan.code) : undefined;
  if (teamCompetition) {
    const fixtures = await fixturesOf(teamCompetition.id);
    const groups = await groupsOf(teamCompetition.id);
    const group = groups.find((item) => fixtures.filter((fixture) => fixture.groupId === item.id).length >= 3);
    if (group) {
      const inGroup = fixtures.filter((fixture) => fixture.groupId === group.id);
      const team = rng.pick(tournament.teams.filter((item) => item.entryId && inGroup.some((fixture) => fixture.sideAEntryId === item.entryId || fixture.sideBEntryId === item.entryId)));
      const own = inGroup
        .filter((fixture) => fixture.sideAEntryId === team.entryId || fixture.sideBEntryId === team.entryId)
        .sort((left, right) => (left.matches[0]?.scheduledAt?.getTime() ?? 0) - (right.matches[0]?.scheduledAt?.getTime() ?? 0));
      if (own.length >= 3) {
        plan.team = { entryId: team.entryId!, teamKey: team.key, group: group.code, groupId: group.id, first: own[0].id, middle: own.slice(1, -1).map((item) => item.id), last: own[own.length - 1].id };
        tournament.lineupReserved.add(plan.team.last);
        tournament.expectedStuck.set(teamPlan!.code, "团体小场没有出场名单就不能载入比赛（连弃权都录不进去），团体积分榜没有排除功能（§6.1）");
      }
    }
  }
  context.log(`[赛务] 规划：WS ${[plan.woKo, plan.retKo, plan.abandonKo].join("/")}，MS ${plan.shrink?.group ?? "-"} 组 3 人退出，MD ${plan.groupWithdraw?.group ?? "-"} 组中途退赛，XD ${plan.dsq?.group ?? "-"} 组追溯取消资格，团体 ${plan.team?.teamKey ?? "-"} 中途退出`);
  return plan;
}

// ---------------------------------------------------------------- 现场

export async function opsLoop(options: { context: RunContext; tournament: TournamentRuntime; registry: LiveRegistry; server: Server; rng: Rng; reviews: ReviewRecord[]; plan: OpsPlan; only?: Set<string> }) {
  const { context, tournament, registry, server, rng, reviews, plan, only } = options;
  const tablets: [Client, Client] = [
    new Client(context.origin, `ops-${tournament.plan.key}-tablet-1`, context.metrics, context.nextIp()),
    new Client(context.origin, `ops-${tournament.plan.key}-tablet-2`, context.metrics, context.nextIp()),
  ];
  for (const tablet of tablets) await tablet.signIn(context.refereeLogin.login, context.refereeLogin.password);
  const env: OpsEnv = { context, tournament, registry, server, rng, tablets, reviews, plan };
  const groups: [string, (env: OpsEnv) => Promise<void>][] = [
    ["exclusions", exclusionLoop],
    ["ko", knockoutProbes],
    ["shrink", shrinkProbe],
    ["group-withdraw", groupWithdrawProbe],
    ["dsq", dsqProbe],
    ["team", teamWithdrawProbe],
    ["registration", registrationProbes],
    ["rename", renameProbe],
    ["onsite", onsiteProbes],
    ["chaos", chaosWindow],
  ];
  await sleep(5000);
  await Promise.allSettled(groups.filter(([key]) => key === "exclusions" || !only || only.has(key)).map(([key, run]) => guarded(env, key, run)));
}

async function guarded(env: OpsEnv, key: string, run: (env: OpsEnv) => Promise<void>) {
  try {
    await run(env);
  } catch (error) {
    addFinding(env.context, { kind: "script_error", area: "赛务异常", title: `赛务组 ${key} 中断`, detail: { message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) } });
    recordProbe(env.context, { id: `ops-${key}:*`, group: "脚本", title: `赛务组 ${key}`, expected: "—", actual: error instanceof Error ? error.message : String(error), verdict: "脚本错误" });
  }
}

// ---------------------------------------------------------------- 裁判长处理特殊结果（排除）

export interface ExclusionLog {
  competition: string;
  group: string;
  entryId: string;
  reason: string;
  status: number;
  code: string | null;
  at: number;
}

const exclusionLogs: ExclusionLog[] = [];
export function opsExclusions() {
  return exclusionLogs;
}

/**
 * 小组里出现弃权、退赛、取消资格或中止时，本组名次被「有特殊结果待处理」挡住，裁判长要把不能完成本组比赛的一方排除。
 * 只有排除这一种工具：排除后该单位在本组的全部比赛都不计（§6.1）。中止的比赛双方都排除。
 * 暂缓确认名次的组（追溯处理中）跳过。中途退赛那一组在排除前先试一次确认，记下被挡住的回应。
 */
async function exclusionLoop(env: OpsEnv) {
  const { tournament, registry, context, plan } = env;
  const chief = tournament.chiefs[0];
  const done = new Set<string>();
  let blockedProbeDone = false;
  while (!registry.stop) {
    for (const competition of tournament.competitions.values()) {
      if (competition.entryType === "TEAM") continue;
      for (const group of await groupsOf(competition.id)) {
        const key = `${competition.code}/${group.code}`;
        if (group.rankingConfirmedAt || tournament.rankingHolds.has(key)) continue;
        const { ranking, matches } = await loadIndividualGroupRanking(prisma, group.id);
        if (!ranking.blockers.length) continue;
        for (const blocker of ranking.blockers) {
          const match = matches.find((item) => item.code === blocker.matchCode);
          const losers = !match?.fact.winner ? blocker.entryIds : [match.fact.winner === "A" ? match.sideB : match.sideA];
          for (const entryId of losers) {
            if (done.has(`${group.id}:${entryId}`) || ranking.excluded.some((item) => item.entryId === entryId)) continue;
            done.add(`${group.id}:${entryId}`);
            if (!blockedProbeDone && plan.groupWithdraw?.groupId === group.id) {
              blockedProbeDone = true;
              const attempt = await chief.client.call("POST", `/api/admin/tournaments/${tournament.slug}/competitions/${competition.code}/groups/${group.code}/ranking`, {}, {
                route: "/api/admin/tournaments/[slug]/competitions/[code]/groups/[group]/ranking",
              });
              record(env, {
                id: "6.1-group-blocked",
                group: "§6.1 弃权与退赛",
                title: "小组有未处理的特殊结果时确认名次",
                expected: "409 ranking_not_confirmable（有特殊结果待处理），本组名次不能确认",
                actual: `${brief(attempt)}；排名状态 ${ranking.status}，待处理 ${ranking.blockers.length} 场`,
                ok: attempt.status === 409 && attempt.code === "ranking_not_confirmable",
                match: blocker.matchCode,
              });
            }
            const reason = tournament.withdrawn.get(entryId)?.reason ?? `本组 ${blocker.matchCode} 为${blocker.outcome}，不能完成本组比赛`;
            const result = await chief.client.call("POST", `/api/admin/tournaments/${tournament.slug}/competitions/${competition.code}/groups/${group.code}/exclusions`, { entryId, action: "ADD", reason: `仿真裁判长：${reason}` }, {
              route: "/api/admin/tournaments/[slug]/competitions/[code]/groups/[group]/exclusions",
            });
            exclusionLogs.push({ competition: competition.code, group: group.code, entryId, reason, status: result.status, code: result.code, at: Date.now() });
            context.log(`[赛务] 排除 ${key} ${entryId.slice(0, 8)}：${brief(result)}`);
            if (!result.ok && result.code !== "already_excluded") {
              addFinding(context, { kind: "blocked", area: "小组排除", title: `${key} 排除被拒绝`, detail: { entryId, status: result.status, code: result.code, message: result.message } });
            }
          }
        }
      }
    }
    await sleep(3000);
  }
}

// ---------------------------------------------------------------- §6.1 / §6.4 淘汰赛

async function knockoutProbes(env: OpsEnv) {
  await Promise.all([woProbe(env), retProbe(env), abandonProbe(env)]);
}

const GROUP_61 = "§6.1 弃权与退赛";

async function woProbe(env: OpsEnv) {
  const code = env.plan.woKo;
  if (!code) return;
  const match = await waitUntil(env.registry, async () => {
    const row = await matchByCode(code);
    return row?.verificationStatus === "LOCKED" ? row : null;
  });
  if (!match) {
    record(env, { id: "6.1-wo", group: GROUP_61, title: "淘汰赛单场赛前弃权", expected: "WO 录入、复核锁定、胜方进入下一轮", actual: "运行结束前没有锁定", ok: "未触发", match: code });
    return;
  }
  const special = env.registry.results.find((item) => item.matchCode === code)?.special;
  const winnerEntry = special?.loser === "A" ? match.sideBEntryId : match.sideAEntryId;
  const target = match.fixtureId ? await winnerTarget(match.fixtureId) : null;
  const shown = await publicMatch(env, code);
  const games = match.games.filter((game) => game.scoreA || game.scoreB || game.completed);
  const ok = match.outcomeType === "WO" && games.length === 0 && (!target || target.entryId === winnerEntry) && shown.json?.match?.outcome === "WO";
  record(env, {
    id: "6.1-wo",
    group: GROUP_61,
    title: "淘汰赛单场赛前弃权",
    expected: "WO 须指明弃权方；未打的局留空，不补 21:0；胜方进入下一轮；公开页显示弃权",
    actual: `录入 ${special ? `${special.status}${special.code ? ` ${special.code}` : ""}` : "?"}；结果 ${match.outcomeType}；有比分的局 ${games.length}；下一轮 ${target ? `${target.code} ${target.side} 方${target.entryId === winnerEntry ? "＝胜方" : target.entryId ? "≠胜方" : "为空"}` : "（无）"}；公开页 ${shown.json?.match?.outcome ?? brief(shown)}`,
    ok,
    match: code,
  });
}

/** 借用执裁：第 2 局打到 6 分后，先误按弃权（预期被拒：已开打应记退赛），再记退赛，看局分保留与晋级。 */
async function retProbe(env: OpsEnv) {
  const code = env.plan.retKo;
  if (!code) return;
  let woAttempt: CallResult | null = null;
  let retAttempt: CallResult | null = null;
  let atRet: { game: number; A: number; B: number } | null = null;
  let loser: Side = "A";
  await withBorrowed(env, "§6.1 中途退赛", async (borrowed) => {
    env.tournament.heldMatches.delete(code);
    const d = driver(env, borrowed, env.tablets[0]);
    if (!(await d.acquire()).ok) return null;
    await d.refresh();
    const paused = await d.play({ onPhase: async (state) => (state.phase === "IN_PROGRESS" && state.currentGame >= 2 && state.score.A + state.score.B >= 6 ? "pause" : "continue") });
    if (paused.reason !== "paused") return paused;
    loser = env.rng.chance(0.5) ? "A" : "B";
    woAttempt = await d.post(d.envelope("RECORD_SPECIAL_OUTCOME", { type: "WO", winnerSide: other(loser), reason: "仿真：已开打后误按弃权" }));
    await d.refresh();
    atRet = { game: d.state!.currentGame, A: d.state!.score.A, B: d.state!.score.B };
    retAttempt = await d.send("RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: other(loser), reason: "仿真：第二局伤病退赛" });
    return d.play();
  }, undefined, (match) => match.code === code);
  const match = await waitUntil(env.registry, async () => {
    const row = await matchByCode(code);
    return row?.verificationStatus === "LOCKED" ? row : null;
  });
  const title = "淘汰赛中途退赛（含误按弃权）";
  const expected = "已开打后录 WO 被拒；RET 须指明退赛方；保留已完成局与中断局实际比分（快照、公开页）；胜方进入下一轮";
  if (!match || !atRet) {
    record(env, { id: "6.1-ret", group: GROUP_61, title, expected, actual: `没有打到退赛点或运行结束前没有锁定（WO ${woAttempt ? brief(woAttempt) : "-"}，RET ${retAttempt ? brief(retAttempt) : "-"}）`, ok: "未触发", match: code });
    return;
  }
  const at = atRet as { game: number; A: number; B: number };
  const stopped = match.games.find((game) => game.number === at.game);
  const completed = match.games.filter((game) => game.completed);
  const winnerEntry = loser === "A" ? match.sideBEntryId : match.sideAEntryId;
  const target = match.fixtureId ? await winnerTarget(match.fixtureId) : null;
  const shown = await publicMatch(env, code);
  const shownGames = publicGames(shown);
  const wo = woAttempt as CallResult | null;
  const ret = retAttempt as CallResult | null;
  const ok = Boolean(wo && !wo.ok && wo.status < 500) && Boolean(ret?.ok) && match.outcomeType === "RET" && completed.length >= 1 && stopped?.scoreA === at.A && stopped?.scoreB === at.B && shownGames.length >= 2 && (!target || target.entryId === winnerEntry);
  record(env, {
    id: "6.1-ret",
    group: GROUP_61,
    title,
    expected,
    actual: `误按 WO ${wo ? brief(wo) : "-"}${wo?.message ? `（${wo.message}）` : ""}；RET ${ret ? brief(ret) : "-"}；退赛时第 ${at.game} 局 ${at.A}:${at.B}，库里该局 ${stopped ? `${stopped.scoreA}:${stopped.scoreB}${stopped.completed ? "（标为已完成）" : "（未完成）"}` : "缺失"}，已完成局 ${completed.map((game) => `${game.scoreA}:${game.scoreB}`).join("、") || "无"}；公开页局分 ${shownGames.join("、") || "无"}；下一轮 ${target ? `${target.code} ${target.side} 方${target.entryId === winnerEntry ? "＝胜方" : "≠胜方"}` : "（无）"}`,
    ok,
    match: code,
  });
}

async function abandonProbe(env: OpsEnv) {
  const code = env.plan.abandonKo;
  if (!code) return;
  const title = "淘汰赛双方都弃权";
  const expected = "赛务口径 K-1/K-2：记中止（无胜方）后下一轮该侧记为空位；对手产生后以 WO 直接晋级，该场记为未进行";
  const match = await waitUntil(env.registry, async () => {
    const row = await matchByCode(code);
    return row?.verificationStatus === "LOCKED" ? row : null;
  });
  if (!match) {
    record(env, { id: "6.1-ko-abandon", group: GROUP_61, title, expected, actual: "运行结束前没有锁定", ok: "未触发", match: code });
    return;
  }
  const target = match.fixtureId ? await winnerTarget(match.fixtureId) : null;
  // 等到下一轮的另一侧也有人（另一场打完），再看这一侧是否仍为空。
  const settled = target
    ? await waitUntil(env.registry, async () => {
        const row = await prisma.fixture.findUnique({ where: { id: target.id }, select: { sideAEntryId: true, sideBEntryId: true, sideAVacant: true, sideBVacant: true, vacancyDecided: true, winnerEntryId: true, matches: { select: { code: true, lifecycleStatus: true, notPlayedAt: true } } } });
        const otherSide = target.side === "A" ? row?.sideBEntryId : row?.sideAEntryId;
        return otherSide ? row : null;
      }, 3000)
    : null;
  const mine = settled ? (target!.side === "A" ? settled.sideAEntryId : settled.sideBEntryId) : null;
  const vacant = settled ? (target!.side === "A" ? settled.sideAVacant : settled.sideBVacant) : false;
  const opponentEntry = settled ? (target!.side === "A" ? settled.sideBEntryId : settled.sideAEntryId) : null;
  const shown = settled?.matches[0] ? await publicMatch(env, settled.matches[0].code) : null;
  record(env, {
    id: "6.1-ko-abandon",
    group: GROUP_61,
    title,
    expected,
    actual: `结果 ${match.outcomeType}；下一轮 ${target?.code ?? "（无）"} ${target?.side ?? ""} 方 ${settled ? (mine ? "被填入" : vacant ? "记为空位" : "为空但未标空位") : "（另一侧到结束也未确定）"}，空位决出 ${settled?.vacancyDecided ? "是" : "否"}，胜方${settled?.winnerEntryId && settled.winnerEntryId === opponentEntry ? "＝对手" : "未定"}，该场 ${settled?.matches[0]?.lifecycleStatus ?? "-"}${settled?.matches[0]?.notPlayedAt ? "（未进行）" : ""}；公开页 ${shown ? `${shown.json?.match?.lifecycle ?? brief(shown)}` : "-"}`,
    ok: settled ? !mine && vacant && settled.vacancyDecided && settled.winnerEntryId === opponentEntry : "未触发",
    match: code,
    detail: { downstream: target?.code ?? null },
  });
}

// ---------------------------------------------------------------- §6.1 小组

async function shrinkProbe(env: OpsEnv) {
  const plan = env.plan.shrink;
  if (!plan) return;
  const title = "4 人组 3 人退出（剩余人数少于出线名额）";
  const expected = "赛务口径 R-3/K-1：WO/RET 负方自动删除小组成绩，确认名次只剩 1 人；第 2 名签位记为空位，对手产生后直接晋级（不递补）";
  const group = await waitUntil(env.registry, async () => {
    const row = await prisma.group.findUnique({ where: { id: plan.groupId }, select: { rankingConfirmedAt: true, ranking: true } });
    return row?.rankingConfirmedAt ? row : null;
  }, 3000);
  if (!group) {
    record(env, { id: "6.1-shrink", group: GROUP_61, title, expected, actual: "运行结束前本组名次没有确认", ok: "未触发", detail: { group: plan.group } });
    return;
  }
  const order = ((group.ranking as { order?: string[] } | null)?.order ?? []) as string[];
  const targets = await prisma.fixture.findMany({
    where: { OR: [{ sideAGroupId: plan.groupId }, { sideBGroupId: plan.groupId }] },
    select: { code: true, sideAGroupId: true, sideARank: true, sideAEntryId: true, sideAVacant: true, sideBGroupId: true, sideBRank: true, sideBEntryId: true, sideBVacant: true },
  });
  const slots = targets.flatMap((fixture) => [
    ...(fixture.sideAGroupId === plan.groupId ? [{ code: fixture.code, rank: fixture.sideARank, entry: fixture.sideAEntryId, vacant: fixture.sideAVacant }] : []),
    ...(fixture.sideBGroupId === plan.groupId ? [{ code: fixture.code, rank: fixture.sideBRank, entry: fixture.sideBEntryId, vacant: fixture.sideBVacant }] : []),
  ]);
  const empty = slots.filter((slot) => !slot.entry);
  const specials = await prisma.match.groupBy({ by: ["outcomeType"], where: { groupId: plan.groupId }, _count: true });
  record(env, {
    id: "6.1-shrink",
    group: GROUP_61,
    title,
    expected,
    actual: `本组结果 ${specials.map((item) => `${item.outcomeType ?? "NORMAL"}×${item._count}`).join("、")}；确认名次 ${order.length} 人（${order[0] === plan.remaining ? "为留下的一人" : "不是留下的人"}）；签位 ${slots.map((slot) => `${slot.code}#${slot.rank}${slot.entry ? "" : slot.vacant ? "空位" : "空（未标空位）"}`).join("、")}`,
    ok: order.length === 1 && order[0] === plan.remaining && empty.length > 0 && empty.every((slot) => slot.vacant),
    detail: { group: plan.group, emptySlots: empty.map((slot) => slot.code) },
  });
}

async function groupWithdrawProbe(env: OpsEnv) {
  const plan = env.plan.groupWithdraw;
  if (!plan) return;
  const title = "小组赛选手中途退赛（先退赛、后续弃权）→ 成绩自动删除";
  const expected = "赛务口径 R-3：第一场 RET 保留比分、其余 WO；该单位没打完本组，全部小组成绩自动删除（不需裁判长手工排除），名次不含该单位；原比分保留；名次与独立重算一致（见判定「小组名次」）";
  const group = await waitUntil(env.registry, async () => {
    const row = await prisma.group.findUnique({ where: { id: plan.groupId }, select: { rankingConfirmedAt: true, ranking: true, exclusions: { select: { entryId: true, reason: true } } } });
    return row?.rankingConfirmedAt ? row : null;
  }, 3000);
  const matches = await prisma.match.findMany({ where: { groupId: plan.groupId, OR: [{ sideAEntryId: plan.entryId }, { sideBEntryId: plan.entryId }] }, select: { code: true, outcomeType: true, verificationStatus: true, games: { select: { scoreA: true, scoreB: true } } } });
  if (!group) {
    record(env, { id: "6.1-group-withdraw", group: GROUP_61, title, expected, actual: `运行结束前本组名次没有确认；该单位比赛 ${matches.map((match) => `${match.code}:${match.outcomeType ?? "-"}/${match.verificationStatus}`).join("、")}`, ok: "未触发" });
    return;
  }
  const order = ((group.ranking as { order?: string[] } | null)?.order ?? []) as string[];
  const ret = matches.find((match) => match.outcomeType === "RET");
  record(env, {
    id: "6.1-group-withdraw",
    group: GROUP_61,
    title,
    expected,
    actual: `该单位比赛 ${matches.map((match) => `${match.code}:${match.outcomeType ?? "NORMAL"}`).join("、")}；退赛场比分 ${ret ? ret.games.map((game) => `${game.scoreA}:${game.scoreB}`).join(" ") : "-"}；手工排除 ${group.exclusions.some((item) => item.entryId === plan.entryId) ? "已登记" : "未登记（R-3 自动删除）"}；确认名次 ${order.length} 人${order.includes(plan.entryId) ? "（仍含该单位）" : ""}`,
    ok: Boolean(ret) && !order.includes(plan.entryId),
    detail: { group: plan.group },
  });
}

/**
 * 赛后取消资格追溯：该对 3 场小组赛全部锁定后，逐场尝试改判。
 * 1 裁判长接管第一场、受控重开（名次尚未确认，预期可以）；2 录 DSQ（预期被拒：比赛已正常结束，相位不允许）；
 * 3 重新提交并确认，恢复原结果；4 只能用「排除」让该单位 3 场都不计；5 放开名次确认。每一步的回应都记下。
 */
async function dsqProbe(env: OpsEnv) {
  const plan = env.plan.dsq;
  if (!plan) return;
  const key = `${plan.competition}/${plan.group}`;
  const title = "赛后取消资格追溯（已打 3 场）";
  const expected = "赛务口径 W-4：裁判长登记取消资格（对整个赛事生效），已锁定的结果不改写、未开始的比赛以 WO 判给对手；本组成绩由裁判长排除删除";
  const steps: string[] = [];
  try {
    const codes = await waitUntil(env.registry, async () => {
      const rows = await prisma.match.findMany({ where: { groupId: plan.groupId, OR: [{ sideAEntryId: plan.entryId }, { sideBEntryId: plan.entryId }] }, select: { code: true, verificationStatus: true, sideAEntryId: true, notPlayedAt: true } });
      return rows.length >= 3 && rows.every((row) => row.verificationStatus === "LOCKED") ? rows : null;
    }, 3000);
    if (!codes) {
      record(env, { id: "6.1-dsq-retro", group: GROUP_61, title, expected, actual: "运行结束前该单位 3 场没有全部锁定", ok: "未触发" });
      return;
    }
    const first = codes[0];
    const before = await prisma.match.findMany({ where: { code: { in: codes.map((row) => row.code) } }, select: { code: true, outcomeType: true, version: true } });
    const member = await prisma.entryMember.findFirstOrThrow({ where: { entryId: plan.entryId }, orderBy: { slot: "asc" }, select: { participant: { select: { publicCode: true } } } });
    const dsq = await env.tournament.chiefs[0].client.call<{ walkovers: string[]; untouched: string[] }>("POST", `/api/admin/tournaments/${env.tournament.slug}/participants/${member.participant.publicCode}/withdrawal`, {
      kind: "DISQUALIFIED",
      reason: "仿真：赛后查实冒名顶替，取消资格",
    }, { route: "/api/admin/tournaments/[slug]/participants/[publicCode]/withdrawal" });
    steps.push(`登记取消资格 ${brief(dsq)}${dsq.message ? `（${dsq.message}）` : ""}，WO ${dsq.json?.walkovers?.join("、") || "无"}，未处理 ${dsq.json?.untouched?.join("、") || "无"}`);
    const after = await prisma.match.findMany({ where: { code: { in: codes.map((row) => row.code) } }, select: { code: true, outcomeType: true, version: true } });
    const unchanged = before.every((row) => after.some((item) => item.code === row.code && item.outcomeType === row.outcomeType && item.version === row.version));
    steps.push(`已锁定的 ${codes.length} 场${unchanged ? "未改写" : "被改写"}`);
    const chief = env.tournament.chiefs[0];
    const exclude = await chief.client.call("POST", `/api/admin/tournaments/${env.tournament.slug}/competitions/${plan.competition}/groups/${plan.group}/exclusions`, { entryId: plan.entryId, action: "ADD", reason: "仿真裁判长：赛后查实冒名顶替，取消资格，本组成绩不计" }, {
      route: "/api/admin/tournaments/[slug]/competitions/[code]/groups/[group]/exclusions",
    });
    steps.push(`排除该单位 ${brief(exclude)}`);
    exclusionLogs.push({ competition: plan.competition, group: plan.group, entryId: plan.entryId, reason: "赛后取消资格", status: exclude.status, code: exclude.code, at: Date.now() });
    const locked = await waitUntil(env.registry, async () => (await prisma.match.count({ where: { code: first.code, verificationStatus: "LOCKED" } })) > 0, 2000, 5 * 60_000);
    record(env, {
      id: "6.1-dsq-retro",
      group: GROUP_61,
      title,
      expected,
      actual: `${steps.join("；")}；${first.code} 最终${locked ? "已锁定" : "未锁定"}`,
      ok: dsq.ok && unchanged && exclude.ok && Boolean(locked),
      match: first.code,
      detail: { steps },
    });
  } finally {
    env.tournament.rankingHolds.delete(key);
  }
}

/**
 * 团体某队打完第一场对抗后退出：中间几场的小场在已交名单的前提下按弃权录；最后一场不交名单——
 * 先试交一份缺一个小场的名单（预期被拒），再看小场能否载入、能否录弃权、积分榜与名次确认的表现。
 */
async function teamWithdrawProbe(env: OpsEnv) {
  const plan = env.plan.team;
  if (!plan) return;
  const { tournament, registry, context } = env;
  const teamPlan = tournament.plan.team!;
  const decided = await waitUntil(registry, async () => (await prisma.fixture.findUnique({ where: { id: plan.first }, select: { decidedAt: true } }))?.decidedAt ?? null, 3000);
  if (!decided) {
    record(env, { id: "6.1-team-withdraw", group: GROUP_61, title: "团体小组某队中途退出", expected: "—", actual: "第一场对抗没有决出", ok: "未触发" });
    return;
  }
  tournament.withdrawn.set(plan.entryId, { reason: "团体中途退出", at: Date.now() });
  context.log(`[赛务] 团体 ${plan.teamKey} 打完第一场对抗后退出`);
  const steps: string[] = [];
  // 赛务口径 W-7（GCR 16.3.7）：裁判长登记整队退出，未开始的对抗按认输结算，积分榜删除该队。
  const withdraw = await tournament.chiefs[0].client.call<{ concededFixtures: string[]; vacatedFixtures: string[]; untouched: string[] }>("POST", `/api/admin/tournaments/${tournament.slug}/entries/${plan.entryId}/withdrawal`, {
    reason: "仿真：团体打完第一场对抗后整队退出",
  }, { route: "/api/admin/tournaments/[slug]/entries/[entryId]/withdrawal" });
  steps.push(`登记整队退出 ${brief(withdraw)}${withdraw.message ? `（${withdraw.message}）` : ""}，按认输结算 ${withdraw.json?.concededFixtures?.join("、") || "无"}，未处理 ${withdraw.json?.untouched?.join("、") || "无"}`);
  const last = await prisma.fixture.findUniqueOrThrow({ where: { id: plan.last }, select: { code: true, decidedAt: true, winnerEntryId: true } });
  steps.push(`最后一场 ${last.code} ${last.decidedAt ? "已决出" : "未决出"}`);
  // 等本组其他对抗都结束（不只是决出：已决出对抗剩下的小场也要打完，积分榜才算完整），再看积分榜与名次确认。
  const others = await waitUntil(registry, async () => {
    const loaded = await loadGroupStandings(prisma, plan.groupId);
    return loaded.standings.complete ? loaded : null;
  }, 5000);
  const standings = others ?? (await loadGroupStandings(prisma, plan.groupId));
  const listed = standings.standings.rows.some((row) => row.entryId === plan.entryId);
  const confirm = await tournament.chiefs[0].client.call("POST", `/api/admin/tournaments/${tournament.slug}/competitions/${teamPlan.code}/groups/${plan.group}/ranking`, {}, {
    route: "/api/admin/tournaments/[slug]/competitions/[code]/groups/[group]/ranking",
  });
  const confirmed = Boolean((await prisma.group.findUnique({ where: { id: plan.groupId }, select: { rankingConfirmedAt: true } }))?.rankingConfirmedAt);
  steps.push(`本组对抗${others ? "已全部打完" : "到结束仍未全部打完"}；积分榜${listed ? "仍列出" : "已删除"}退出队伍（${standings.standings.rows.length} 队）；确认名次 ${brief(confirm)}${confirm.message ? `（${confirm.message}）` : ""}，本组名次${confirmed ? "已确认" : "未确认"}`);
  const middle = await prisma.match.findMany({ where: { fixtureId: { in: plan.middle } }, select: { code: true, outcomeType: true, verificationStatus: true, notPlayedAt: true } });
  steps.push(`中间对抗小场 ${middle.map((item) => `${item.code}:${item.notPlayedAt ? "未进行" : `${item.outcomeType ?? "-"}/${item.verificationStatus}`}`).join("、") || "无"}`);
  record(env, {
    id: "6.1-team-withdraw",
    group: GROUP_61,
    title: "团体小组某队中途退出",
    expected: "赛务口径 W-7：裁判长登记整队退出后，未开始的对抗按认输结算（GCR 16.3.7、16.3.8），积分榜删除该队，本组名次可以确认",
    actual: steps.join("；"),
    ok: withdraw.ok && Boolean(last.decidedAt) && !listed && confirmed,
    match: last.code,
    detail: { steps },
  });
}

// ---------------------------------------------------------------- §6.2 增补与人员变更

const GROUP_62 = "§6.2 增补与人员变更";
let extraSequence = 9000;

function extraPerson(env: OpsEnv, unit: string) {
  extraSequence += 1;
  const tag = env.context.runId.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 6);
  const given = "伟强磊军洋勇杰涛明超辉鹏华飞斌宇浩凯健俊".split("");
  return { displayName: `增补${env.rng.pick(given)}${env.rng.pick(given)}${extraSequence % 100}`, studentId: `${tag}${env.tournament.plan.key}${extraSequence}`, teamName: unit };
}

/** 批量录入并审核一批增补，返回耗时与失败。 */
async function addEntries(env: OpsEnv, code: string, count: number) {
  const competition = env.tournament.competitions.get(code)!;
  const units = [...new Set(env.tournament.roster.persons.map((person) => person.unit))];
  const started = Date.now();
  const failures: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await env.context.admin.call("POST", `/api/admin/tournaments/${env.tournament.slug}/registrations`, {
      competitionId: competition.id,
      members: [extraPerson(env, units[index % units.length])],
      note: `仿真增补 ${code}-${index + 1}`,
    }, { route: "/api/admin/tournaments/[slug]/registrations" });
    if (!result.ok) failures.push(brief(result));
  }
  const submittedMs = Date.now() - started;
  const pending = await pendingRegistrations(env.tournament.id, competition.id);
  const approveStarted = Date.now();
  const approved = await env.context.admin.call<{ results: { ok: boolean; code?: string }[] }>("POST", `/api/admin/tournaments/${env.tournament.slug}/registrations/batch-approve`, {
    items: pending.map((item) => ({ id: item.id, expectedVersion: item.version })),
  }, { route: "/api/admin/tournaments/[slug]/registrations/batch-approve" });
  const approveMs = Date.now() - approveStarted;
  const rejected = approved.json?.results?.filter((item) => !item.ok).map((item) => item.code ?? "?") ?? [brief(approved)];
  const entries = await entriesOf(competition.id);
  for (const entry of entries) competition.entryIdByKey.set(`${code}-${entry.code}`, entry.id);
  return { submittedMs, approveMs, failures, rejected, entries: entries.length };
}

/** 已发布赛程（项目外的比赛）的时间与场地快照。 */
async function publishedSnapshot(env: OpsEnv, except: string) {
  const rows = await matchesOfTournament(env.tournament.id);
  return new Map(rows.filter((row) => row.stage.competition.code !== except).map((row) => [row.code, `${row.scheduledAt?.toISOString() ?? "-"}@${row.courtId ?? "-"}`]));
}

/** 只对一个项目生成自动建议并发布；被并发延误造成的硬冲突挡住时隔一会儿再试。 */
async function scheduleCompetition(env: OpsEnv, code: string) {
  const { context, tournament } = env;
  const attempts: string[] = [];
  for (let attempt = 0; attempt < 6 && !env.registry.stop; attempt += 1) {
    const suggest = await context.admin.call<{ placed: number; unplaced: unknown[]; hardCount: number }>("POST", `/api/admin/tournaments/${tournament.slug}/schedule/suggest`, {
      competitionCode: code,
      stage: "ALL",
      notBefore: localDateTime(ceilMinute(new Date(Date.now() + 2 * 60_000))),
      assignReferees: tournament.plan.refereeMode === "PER_MATCH",
    }, { route: "/api/admin/tournaments/[slug]/schedule/suggest" });
    const workspace = await loadScheduleWorkspace(tournament.id, new Date());
    const publish = await context.admin.call<{ version: number }>("POST", `/api/admin/tournaments/${tournament.slug}/schedule/publish`, { warningDigest: (workspace as unknown as { warningDigest: string }).warningDigest, note: `仿真：${code} 抽签后排程` }, {
      route: "/api/admin/tournaments/[slug]/schedule/publish",
    });
    attempts.push(`建议排入 ${suggest.json?.placed ?? brief(suggest)}，发布 ${brief(publish)}${publish.ok ? ` 第 ${publish.json?.version} 版` : publish.message ? `（${publish.message.slice(0, 80)}）` : ""}`);
    if (publish.ok) return { ok: true, attempts };
    if (attempt === 0 && publish.code === "schedule_has_conflicts") {
      // 记下挡住发布的硬冲突：多数不是本项目造成的（例如团体名单公开后才出现的人员重叠）。
      const codeOf = new Map((await matchesOfTournament(tournament.id)).map((row) => [row.id, row.code]));
      const hard = workspace.draftCheck.issues.filter((issue) => issue.severity === "HARD");
      addFinding(context, {
        kind: "blocked",
        area: "赛程发布",
        title: `${code} 排程发布被 ${hard.length} 个硬冲突挡住（${[...new Set(hard.map((issue) => issue.code))].join("、")}）`,
        detail: { competition: code, hard: hard.slice(0, 20).map((issue) => ({ code: issue.code, matches: issue.matchIds.map((id) => codeOf.get(id) ?? id), involvesThisCompetition: issue.matchIds.some((id) => codeOf.get(id)?.includes(`-${code}-`)) })) },
      });
    }
    await sleep(20_000);
  }
  return { ok: false, attempts };
}

/** 抽签发布后立即把本项目的比赛设为暂缓开赛，直到排程发布（撤销重抽要求本项目没有任何比赛开始）。 */
async function drawHeld(env: OpsEnv, code: string) {
  const competition = env.tournament.competitions.get(code)!;
  const published = await drawCompetition(env.context, env.tournament, code, { format: "KNOCKOUT", thirdPlaceMatch: false });
  const codes = (await prisma.match.findMany({ where: { stage: { competitionId: competition.id } }, select: { code: true } })).map((row) => row.code);
  for (const item of codes) env.tournament.heldMatches.add(item);
  return { published, codes };
}

function release(env: OpsEnv, codes: string[]) {
  for (const code of codes) env.tournament.heldMatches.delete(code);
}

async function registrationProbes(env: OpsEnv) {
  const { context, tournament } = env;
  const ms2 = tournament.competitions.get("MS2");
  if (!ms2) return;

  // 1 截止后、抽签前增补 12 人。
  const added = await addEntries(env, "MS2", 12);
  record(env, {
    id: "6.2-after-close",
    group: GROUP_62,
    title: "报名截止后、抽签前增补（12 人）",
    expected: "赛事处于「报名截止」时管理员仍可录入并审核；项目未抽签所以不锁定",
    actual: `录入 ${12 - added.failures.length}/12（${Math.round(added.submittedMs / 100) / 10} 秒），批量审核 ${added.rejected.length ? `失败 ${added.rejected.join("、")}` : "全部通过"}（${Math.round(added.approveMs / 100) / 10} 秒），项目报名单位 ${added.entries}`,
    ok: added.failures.length === 0 && added.rejected.length === 0 && added.entries === 12,
  });

  // 2 同一项目同一学号、换个单位再报一次。
  const ms2Members = await entriesOf(ms2.id);
  const sample = ms2Members[0]?.members[0]?.participant;
  const sampleRow = sample ? await prisma.participant.findUnique({ where: { id: sample.id }, select: { displayName: true, studentId: true, teamName: true } }) : null;
  if (sampleRow?.studentId) {
    const dup = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/registrations`, {
      competitionId: ms2.id,
      members: [{ displayName: sampleRow.displayName, studentId: sampleRow.studentId, teamName: "另一学院" }],
      note: "仿真：同一学号换单位重复报名",
    }, { route: "/api/admin/tournaments/[slug]/registrations" });
    record(env, {
      id: "6.2-dup-same-event",
      group: GROUP_62,
      title: "同一人以另一单位在同一项目重复报名",
      expected: "同一项目内按学号硬去重，409",
      actual: `${brief(dup)}${dup.message ? `（${dup.message}）` : ""}`,
      ok: dup.status === 409,
    });
  }

  // 3 跨项目：MS 的一名选手以另一单位报 MS2（同名同学号）。
  const msEntries = await entriesOf(tournament.competitions.get("MS")!.id);
  const crossId = msEntries.find((entry) => !tournament.withdrawn.has(entry.id))?.members[0]?.participant.id;
  let crossApproved = 0;
  const cross = crossId ? await prisma.participant.findUnique({ where: { id: crossId }, select: { displayName: true, studentId: true, teamName: true, publicCode: true } }) : null;
  if (cross?.studentId) {
    const units = [...new Set(tournament.roster.persons.map((person) => person.unit))];
    const otherUnit = units.find((unit) => unit !== cross.teamName) ?? "另一学院";
    const created = await context.admin.call<{ id: string }>("POST", `/api/admin/tournaments/${tournament.slug}/registrations`, {
      competitionId: ms2.id,
      members: [{ displayName: cross.displayName, studentId: cross.studentId, teamName: otherUnit }],
      note: "仿真：跨项目同一学号、换单位",
    }, { route: "/api/admin/tournaments/[slug]/registrations" });
    let review: CallResult | null = null;
    let rejected: CallResult | null = null;
    if (created.ok) {
      const pending = (await pendingRegistrations(tournament.id, ms2.id))[0];
      if (pending) {
        review = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/registrations/${pending.id}/review`, { action: "APPROVE", expectedVersion: pending.version }, {
          route: "/api/admin/tournaments/[slug]/registrations/[registrationId]/review",
        });
        // 赛务口径 E-1：审核被拒（409 unit_mismatch）后报名仍待审核，管理员按现场做法驳回，免得挡住后面的抽签发布。
        if (!review.ok) {
          rejected = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/registrations/${pending.id}/review`, { action: "REJECT", expectedVersion: pending.version, reason: "同一学号已代表其他单位参赛" }, {
            route: "/api/admin/tournaments/[slug]/registrations/[registrationId]/review",
          });
        }
      }
    }
    if (review?.ok) crossApproved = 1;
    const after = await prisma.participant.findUnique({ where: { id: crossId! }, select: { teamName: true } });
    record(env, {
      id: "6.2-dup-cross-unit",
      group: GROUP_62,
      title: "同一学号跨项目以不同单位报名",
      expected: "赛务口径 E-1：同一学号在一个赛事里只能代表一个单位，审核 409 unit_mismatch，参赛者单位不变；驳回后不挡抽签",
      actual: `录入 ${brief(created)}${created.message ? `（${created.message}）` : ""}；审核 ${review ? `${brief(review)}${review.message ? `（${review.message}）` : ""}` : "-"}；驳回 ${rejected ? brief(rejected) : "-"}；参赛者单位 ${cross.teamName} → ${after?.teamName}`,
      ok: review?.status === 409 && review.code === "unit_mismatch" && Boolean(rejected?.ok) && after?.teamName === cross.teamName,
    });
  }

  // 4 已抽签项目增补。
  const locked = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/registrations`, {
    competitionId: tournament.competitions.get("MS")!.id,
    members: [extraPerson(env, "数学科学学院")],
    note: "仿真：抽签发布后增补",
  }, { route: "/api/admin/tournaments/[slug]/registrations" });
  record(env, {
    id: "6.2-after-draw",
    group: GROUP_62,
    title: "抽签发布后增补",
    expected: "409 competition_locked",
    actual: `${brief(locked)}${locked.message ? `（${locked.message}）` : ""}`,
    ok: locked.status === 409 && locked.code === "competition_locked",
  });

  // 5 抽签 → 撤销 → 再补 2 人 → 重抽 → 只排本项目 → 发布；核对其他项目的已发布安排不变。
  const firstDraw = await drawHeld(env, "MS2");
  const revoke = await tournament.chiefs[0].client.call("POST", `/api/admin/tournaments/${tournament.slug}/competitions/MS2/draws/revoke`, { reason: "仿真：漏报两人，撤销重抽" }, {
    route: "/api/admin/tournaments/[slug]/competitions/[code]/draws/revoke",
  });
  release(env, firstDraw.codes);
  const more = await addEntries(env, "MS2", 2);
  const before = await publishedSnapshot(env, "MS2");
  const second = await drawHeld(env, "MS2");
  // 连续弃权：选一个第一轮有对手的选手，之后每一轮（含决赛）对手都弃权。
  const fixtures = await fixturesOf(ms2.id);
  const opener = fixtures.find((fixture) => fixture.round === 1 && fixture.sideAEntryId && fixture.sideBEntryId);
  const lucky = opener?.sideAEntryId ?? null;
  if (lucky) {
    tournament.hookedEntries.add(lucky);
    tournament.specialHooks.push((match) => {
      if (match.competitionCode !== "MS2" || (match.sideAEntryId !== lucky && match.sideBEntryId !== lucky)) return null;
      const side: Side = match.sideAEntryId === lucky ? "B" : "A";
      return { type: "WO", loser: side, at: null, reason: "仿真：对手未到场弃权" };
    });
  }
  const scheduled = await scheduleCompetition(env, "MS2");
  const after = await publishedSnapshot(env, "MS2");
  const moved = [...before].filter(([code, value]) => after.has(code) && after.get(code) !== value);
  // 只比较两次快照之间没有开赛的比赛：开赛不改计划时间，但现场改期（D6）会改。
  release(env, second.codes);
  record(env, {
    id: "6.2-revoke-redraw",
    group: GROUP_62,
    title: "撤销抽签 → 增补 → 重新抽签与排程",
    expected: "未开赛时裁判长可撤销；撤销后可补报并重抽；只对本项目排程并发布，其他项目已发布的安排不被改动",
    actual: `首次抽签 ${firstDraw.published.matches} 场；撤销 ${brief(revoke)}；再补 2 人 ${more.failures.length || more.rejected.length ? "有失败" : "通过"}（共 ${more.entries}）；重抽 ${second.published.matches} 场（${second.published.fixtures} 个对阵）；排程 ${scheduled.attempts.join(" / ")}；其他项目被改动 ${moved.length} 场${moved.length ? `：${moved.slice(0, 5).map(([code]) => code).join("、")}` : ""}`,
    ok: revoke.ok && scheduled.ok && moved.length === 0 && more.entries === 14 + crossApproved,
    detail: { moved: moved.slice(0, 20) },
  });
  if (lucky) await consecutiveWoProbe(env, lucky);
}

/** 连续弃权：该选手每一轮的对手都弃权，一直到决赛（§6.1 连续弃权、§6.4 决赛弃权、非 2 次幂签位）。 */
async function consecutiveWoProbe(env: OpsEnv, entryId: string) {
  const ms2 = env.tournament.competitions.get("MS2")!;
  const final = await waitUntil(env.registry, async () => {
    const rows = await prisma.match.findMany({ where: { stage: { competitionId: ms2.id } }, select: { code: true, verificationStatus: true, notPlayedAt: true, outcomeType: true, sideAEntryId: true, sideBEntryId: true, fixture: { select: { round: true, kind: true } } } });
    const maxRound = Math.max(...rows.map((row) => row.fixture?.round ?? 0));
    const last = rows.find((row) => row.fixture?.round === maxRound);
    return last?.verificationStatus === "LOCKED" ? rows : null;
  }, 5000);
  const title = "连续弃权一路到冠军（含决赛弃权、非 2 次幂签位）";
  const expected = "每轮对手 WO 后由复核锁定推进；该选手不打一分进入下一轮，决赛对手弃权仍正常产生冠亚军";
  if (!final) {
    record(env, { id: "6.1-consecutive-wo", group: GROUP_61, title, expected, actual: "运行结束前决赛没有锁定", ok: "未触发" });
    return;
  }
  const mine = final.filter((row) => row.sideAEntryId === entryId || row.sideBEntryId === entryId).sort((a, b) => (a.fixture?.round ?? 0) - (b.fixture?.round ?? 0));
  const maxRound = Math.max(...final.map((row) => row.fixture?.round ?? 0));
  const results = await prisma.competition.findUnique({ where: { id: ms2.id }, select: { entries: { where: { id: entryId }, select: { code: true } } } });
  record(env, {
    id: "6.1-consecutive-wo",
    group: GROUP_61,
    title,
    expected,
    actual: `签表 ${final.length} 场、${maxRound} 轮；该选手（${results?.entries[0]?.code ?? entryId.slice(0, 8)}）各轮 ${mine.map((row) => `R${row.fixture?.round}:${row.outcomeType ?? "NORMAL"}`).join("、")}；${mine.some((row) => row.fixture?.round === maxRound) ? "进入决赛" : "没有进入决赛"}`,
    ok: mine.length > 0 && mine.every((row) => row.outcomeType === "WO") && mine.some((row) => row.fixture?.round === maxRound),
  });
}

/** 抽签后更正姓名：成绩跟随同一参赛者，公开页、历史比赛都显示新名。 */
async function renameProbe(env: OpsEnv) {
  const { tournament, registry, context } = env;
  const ms = tournament.competitions.get("MS");
  if (!ms) return;
  const target = await waitUntil(registry, async () => {
    const row = await prisma.match.findFirst({
      where: { stage: { competitionId: ms.id }, verificationStatus: "LOCKED", OR: [{ outcomeType: null }, { outcomeType: "NORMAL" }], sideAEntryId: { not: null } },
      select: { code: true, sideAEntry: { select: { id: true, members: { select: { participant: { select: { publicCode: true, displayName: true } } } } } } },
    });
    return row?.sideAEntry ? row : null;
  }, 5000);
  if (!target) return;
  const person = target.sideAEntry!.members[0].participant;
  const name = `${person.displayName}更`;
  const renamed = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/participants/${person.publicCode}/rename`, { displayName: name, reason: "仿真：报名时姓名录错" }, {
    route: "/api/admin/tournaments/[slug]/participants/[code]/rename",
  });
  const shown = await publicMatch(env, target.code);
  const text = JSON.stringify(shown.json?.match?.sideA ?? "");
  const schedule = await context.admin.call("GET", `/api/public/tournaments/${tournament.slug}/schedule`, undefined, { route: "/api/public/tournaments/[slug]/schedule" });
  const scheduleText = JSON.stringify(schedule.json ?? "");
  record(env, {
    id: "6.2-rename",
    group: GROUP_62,
    title: "抽签后更正姓名",
    expected: "改名成功；成绩跟随同一参赛者；已结束比赛的公开详情与公开赛程都显示新名、不再出现旧名",
    actual: `改名 ${brief(renamed)}；已锁定的 ${target.code} 公开详情${text.includes(name) ? "显示新名" : "未显示新名"}；公开赛程${scheduleText.includes(name) ? "出现新名" : "未出现新名"}${scheduleText.includes(`"${person.displayName}"`) || scheduleText.includes(`${person.displayName} /`) || scheduleText.includes(`/ ${person.displayName}`) ? "，仍有旧名" : ""}`,
    ok: renamed.ok && text.includes(name),
    match: target.code,
  });
}

// ---------------------------------------------------------------- §6.6 现场赛务

const GROUP_66 = "§6.6 现场赛务";

async function onsiteProbes(env: OpsEnv) {
  await Promise.all([pauseProbe(env, "6.6-pause"), nextDayProbe(env), wrongMatchProbe(env), returnedProbe(env), postponeProbe(env)]);
  record(env, { id: "6.6-cancel", group: GROUP_66, title: "取消比赛", expected: "「取消比赛」流程未实现", actual: "没有对应接口，未测", ok: "不可测" });
}

/**
 * 场地临时不可用：暂停 → 关闭场地 → 裁判长转到一块空场地（赛务口径 S-5）→ 看公开页 → 重新开放原场地并转回 → 恢复，比分不丢。
 * 转回原场地是为了不和仿真在那块空场地上排的比赛撞场（判定按比赛最终所在场地检查不重叠）。
 */
async function pauseProbe(env: OpsEnv, id: string) {
  const { context, tournament } = env;
  const steps: string[] = [];
  let kept = false;
  let courtShown: string | null = null;
  let courtName: string | null = null;
  const transfer: { ok: boolean; back: boolean; target: string | null; upcoming: string[]; attempts: string[] } = { ok: false, back: false, target: null, upcoming: [], attempts: [] };
  await withBorrowed(env, `§6.6 暂停与关闭场地（${id}）`, async (borrowed) => {
    const d = driver(env, borrowed, env.tablets[0]);
    if (!(await d.acquire()).ok) return null;
    await toRally(d, 4);
    const before = { ...d.state!.score, game: d.state!.currentGame };
    const pause = await d.send("PAUSE_MATCH", { reason: "仿真：场地灯光故障，暂停" });
    const court = await prisma.court.findUnique({ where: { id: borrowed.courtId }, select: { code: true, name: true } });
    courtName = court?.name ?? null;
    const closed = court ? await context.admin.call<{ affectedPublishedMatches: number }>("PATCH", `/api/admin/tournaments/${tournament.slug}/schedule/courts/${court.code}`, { active: false }, { route: "/api/admin/tournaments/[slug]/schedule/courts/[courtCode]" }) : null;
    steps.push(`暂停 ${brief(pause)}；关闭${court?.name ?? "场地"} ${closed ? `${brief(closed)}（受影响的已发布比赛 ${closed.json?.affectedPublishedMatches ?? "?"}）` : "-"}`);
    const chief = tournament.chiefs[0].client;
    const transferRoute = { route: "/api/admin/tournaments/[slug]/schedule/matches/[matchCode]/court" };
    const busy = new Set((await prisma.match.findMany({ where: { courtId: { not: null }, lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] }, stage: { competition: { tournament: { slug: tournament.slug } } } }, select: { courtId: true } })).map((row) => row.courtId));
    const free = (await prisma.court.findMany({ where: { tournament: { slug: tournament.slug }, active: true, id: { not: borrowed.courtId } }, select: { id: true, code: true, name: true }, orderBy: { sortOrder: "asc" } })).filter((item) => !busy.has(item.id));
    for (const target of free) {
      const moved = await chief.call<{ toCourt: string; upcoming: { code: string }[] }>("POST", `/api/admin/tournaments/${tournament.slug}/schedule/matches/${borrowed.code}/court`, { courtCode: target.code, reason: "仿真：场地灯光故障，转场" }, transferRoute);
      transfer.attempts.push(`${target.code} ${brief(moved)}`);
      if (moved.status === 409 && moved.code === "court_busy") continue;
      transfer.ok = moved.ok;
      transfer.upcoming = moved.json?.upcoming?.map((item) => item.code) ?? [];
      transfer.target = target.name;
      break;
    }
    // 公开查询有 2 秒共享缓存（SF-06），等缓存过期再看。
    await sleep(3000);
    const shown = await publicMatch(env, borrowed.code);
    courtShown = shown.json?.match?.court ?? null;
    steps.push(`转场 ${transfer.attempts.join(" / ") || "没有空场地"}；公开页场地「${courtShown ?? "-"}」、状态 ${shown.json?.match?.lifecycle ?? "-"}`);
    if (court && transfer.ok) {
      const reopened = await context.admin.call("PATCH", `/api/admin/tournaments/${tournament.slug}/schedule/courts/${court.code}`, { active: true }, { route: "/api/admin/tournaments/[slug]/schedule/courts/[courtCode]" });
      const back = await chief.call("POST", `/api/admin/tournaments/${tournament.slug}/schedule/matches/${borrowed.code}/court`, { courtCode: court.code, reason: "仿真：原场地修复，转回" }, transferRoute);
      transfer.back = back.ok;
      steps.push(`重新开放原场地 ${brief(reopened)}，转回 ${brief(back)}${back.message ? `（${back.message}）` : ""}`);
    }
    await context.clock.wait(10 * 60);
    await d.heartbeatIfDue(true);
    const resume = await d.send("RESUME_MATCH", { reason: "仿真：换到备用场地继续（系统内仍是原场地）" });
    kept = d.state?.score.A === before.A && d.state?.score.B === before.B && d.state?.currentGame === before.game;
    steps.push(`恢复 ${brief(resume)}，比分 ${before.A}:${before.B} → ${d.state?.score.A}:${d.state?.score.B}`);
    if (court && !transfer.ok) {
      const reopened = await context.admin.call("PATCH", `/api/admin/tournaments/${tournament.slug}/schedule/courts/${court.code}`, { active: true }, { route: "/api/admin/tournaments/[slug]/schedule/courts/[courtCode]" });
      steps.push(`重新开放 ${brief(reopened)}`);
    }
    return d.play();
  });
  if (!steps.length) return;
  record(env, { id, group: GROUP_66, title: "场地临时不可用：暂停后恢复", expected: "暂停 / 恢复不丢分", actual: steps.join("；"), ok: kept });
  record(env, {
    id: `${id}-transfer`,
    group: GROUP_66,
    title: "比赛转到另一块场地继续",
    expected: "赛务口径 S-5：暂停中的比赛由裁判长转到启用且空着的场地，公开页显示新场地；比分不变；目标场地后续排定如实列出",
    actual: `转到 ${transfer.target ?? "-"}（原场地 ${courtName ?? "-"}）${transfer.ok ? "成功" : "失败"}，公开页显示「${courtShown ?? "-"}」，目标场地后续排定 ${transfer.upcoming.join("、") || "无"}；转回原场地${transfer.back ? "成功" : "失败"}`,
    ok: transfer.ok ? courtShown === transfer.target && transfer.back : "未触发",
  });
}

/** 中断后改到次日续赛：暂停 → 释放 → 等租约过期 → 换一台设备重新取得 → 恢复，计划时间与开始时间不变。 */
async function nextDayProbe(env: OpsEnv) {
  const steps: string[] = [];
  let ok = false;
  await withBorrowed(env, "§6.6 次日续赛", async (borrowed) => {
    const d = driver(env, borrowed, env.tablets[0]);
    if (!(await d.acquire()).ok) return null;
    await toRally(d, 6);
    const before = await matchByCode(borrowed.code);
    const score = { ...d.state!.score };
    const pause = await d.send("PAUSE_MATCH", { reason: "仿真：天色已晚，改到次日续赛" });
    await d.release();
    steps.push(`暂停 ${brief(pause)} 并释放，等 130 秒（租约 2 分钟）`);
    await sleep(130_000);
    const next = driver(env, borrowed, env.tablets[1]);
    const acquired = await next.acquire();
    await next.refresh();
    const phase = next.state?.phase;
    const resume = await next.send("RESUME_MATCH", { reason: "仿真：次日续赛" });
    const after = await matchByCode(borrowed.code);
    ok = acquired.ok && phase === "PAUSED" && resume.ok && next.state?.score.A === score.A && next.state?.score.B === score.B && after?.startedAt?.getTime() === before?.startedAt?.getTime() && after?.scheduledAt?.getTime() === before?.scheduledAt?.getTime();
    steps.push(`次日新设备取得 ${brief(acquired)}，相位 ${phase}，恢复 ${brief(resume)}，比分 ${score.A}:${score.B} → ${next.state?.score.A}:${next.state?.score.B}；开始时间${after?.startedAt?.getTime() === before?.startedAt?.getTime() ? "不变" : "变了"}，计划时间${after?.scheduledAt?.getTime() === before?.scheduledAt?.getTime() ? "不变（冻结）" : "变了"}`);
    return next.play();
  });
  if (!steps.length) return;
  record(env, { id: "6.6-next-day", group: GROUP_66, title: "中断后改到次日续赛", expected: "暂停可跨天保持；租约过期后重新取得控制即可接续，比分不丢；计划时间被冻结（跨天赛程显示未定义）", actual: steps.join("；"), ok });
}

/** 打开错场并记了几分：裁判长作废本场计分（赛务口径 S-7），比赛回到抛币前、开始时间清除；之后照常从抛币打完。 */
async function wrongMatchProbe(env: OpsEnv) {
  const steps: string[] = [];
  const voidOutcome = { ok: false };
  await withBorrowed(env, "§6.6 打开错场", async (borrowed) => {
    const d = driver(env, borrowed, env.tablets[0]);
    if (!(await d.acquire()).ok) return null;
    await toRally(d, 0);
    for (let index = 0; index < 3; index += 1) await d.send("RALLY_WON", { side: index % 2 ? "A" : "B" });
    const scored = { ...d.state!.score };
    const voided = await asChief(env, borrowed.code, "仿真：打开错场，作废本场计分", (send) => send("VOID_MATCH_SCORING", { reason: "仿真：打开错场，作废本场计分" }));
    const result = voided.value;
    await sleep(3000);
    const row = await matchByCode(borrowed.code);
    const shown = await publicMatch(env, borrowed.code);
    voidOutcome.ok = Boolean(result?.ok) && row?.startedAt === null && (row?.lifecycleStatus === "READY" || row?.lifecycleStatus === "SCHEDULED");
    steps.push(`记了 ${scored.A}:${scored.B}，裁判长接管 ${brief(voided.takeover)}，作废 ${result ? brief(result) : "-"}${result?.message ? `（${result.message}）` : ""}；之后相位 ${result?.json?.state?.phase ?? "-"}，版本 ${row?.version}，开始时间${row?.startedAt ? "仍在" : "已清除"}，状态 ${row?.lifecycleStatus}；公开页 ${shown.json?.match?.lifecycle ?? brief(shown)}`);
    // 裁判重新取得控制，从抛币开始打本场。
    const again = await d.acquire();
    await d.refresh();
    steps.push(`裁判重新取得 ${brief(again)}，相位 ${d.state?.phase}`);
    // 现场随后在这块场地上打本该打的比赛；这里把这场接着正常打完，免得场地被一场「进行中」占住。
    return d.play();
  });
  if (!steps.length) return;
  record(env, { id: "6.6-wrong-match", group: GROUP_66, title: "打开错场并记了几分", expected: "赛务口径 S-7：第一局结束前裁判长作废本场计分，回到抛币前、开始时间清除、历史事件保留；裁判重新取得控制后照常打完", actual: steps.join("；"), ok: voidOutcome.ok });
}

/** 提交后复核驳回：裁判长从待复核退回，修订标为退回，裁判重新提交后复核锁定。 */
async function returnedProbe(env: OpsEnv) {
  const steps: string[] = [];
  let code: string | null = null;
  await withBorrowed(env, "§6.6 复核驳回", async (borrowed) => {
    code = borrowed.code;
    env.tournament.reviewHoldUntil.set(borrowed.code, Date.now() + 30 * 60_000);
    const d = driver(env, borrowed, env.tablets[0]);
    if (!(await d.acquire()).ok) return null;
    const first = await d.play();
    if (first.outcome !== "submitted") return first;
    const reopened = await asChief(env, borrowed.code, "仿真：复核发现第二局比分有误，退回", async (send) => send("REOPEN_RESULT", { reason: "仿真：复核驳回，请裁判核对后重交" }));
    const revisions = (await matchByCode(borrowed.code))?.resultRevisions ?? [];
    steps.push(`第一次提交后裁判长退回 ${reopened.value ? brief(reopened.value) : brief(reopened.takeover)}，修订 ${revisions.map((item) => `r${item.revision}:${item.status}`).join(" ")}`);
    const again = driver(env, borrowed, env.tablets[1]);
    if (!(await again.acquire()).ok) return first;
    await again.refresh();
    steps.push(`裁判重新取得，相位 ${again.state?.phase}`);
    return again.play();
  });
  if (!code) return;
  env.tournament.reviewHoldUntil.delete(code);
  const locked = await waitUntil(env.registry, async () => {
    const row = await matchByCode(code!);
    return row?.verificationStatus === "LOCKED" ? row : null;
  });
  const revisions = locked?.resultRevisions ?? [];
  steps.push(`最终 ${locked ? "已锁定" : "未锁定"}，修订 ${revisions.map((item) => `r${item.revision}:${item.status}`).join(" ")}`);
  record(env, {
    id: "6.6-returned",
    group: GROUP_66,
    title: "提交后复核驳回",
    expected: "REOPEN_RESULT 从待复核退回（修订标 RETURNED），裁判重新提交后复核锁定",
    actual: steps.join("；"),
    ok: Boolean(locked) && revisions.some((item) => item.status === "RETURNED"),
    match: code,
  });
}

/** 某场地后半段整体推迟：该场地尚未开始的已发布比赛统一后移，重新发布新版本；已开始的比赛不动。 */
async function postponeProbe(env: OpsEnv) {
  const { context, tournament, registry } = env;
  // 等现场跑起来（约 20% 锁定）再做，避免与开赛前的首轮安排纠缠。
  const ready = await waitUntil(registry, async () => {
    const rows = await matchesOfTournament(tournament.id);
    return rows.filter((row) => row.verificationStatus === "LOCKED").length >= rows.length * 0.2 ? rows : null;
  }, 5000);
  if (!ready) return;
  const shift = context.clock.ms(20 * 60);
  const horizon = Date.now() + context.clock.ms(15 * 60);
  const workspace = await loadScheduleWorkspace(tournament.id, new Date());
  const byCourt = new Map<string, typeof workspace.publishedRows>();
  for (const row of workspace.publishedRows) {
    const match = ready.find((item) => item.code === row.code);
    if (!row.movable || !match || !["SCHEDULED", "READY"].includes(match.lifecycleStatus) || !match.scheduledAt || match.scheduledAt.getTime() < horizon || tournament.heldMatches.has(row.code)) continue;
    const list = byCourt.get(row.published.courtId!) ?? [];
    list.push(row);
    byCourt.set(row.published.courtId!, list);
  }
  const [courtId, rows] = [...byCourt.entries()].sort((left, right) => right[1].length - left[1].length)[0] ?? [null, []];
  if (!courtId || !rows.length) {
    record(env, { id: "6.6-postpone", group: GROUP_66, title: "某场地后半段整体推迟并重新发布", expected: "—", actual: "没有找到可推迟的场地时段", ok: "未触发" });
    return;
  }
  const started = new Set(ready.filter((row) => row.startedAt).map((row) => `${row.code}:${row.scheduledAt?.toISOString()}`));
  const hardOf = (issues: typeof workspace.draftCheck.issues) => issues.filter((issue) => issue.severity === "HARD");
  const baselineHard = hardOf(workspace.draftCheck.issues);
  const patched: string[] = [];
  const postpone = async (list: typeof rows) => {
    for (const row of [...list].sort((left, right) => new Date(right.published.start!).getTime() - new Date(left.published.start!).getTime())) {
      const start = new Date(new Date(row.published.start!).getTime() + shift);
      const result = await context.admin.call("PATCH", `/api/admin/tournaments/${tournament.slug}/schedule/slots/${row.code}`, {
        courtCode: row.published.courtCode,
        start: localDateTime(ceilMinute(start)).slice(0, 16),
        durationMinutes: row.published.durationMinutes,
        refereeUserId: row.published.refereeId ?? null,
        estimated: row.published.estimated,
      }, { route: "/api/admin/tournaments/[slug]/schedule/slots/[matchCode]" });
      patched.push(`${row.code} ${brief(result)}`);
    }
  };
  await postpone(rows);
  const baselineKeys = new Set(baselineHard.map((issue) => issue.key));
  const codeOf = new Map(ready.map((row) => [row.id, row.code]));
  // 管理员推迟一块场地时，排在别的场地的下一轮会落到上一轮结束之前（DEPENDENCY_ORDER）；
  // 现实里会把这些下游比赛一并顺延，这里同样处理，最多三轮。
  const movedCodes = new Set(rows.map((row) => row.code));
  const cascaded: string[] = [];
  let after = await loadScheduleWorkspace(tournament.id, new Date());
  for (let round = 0; round < 3; round += 1) {
    const dependents = new Set(
      hardOf(after.draftCheck.issues)
        .filter((issue) => issue.code === "DEPENDENCY_ORDER" && !baselineKeys.has(issue.key))
        .flatMap((issue) => issue.matchIds.map((id) => codeOf.get(id)).filter((code): code is string => Boolean(code) && !movedCodes.has(code!))),
    );
    const next = after.publishedRows.filter((row) => dependents.has(row.code) && row.movable && row.published.start);
    if (!next.length) break;
    await postpone(next);
    for (const row of next) {
      movedCodes.add(row.code);
      cascaded.push(row.code);
    }
    after = await loadScheduleWorkspace(tournament.id, new Date());
  }
  const added = hardOf(after.draftCheck.issues).filter((issue) => !baselineKeys.has(issue.key));
  const publish = await context.admin.call<{ version: number }>("POST", `/api/admin/tournaments/${tournament.slug}/schedule/publish`, { warningDigest: (after as unknown as { warningDigest: string }).warningDigest, note: "仿真：场地后半段整体推迟" }, {
    route: "/api/admin/tournaments/[slug]/schedule/publish",
  });
  const rowsAfter = await matchesOfTournament(tournament.id);
  const startedMoved = rowsAfter.filter((row) => row.startedAt && ready.find((item) => item.code === row.code)?.startedAt && !started.has(`${row.code}:${row.scheduledAt?.toISOString()}`));
  const moved = rows.filter((row) => rowsAfter.find((item) => item.code === row.code)?.scheduledAt?.getTime() !== new Date(row.published.start!).getTime()).length;
  if (!publish.ok) {
    // 草稿改动没有发布：撤销本次草稿，免得挡住之后的发布。
    await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/schedule/discard`, {}, { route: "/api/admin/tournaments/[slug]/schedule/discard" });
  }
  record(env, {
    id: "6.6-postpone",
    group: GROUP_66,
    title: "某场地后半段整体推迟并重新发布",
    expected: "未开始的比赛可改草稿再发布新版本（下游比赛一并顺延）；已开始的比赛不动",
    actual: `推迟 ${rows.length} 场（现实 20 分钟）${cascaded.length ? `，另顺延下游 ${cascaded.length} 场（${cascaded.slice(0, 4).join("、")}${cascaded.length > 4 ? " 等" : ""}）` : ""}：${patched.filter((item) => !item.endsWith(" 200")).slice(0, 3).join("、") || "草稿全部成功"}；发布 ${brief(publish)}${publish.ok ? ` 第 ${publish.json?.version} 版` : publish.message ? `（${publish.message.slice(0, 120)}）` : ""}；改动前已有硬冲突 ${baselineHard.length} 个（${[...new Set(baselineHard.map((issue) => issue.code))].join("、") || "无"}），推迟新增 ${added.length} 个（${[...new Set(added.map((issue) => issue.code))].join("、") || "无"}）；实际后移 ${moved} 场；已开始比赛计划时间被改 ${startedMoved.length} 场`,
    // 顺延下游后仍有推迟造成的新冲突（例如同一选手在别的场地）：系统拒绝是对的，但没有自动顺延的工具＝设计未定义。
    ok: publish.ok ? moved === rows.length && startedMoved.length === 0 : added.length > 0 || baselineHard.length > 0 ? "设计未定义" : false,
    detail: { patched, cascaded, baselineHard: baselineHard.slice(0, 20).map((issue) => ({ code: issue.code, matches: issue.matchIds.map((id) => codeOf.get(id) ?? id) })), addedHard: added.slice(0, 20).map((issue) => ({ code: issue.code, matches: issue.matchIds.map((id) => codeOf.get(id) ?? id) })) },
  });
}

// ---------------------------------------------------------------- §6.7 组合压力时段

/**
 * 约 40% 比赛锁定后，在现实 30 分钟（经压缩时钟）的窗口里同时发生：某学院整体退出（个人项目各场弃权，团体整队退出）、
 * 另一项目临时增补 30 人并抽签排程、两块场地暂停后「转场」、§7 命令与会话注入。延误链只在 C3 档构造，这里不叠加。
 * 窗口结束后的一致性由运行结束时的判定负责（数据一致、无人同时两场、所有比赛有去向、名次与独立重算一致）。
 */
async function chaosWindow(env: OpsEnv) {
  const { context, tournament, registry } = env;
  const ready = await waitUntil(registry, async () => {
    const rows = await matchesOfTournament(tournament.id);
    return rows.filter((row) => row.verificationStatus === "LOCKED" || row.notPlayedAt).length >= rows.length * 0.4 ? rows : null;
  }, 5000);
  if (!ready) return;
  const windowMs = context.clock.ms(30 * 60);
  const startedAt = Date.now();
  context.log(`[赛务] 组合压力窗口开始（${Math.round(windowMs / 1000)} 秒墙钟）`);

  // 选退出的学院：未开始比赛里出现最多、且不是团体中途退出那一队的学院。
  const planned = new Set([...tournament.withdrawn.keys(), env.plan.groupWithdraw?.entryId, env.plan.dsq?.entryId].filter(Boolean) as string[]);
  const units = new Map<string, string[]>();
  for (const [code, list] of tournament.roster.entries) {
    const competition = tournament.competitions.get(code);
    if (!competition) continue;
    for (const entry of list) {
      const id = competition.entryIdByKey.get(entry.key);
      if (!id || planned.has(id)) continue;
      units.set(entry.unit, [...(units.get(entry.unit) ?? []), id]);
    }
  }
  const teamUnit = tournament.teams.find((team) => team.entryId === env.plan.team?.entryId);
  // 避开强制同分（M3）涉及的学院：退出会破坏事先构造的并列。
  const forcedRows = await prisma.match.findMany({ where: { code: { in: [...tournament.forced.keys()] } }, select: { sideAEntryId: true, sideBEntryId: true } });
  const forcedEntries = new Set(forcedRows.flatMap((row) => [row.sideAEntryId, row.sideBEntryId]).filter(Boolean) as string[]);
  const unitOfTeamEntry = new Map(tournament.teams.map((team) => [team.entryId, tournament.roster.teams.find((plannedTeam) => plannedTeam.key === team.key)?.unit]));
  const tainted = new Set<string>();
  for (const [name, ids] of units) if (ids.some((id) => forcedEntries.has(id))) tainted.add(name);
  for (const id of forcedEntries) if (unitOfTeamEntry.get(id)) tainted.add(unitOfTeamEntry.get(id)!);
  const unit = [...units.entries()]
    .filter(([name]) => tournament.roster.teams.find((team) => team.key === teamUnit?.key)?.unit !== name && !tainted.has(name))
    .sort((left, right) => right[1].length - left[1].length)[0];
  env.plan.chaosUnit = unit?.[0] ?? null;
  const actions: string[] = [];
  if (unit) {
    for (const id of unit[1]) tournament.withdrawn.set(id, { reason: `${unit[0]}整体退出`, at: Date.now() });
    const team = tournament.teams.find((item) => tournament.roster.teams.find((plannedTeam) => plannedTeam.key === item.key)?.unit === unit[0]);
    if (team?.entryId) tournament.withdrawn.set(team.entryId, { reason: `${unit[0]}整体退出`, at: Date.now() });
    for (const competition of tournament.competitions.values()) {
      if (!tournament.expectedStuck.has(competition.code) && !["MS2", "MS3"].includes(competition.code)) {
        tournament.expectedStuck.set(competition.code, `${unit[0]}整体退出：小组剩余人数可能少于出线名额、团体积分榜无法排除（§6.7）`);
      }
    }
    actions.push(`${unit[0]} 退出：个人报名单位 ${unit[1].length} 个${team ? `，团体 ${team.key}` : ""}`);
  }

  const [additions, pauses] = await Promise.all([
    (async () => {
      if (!tournament.competitions.get("MS3")) return "无 MS3";
      const before = await publishedSnapshot(env, "MS3");
      const added = await addEntries(env, "MS3", 30);
      const drawn = await drawHeld(env, "MS3");
      const scheduled = await scheduleCompetition(env, "MS3");
      release(env, drawn.codes);
      const after = await publishedSnapshot(env, "MS3");
      const moved = [...before].filter(([code, value]) => after.has(code) && after.get(code) !== value).length;
      record(env, {
        id: "6.2-bulk-add",
        group: GROUP_62,
        title: "大面积临时增补（30 人，组合压力窗口内）",
        expected: "增补项目尚未抽签；审核与冲突检查走同一条赛事行锁；已发布赛程不被改动",
        actual: `录入 ${30 - added.failures.length}/30（${Math.round(added.submittedMs / 100) / 10} 秒），审核${added.rejected.length ? `失败 ${added.rejected.length}` : "全部通过"}（${Math.round(added.approveMs / 100) / 10} 秒）；抽签 ${drawn.published.matches} 场；排程 ${scheduled.attempts.join(" / ")}；其他项目被改动 ${moved} 场`,
        ok: added.failures.length === 0 && added.rejected.length === 0 && scheduled.ok && moved === 0,
      });
      return `MS3 增补 30 人、${drawn.published.matches} 场，排程${scheduled.ok ? "已发布" : "未发布"}`;
    })(),
    Promise.all([pauseProbe(env, "6.7-pause-1"), pauseProbe(env, "6.7-pause-2")]).then(() => "两块场地暂停后恢复"),
    injectionLoop({ context, tournament, registry, server: env.server, rng: env.rng.fork("ops:chaos:inject"), only: new Set(["commands", "sessions"]) }),
  ]);
  actions.push(additions, pauses, "§7 命令与会话注入");
  const remaining = windowMs - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
  record(env, {
    id: "6.7-window",
    group: "§6.7 组合压力时段",
    title: "组合压力窗口",
    expected: "窗口内各项操作都得到明确回应；窗口后数据一致、无人同时在两场、所有比赛有去向或列为预计卡住、名次与独立重算一致（见判定）",
    actual: `${actions.join("；")}；用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`,
    ok: true,
  });
}

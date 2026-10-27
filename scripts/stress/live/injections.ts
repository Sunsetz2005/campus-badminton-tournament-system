/**
 * 异常注入（测试方案 §7 通用部分、服务重启，§13.9 共用账号下的设备交接；M4）。
 *
 * 做法：运行中「借用」一场双方已定、尚未开始的个人比赛及其场地——本场地的调度协程打完手上那场后停下，
 * 注入用共用裁判账号的两台平板（两个登录会话）亲自执裁这场，在指定时刻发出重复、过期、乱序、并发、超时、
 * 换设备、接管、停心跳、停服务等请求，逐项记下期望与实际；之后由同一个驱动把比赛正常打完、提交，交给裁判长复核。
 * 所有已受理的 commandId 并进本场结果，判定里的「请求↔事件一一对应」照常核对：重复提交只能多 1 条事件，被拒的不能留下事件。
 *
 * 各组在不同场次上并行，服务重启最后单独做（停机期间其他请求在 http.ts 里等待恢复）。
 */
import { randomUUID } from "node:crypto";

import { sleep } from "../core/clock";
import { matchesOfTournament, playerListsOfMatches, prisma } from "../core/db";
import { beginOutage, Client, endOutage, type CallResult } from "../core/http";
import type { Rng } from "../core/rng";
import type { Server } from "../core/server";
import { addFinding, recordProbe, type ProbeVerdict, type RunContext, type TournamentRuntime } from "../scenario/context";
import { Narrative } from "./narrative";
import { checkIn, checkOut, pickSharedOfficial, type Official } from "./officials";
import { browserProbes } from "./browser";
import { dbFaultProbes } from "./db-injections";
import { MatchDriver, type Control, type MatchRunResult, type MatchStateView } from "./referee";
import type { LiveRegistry } from "./venue";
import { SIM_OFFICIATING_NAME } from "../officiating-name";

type Side = "A" | "B";

export interface Env {
  context: RunContext;
  tournament: TournamentRuntime;
  registry: LiveRegistry;
  server: Server;
  rng: Rng;
  /** 共用裁判账号的两个登录会话（两台平板）。逐场指派模式下不用。 */
  tablets: [Client, Client];
}

export interface Borrowed {
  code: string;
  courtId: string;
  official: Official;
  startedAt: number;
  drivers: MatchDriver[];
  /** 中途换人：每段执裁人与开始时刻（第一段即 official）。 */
  segments: { official: Official; from: number }[];
}

export type MatchRow = Awaited<ReturnType<typeof matchesOfTournament>>[number];

const GROUP = "§7 通用";
const HANDOVER = "§13.9 交接（共用账号）";

export async function injectionLoop(options: { context: RunContext; tournament: TournamentRuntime; registry: LiveRegistry; server: Server; rng: Rng; only?: Set<string> }) {
  const { context, tournament, registry, server, rng, only } = options;
  const tablets: [Client, Client] = [
    new Client(context.origin, `inject-${tournament.plan.key}-tablet-1`, context.metrics, context.nextIp()),
    new Client(context.origin, `inject-${tournament.plan.key}-tablet-2`, context.metrics, context.nextIp()),
  ];
  for (const tablet of tablets) await tablet.signIn(context.refereeLogin.login, context.refereeLogin.password);
  const env: Env = { context, tournament, registry, server, rng, tablets };
  const groups: [string, (env: Env) => Promise<void>][] = [
    ["commands", commandProbes],
    ["sessions", sessionProbes],
    ["handover", handoverProbes],
    ["pending", pendingHandoverProbes],
    ["browser", browserProbes],
  ];
  await sleep(10_000);
  await Promise.allSettled(groups.filter(([key]) => !only || only.has(key)).map(([key, run]) => guarded(env, key, run)));
  // 服务重启与数据库故障影响全局，等其他组结束后依次做。
  if (!only || only.has("restart")) await guarded(env, "restart", restartProbe);
  if (!only || only.has("dbfaults")) await guarded(env, "dbfaults", dbFaultProbes);
}

async function guarded(env: Env, key: string, run: (env: Env) => Promise<void>) {
  try {
    await run(env);
  } catch (error) {
    addFinding(env.context, { kind: "script_error", area: "异常注入", title: `注入组 ${key} 中断`, detail: { message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) } });
    recordProbe(env.context, { id: `${key}:*`, group: "脚本", title: `注入组 ${key}`, expected: "—", actual: error instanceof Error ? error.message : String(error), verdict: "脚本错误" });
  }
}

// ---------------------------------------------------------------- 借用与归还

/**
 * 借用一场比赛。`chooseOfficial` 决定由谁执裁：共用账号模式取仿真轮换表里的空闲者；逐场指派模式取系统指派的那个人（须空闲）。
 */
export async function borrow(
  env: Env,
  label: string,
  chooseOfficial: (match: MatchRow) => Official | null = () => pickSharedOfficial(env.tournament.officials),
  /** 只借指定的比赛（M5 赛务异常按场次构造）。暂缓开赛（heldMatches）的比赛只有被这里明确选中时才借。 */
  only?: (match: MatchRow) => boolean,
): Promise<Borrowed | null> {
  const { context, tournament, registry } = env;
  const watched = new Set(tournament.delayScenarios.flatMap((item) => [...item.causes, ...item.watch]));
  while (!registry.stop) {
    const matches = await matchesOfTournament(tournament.id);
    const busy = new Set([...registry.active.keys(), ...matches.filter((match) => match.lifecycleStatus === "IN_PROGRESS").map((match) => match.code)]);
    const candidates = matches
      .filter(
        (match) =>
          ["SCHEDULED", "READY"].includes(match.lifecycleStatus) &&
          !match.notPlayedAt &&
          match.sideAEntryId &&
          match.sideBEntryId &&
          !match.rubberKind &&
          match.courtId &&
          !tournament.forced.has(match.code) &&
          !watched.has(match.code) &&
          !busy.has(match.code) &&
          !registry.borrowedCourts.has(match.courtId) &&
          // 赛务异常已为之安排特殊结果的比赛（指定场次、退出的报名单位、按规则弃权的报名单位）不借。
          !tournament.specials.has(match.code) &&
          ![match.sideAEntryId, match.sideBEntryId].some((id) => id && (tournament.withdrawn.has(id) || tournament.hookedEntries.has(id))) &&
          (only ? only(match) : !tournament.heldMatches.has(match.code)),
      )
      .sort((left, right) => (left.scheduledAt?.getTime() ?? Infinity) - (right.scheduledAt?.getTime() ?? Infinity))
      .slice(0, 10);
    if (candidates.length) {
      const lists = await playerListsOfMatches([...busy, ...candidates.map((match) => match.code)]);
      // 以下到登记之间没有 await：与场地协程的「同步再核对」一致，避免同一选手被两边同时选中。
      const claimed = new Set([...[...busy].flatMap((code) => lists.get(code)?.ids ?? []), ...[...registry.activePlayers.values()].flat()]);
      const pick = candidates.find((match) => {
        const ids = lists.get(match.code)?.ids ?? [];
        return ids.length > 0 && !ids.some((id) => claimed.has(id)) && !registry.active.has(match.code) && !registry.borrowedCourts.has(match.courtId!) && chooseOfficial(match);
      });
      const official = pick ? chooseOfficial(pick) : null;
      if (pick && official && checkIn(context, official, pick.code)) {
        const courtId = pick.courtId!;
        registry.borrowedCourts.set(courtId, pick.code);
        registry.active.set(pick.code, courtId);
        registry.activePlayers.set(pick.code, lists.get(pick.code)!.ids);
        registry.intentionalWaits.set(`inject:${pick.code}`, Date.now() + 30 * 60_000);
        // 等本场地手上那场打完。
        for (;;) {
          const others = [...registry.active.entries()].some(([code, court]) => court === courtId && code !== pick.code);
          const live = await prisma.match.count({ where: { courtId, lifecycleStatus: "IN_PROGRESS", code: { not: pick.code } } });
          if (!others && !live) break;
          await sleep(1000);
        }
        registry.playing.set(pick.code, Date.now());
        context.log(`[注入] 借用 ${pick.code}（${label}）`);
        const startedAt = Date.now();
        return { code: pick.code, courtId, official, startedAt, drivers: [], segments: [{ official, from: startedAt }] };
      }
    }
    await sleep(2000);
  }
  return null;
}

export function driver(env: Env, borrowed: Borrowed, client: Client, deviceSessionId = env.rng.uuid()) {
  const item = new MatchDriver(client, borrowed.code, deviceSessionId, Narrative.pick(env.rng.fork(`inject:narrative:${borrowed.code}:${borrowed.drivers.length}`)), env.context.clock, env.rng.fork(`inject:rally:${borrowed.code}:${borrowed.drivers.length}`));
  borrowed.drivers.push(item);
  return item;
}

/** 打完、并入结果、归还场地。`last` 为空表示比赛没能打完（记为中止，不再占住场地）。 */
export async function giveBack(env: Env, borrowed: Borrowed, last: MatchRunResult | null) {
  const { context, registry, tournament } = env;
  const accepted = [...new Set(borrowed.drivers.flatMap((item) => item.acceptedIds()))];
  const result: MatchRunResult = last
    ? { ...last, acceptedCommandIds: accepted, commands: borrowed.drivers.reduce((sum, item) => sum + item.commands.length, 0), startedAt: borrowed.startedAt }
    : {
        matchCode: borrowed.code,
        outcome: "stopped",
        reason: "注入未能打完",
        finalPhase: null,
        finalVersion: null,
        gamesWon: null,
        commands: 0,
        acceptedCommandIds: accepted,
        rejected: {},
        narrative: Narrative.pick(env.rng.fork("unused")).describe(),
        startedAt: borrowed.startedAt,
        endedAt: Date.now(),
      };
  const final = borrowed.segments[borrowed.segments.length - 1].official;
  result.official = final.key;
  result.officialUserId = final.userId;
  if (borrowed.segments.length > 1) result.officialSegments = borrowed.segments.map((segment) => ({ key: segment.official.key, userId: segment.official.userId, from: segment.from }));
  registry.results.push(result);
  if (result.outcome !== "submitted") {
    registry.abandoned.add(borrowed.code);
    addFinding(context, { kind: "script_error", area: "异常注入", title: `借用的 ${borrowed.code} 没有打完`, detail: { reason: result.reason ?? null } });
    for (const item of borrowed.drivers) await item.release().catch(() => undefined);
  }
  registry.lastProgressAt = Date.now();
  const end = Date.now();
  borrowed.segments.forEach((segment, index) => {
    const until = borrowed.segments[index + 1]?.from ?? end;
    checkOut(segment.official, { matchCode: borrowed.code, courtId: borrowed.courtId, start: segment.from, end: until, waitedMs: 0, outcome: index === borrowed.segments.length - 1 ? result.outcome : "handed_over" }, context.clock, env.rng.fork(`inject:rest:${borrowed.code}:${index}`));
  });
  registry.playing.delete(borrowed.code);
  registry.intentionalWaits.delete(`inject:${borrowed.code}`);
  registry.active.delete(borrowed.code);
  registry.activePlayers.delete(borrowed.code);
  registry.borrowedCourts.delete(borrowed.courtId);
  void tournament;
}

export async function withBorrowed(env: Env, label: string, body: (borrowed: Borrowed) => Promise<MatchRunResult | null>, chooseOfficial?: (match: MatchRow) => Official | null, only?: (match: MatchRow) => boolean) {
  const borrowed = await borrow(env, label, chooseOfficial, only);
  if (!borrowed) return;
  let last: MatchRunResult | null = null;
  try {
    last = await body(borrowed);
  } finally {
    await giveBack(env, borrowed, last);
  }
}

// ---------------------------------------------------------------- 小工具

export const eventCount = (code: string) => prisma.matchEvent.count({ where: { match: { code } } });

export function probe(env: Env, item: { id: string; group?: string; title: string; expected: string; actual: string; ok: boolean | "undefined" | "skipped"; match: string; detail?: Record<string, unknown> }) {
  const verdict: ProbeVerdict = item.ok === "undefined" ? "设计未定义" : item.ok === "skipped" ? "未触发" : item.ok ? "符合" : "不符";
  recordProbe(env.context, { id: item.id, group: item.group ?? GROUP, title: item.title, expected: item.expected, actual: item.actual, verdict, match: item.match, detail: item.detail });
}

export const brief = (result: CallResult) => `${result.status}${result.code ? ` ${result.code}` : result.json && typeof result.json === "object" && "status" in result.json ? ` ${(result.json as { status: string }).status}` : ""}`;

/** 一直打到下一次可以记分（IN_PROGRESS）。 */
export async function toRally(item: MatchDriver, minPoints = 0) {
  const result = await item.play({ onPhase: async (state) => (state.phase === "IN_PROGRESS" && state.score.A + state.score.B >= minPoints ? "pause" : "continue") });
  if (result.reason !== "paused") throw new Error(`${item.matchCode} 没能回到记分状态：${result.outcome} ${result.reason ?? ""}`);
}

/** 先手方再赢一分即赢下整场时返回该方。 */
function matchPointSide(state: MatchStateView): Side | null {
  const rule = state.ruleConfig;
  const need = Math.ceil(rule.bestOf / 2);
  for (const side of ["A", "B"] as const) {
    const other = side === "A" ? "B" : "A";
    const mine = state.score[side] + 1;
    const wins = (mine >= rule.targetPoints && mine - state.score[other] >= rule.winBy) || mine >= rule.capPoints;
    if (wins && state.gamesWon[side] === need - 1) return side;
  }
  return null;
}

export async function acquireWith(client: Client, code: string, deviceSessionId: string) {
  return client.call<Control & { status: string }>("POST", `/api/matches/${code}/control`, { deviceSessionId, officiatingName: SIM_OFFICIATING_NAME }, { route: "/api/matches/[code]/control" });
}

export async function heartbeatWith(client: Client, code: string, control: Control) {
  return client.call("PUT", `/api/matches/${code}/control/heartbeat`, { scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration }, {
    route: "/api/matches/[code]/control/heartbeat",
    headers: { Authorization: `Bearer ${control.controlToken}` },
  });
}

export async function releaseWith(client: Client, code: string, control: Control) {
  return client.call("DELETE", `/api/matches/${code}/control`, { scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration }, {
    route: "/api/matches/[code]/control",
    headers: { Authorization: `Bearer ${control.controlToken}` },
  });
}

export async function chiefTakeover(env: Env, code: string, reason: string) {
  const chief = env.tournament.chiefs[0];
  return chief.client.call<Control>("POST", `/api/matches/${code}/control/takeover`, { deviceSessionId: randomUUID(), reason }, { route: "/api/matches/[code]/control/takeover" });
}

// ---------------------------------------------------------------- §7 命令类

async function commandProbes(env: Env) {
  await withBorrowed(env, "命令类注入", async (borrowed) => {
    const code = borrowed.code;
    const d = driver(env, borrowed, env.tablets[0]);
    const acquired = await d.acquire();
    if (!acquired.ok) throw new Error(`取得控制失败 ${brief(acquired)}`);
    await d.refresh();
    await toRally(d, 2);

    // 同 commandId 同内容：并发双发 + 立即再发。
    {
      const envelope = d.envelope("RALLY_WON", { side: "A" });
      const before = await eventCount(code);
      const [first, second] = await Promise.all([d.post(envelope), d.post(envelope)]);
      const third = await d.post(envelope);
      const added = (await eventCount(code)) - before;
      const statuses = [first, second, third].map(brief);
      const created = [first, second, third].filter((item) => item.status === 201).length;
      const duplicates = [first, second, third].filter((item) => item.status === 200).length;
      probe(env, {
        id: "7.1",
        title: "同 commandId 同内容重复提交（并发双发 + 立即重发）",
        expected: "一次 201 accepted，其余 200 duplicate，事件只多 1 条",
        actual: `${statuses.join(" / ")}，事件 +${added}`,
        ok: created === 1 && duplicates === 2 && added === 1,
        match: code,
      });

      // 同 commandId 不同内容。
      const changed = { ...envelope, payload: { side: "B" } };
      const beforeChanged = await eventCount(code);
      const reused = await d.post(changed);
      const addedChanged = (await eventCount(code)) - beforeChanged;
      probe(env, {
        id: "7.2",
        title: "同 commandId 不同内容",
        expected: "409 command_id_reused，无事件",
        actual: `${brief(reused)}，事件 +${addedChanged}`,
        ok: reused.status === 409 && reused.code === "command_id_reused" && addedChanged === 0,
        match: code,
      });
    }

    // 过期 expectedVersion。
    {
      await toRally(d);
      const before = await eventCount(code);
      const stale = await d.post(d.envelope("RALLY_WON", { side: "A" }, { expectedVersion: d.state!.version - 1 }));
      const added = (await eventCount(code)) - before;
      probe(env, { id: "7.4", title: "过期 expectedVersion", expected: "409 conflict，无事件", actual: `${brief(stale)}，事件 +${added}`, ok: stale.status === 409 && stale.code === "conflict" && added === 0, match: code });
      if (!stale.ok) await d.refresh();
    }

    // 响应超时后原 ID 对账、重发。超时从小到大，直到出现「服务端已受理但客户端没收到回应」。
    {
      const attempts: Record<string, unknown>[] = [];
      let unknownCommitted = 0;
      let allExactlyOnce = true;
      for (const timeoutMs of [2, 5, 10, 20, 40, 80, 160]) {
        await toRally(d);
        const envelope = d.envelope("RALLY_WON", { side: env.rng.chance(0.5) ? "A" : "B" });
        const before = await eventCount(code);
        const first = await d.post(envelope, { timeoutMs });
        const attempt: Record<string, unknown> = { timeoutMs, first: brief(first) };
        if (first.status === 0) {
          await sleep(300);
          const lookup = await d.client.call<{ state?: MatchStateView }>("GET", `/api/matches/${code}/commands/${envelope.commandId}`, undefined, { route: "/api/matches/[code]/commands/[id]" });
          attempt.lookup = brief(lookup);
          if (lookup.ok) {
            unknownCommitted += 1;
            d.markAccepted(envelope.commandId);
            if (lookup.json?.state) d.state = lookup.json.state;
          }
          const resend = await d.post(envelope);
          attempt.resend = brief(resend);
          if (lookup.ok && resend.status !== 200) allExactlyOnce = false;
        }
        attempt.events = (await eventCount(code)) - before;
        if (attempt.events !== 1) allExactlyOnce = false;
        attempts.push(attempt);
        if (unknownCommitted >= 2) break;
      }
      probe(env, {
        id: "7.3",
        title: "响应超时后按原 commandId 对账再重发",
        expected: "对账返回已受理；重发为 200 duplicate；每条命令恰好 1 条事件",
        actual: `${attempts.length} 次超时尝试，其中服务端已受理而客户端未收到回应 ${unknownCommitted} 次；${allExactlyOnce ? "每条恰好 1 条事件" : "出现事件数不为 1"}`,
        ok: unknownCommitted === 0 ? "skipped" : allExactlyOnce,
        match: code,
        detail: { attempts },
      });
    }

    // 乱序：先发 v+1 再发 v；再做一组 0—800 ms 随机延迟的并发三连发。
    {
      await toRally(d);
      const version = d.state!.version;
      const later = d.envelope("RALLY_WON", { side: "A" }, { expectedVersion: version + 1 });
      const earlier = d.envelope("RALLY_WON", { side: "B" }, { expectedVersion: version });
      const before = await eventCount(code);
      const laterFirst = await d.post(later);
      const earlierThen = await d.post(earlier);
      const laterAgain = d.state?.phase === "IN_PROGRESS" ? await d.post(later) : null;
      const added = (await eventCount(code)) - before;
      probe(env, {
        id: "7.12a",
        title: "乱序：同场两条命令先到后发的那条",
        expected: "先到的 v+1 得 409 conflict；按序补发后都受理，版本连续不跳号",
        actual: `v+1 先发 ${brief(laterFirst)}；v ${brief(earlierThen)}；v+1 重发 ${laterAgain ? brief(laterAgain) : "（状态已离开记分，未重发）"}；事件 +${added}`,
        ok: laterFirst.status === 409 && laterFirst.code === "conflict" && earlierThen.status === 201 && (!laterAgain || laterAgain.status === 201) && added === (laterAgain ? 2 : 1),
        match: code,
      });

      await toRally(d);
      const base = d.state!.version;
      const burst = [0, 1, 2].map((offset) => d.envelope("RALLY_WON", { side: env.rng.chance(0.5) ? "A" : "B" }, { expectedVersion: base + offset }));
      const beforeBurst = await eventCount(code);
      const delays = burst.map(() => env.rng.int(0, 800));
      const results = await Promise.all(burst.map(async (envelope, index) => {
        await sleep(delays[index]);
        return d.post(envelope);
      }));
      // 被拒的按版本顺序补发（与工作台一致：冲突后先取权威状态，再按新版本发新命令）。
      const resent: string[] = [];
      for (let index = 0; index < burst.length; index += 1) {
        if (results[index].ok) continue;
        await d.refresh();
        if (d.state?.phase !== "IN_PROGRESS") break;
        const again = await d.post(d.envelope("RALLY_WON", burst[index].payload));
        resent.push(brief(again));
      }
      const addedBurst = (await eventCount(code)) - beforeBurst;
      const accepted = results.filter((item) => item.ok).length;
      probe(env, {
        id: "7.12b",
        title: "随机 0—800 ms 延迟的同场三条并发命令",
        expected: "版本不符的被 409 拒绝，不出现跳号；补发后事件数等于受理数",
        actual: `延迟 ${delays.join("/")} ms → ${results.map(brief).join(" / ")}；补发 ${resent.join(" / ") || "无"}；事件 +${addedBurst}`,
        // 前一条受理后可能进入间歇/换边待办，此时后面的记分得 422（相位不对）也属于「按版本/状态拒绝」。
        ok: results.every((item) => item.ok || (item.status === 409 && item.code === "conflict") || item.status === 422) && addedBurst === accepted + resent.filter((item) => item.startsWith("201")).length,
        match: code,
        detail: { delays },
      });
    }

    // 撤销与记分并发（同一版本）。
    {
      await toRally(d, 1);
      const version = d.state!.version;
      const undo = d.envelope("UNDO_LAST_REVERSIBLE", { reason: "仿真注入：撤销与记分并发" }, { expectedVersion: version });
      const rally = d.envelope("RALLY_WON", { side: "A" }, { expectedVersion: version });
      const before = await eventCount(code);
      const [undone, rallied] = await Promise.all([d.post(undo), d.post(rally)]);
      const added = (await eventCount(code)) - before;
      const wins = [undone, rallied].filter((item) => item.ok).length;
      const loser = [undone, rallied].find((item) => !item.ok);
      probe(env, {
        id: "7.10",
        title: "撤销与记分并发（同一版本）",
        expected: "恰好一条成功，另一条 409 conflict",
        actual: `撤销 ${brief(undone)}，记分 ${brief(rallied)}，事件 +${added}`,
        ok: wins === 1 && loser?.status === 409 && loser.code === "conflict" && added === 1,
        match: code,
      });
      await d.refresh();
    }

    // 刷新/断网恢复：丢弃本地状态，取权威状态后续用原控制。
    {
      await toRally(d);
      const known = d.state!.version;
      (d as { state: MatchStateView | null }).state = null;
      const refreshed = await d.refresh();
      const recovered = (d.state as MatchStateView | null)?.version ?? null;
      const next = refreshed.ok ? await d.post(d.envelope("RALLY_WON", { side: "B" })) : null;
      probe(env, {
        id: "7.8",
        title: "刷新/断网恢复：丢弃本地状态 → GET state → 续用",
        expected: "取回的版本与服务器一致，原控制可以继续记分",
        actual: `本地 v${known}，取回 ${refreshed.ok ? `v${recovered}` : brief(refreshed)}；续记 ${next ? brief(next) : "未发"}`,
        ok: refreshed.ok && recovered === known && next?.status === 201,
        match: code,
      });
    }

    // 比赛结束瞬间并发：制胜分与另一分同时发；结束后再记分。
    {
      let done = false;
      for (let round = 0; round < 6 && !done; round += 1) {
        const paused = await d.play({ onPhase: async (state) => (state.phase === "IN_PROGRESS" && matchPointSide(state) ? "pause" : "continue") });
        if (paused.reason !== "paused") break;
        const side = matchPointSide(d.state!)!;
        const version = d.state!.version;
        const win = d.envelope("RALLY_WON", { side }, { expectedVersion: version });
        const lose = d.envelope("RALLY_WON", { side: side === "A" ? "B" : "A" }, { expectedVersion: version });
        const [won, lost] = await Promise.all([d.post(win), d.post(lose)]);
        await d.refresh();
        if (!won.ok) continue; // 另一分先到：比赛继续，等下一个赛点再试。
        const after = await d.post(d.envelope("RALLY_WON", { side }));
        probe(env, {
          id: "7.11",
          title: "比赛结束瞬间并发：制胜分与另一分同时提交；结束后再记分",
          expected: "恰好一条成功；结束后再记分 422",
          actual: `制胜分 ${brief(won)}，另一分 ${brief(lost)}，相位 ${d.state?.phase}；结束后再记分 ${brief(after)}`,
          ok: !lost.ok && lost.status === 409 && after.status === 422,
          match: code,
        });
        done = true;
      }
      if (!done) probe(env, { id: "7.11", title: "比赛结束瞬间并发", expected: "恰好一条成功；结束后再记分 422", actual: "6 次赛点都由另一分先到，未能在结束瞬间构造并发", ok: "skipped", match: code });
    }
    return d.play();
  });
}

// ---------------------------------------------------------------- §7 会话类

async function sessionProbes(env: Env) {
  await withBorrowed(env, "会话类注入", async (borrowed) => {
    const code = borrowed.code;
    const [first, second] = env.tablets;
    const d = driver(env, borrowed, first);
    const acquired = await d.acquire();
    if (!acquired.ok) throw new Error(`取得控制失败 ${brief(acquired)}`);
    await d.refresh();
    await toRally(d, 2);

    // 两会话抢同一场（同账号、另一台平板、另一个 deviceSessionId）。
    const rival = await acquireWith(second, code, randomUUID());
    probe(env, {
      id: "7.5",
      title: "两会话抢同一场（同账号第二个 deviceSessionId）",
      expected: "409 controller_exists",
      actual: brief(rival),
      ok: rival.status === 409 && rival.code === "controller_exists",
      match: code,
    });
    probe(env, {
      id: "13.9-shared-swap",
      group: HANDOVER,
      title: "中途换人（共用账号）",
      expected: "同一台设备：系统看不出变化；换设备：新设备 409 controller_exists，只能等租约过期或裁判长接管；系统无法记下是谁执裁＝设计未定义",
      actual: `同一台设备换人不产生任何请求（无从记录）；换设备取得控制 ${brief(rival)}`,
      ok: "undefined",
      match: code,
    });

    // 同账号复用 deviceSessionId 的另一登录。
    {
      const oldControl = { ...d.control! };
      const reuse = await acquireWith(second, code, d.deviceSessionId);
      const afterCommand = await d.post(d.envelope("RALLY_WON", { side: "A" }), { control: oldControl });
      const afterHeartbeat = await heartbeatWith(first, code, oldControl);
      probe(env, {
        id: "7.6",
        title: "同账号另一登录复用相同 deviceSessionId",
        expected: "预计静默换发令牌、原设备 not_controller；是否可接受＝设计未定义",
        actual: `第二个登录取得 ${brief(reuse)}${reuse.ok ? `（代次 ${reuse.json?.takeoverGeneration}，原代次 ${oldControl.takeoverGeneration}）` : ""}；原令牌记分 ${brief(afterCommand)}，原令牌心跳 ${brief(afterHeartbeat)}`,
        ok: "undefined",
        match: code,
        detail: { reuse: reuse.json, afterCommand: afterCommand.code, afterHeartbeat: afterHeartbeat.code },
      });
      if (reuse.ok) d.control = reuse.json!;
      await d.refresh();
    }

    // 裁判长接管：代次 +1，旧令牌命令与心跳都被拒；裁判长释放后裁判重新取得。
    {
      await toRally(d);
      const oldControl = { ...d.control! };
      const takeover = await chiefTakeover(env, code, "仿真注入：裁判长接管");
      const oldCommand = await d.post(d.envelope("RALLY_WON", { side: "B" }), { control: oldControl });
      const oldHeartbeat = await heartbeatWith(d.client, code, oldControl);
      const released = takeover.ok ? await releaseWith(env.tournament.chiefs[0].client, code, takeover.json!) : null;
      const again = await d.acquire();
      await d.refresh();
      probe(env, {
        id: "7.7",
        title: "裁判长接管",
        expected: "代次 +1，旧令牌命令与心跳都 409 not_controller",
        actual: `接管 ${brief(takeover)}，代次 ${oldControl.takeoverGeneration} → ${takeover.json?.takeoverGeneration ?? "—"}；旧令牌命令 ${brief(oldCommand)}，心跳 ${brief(oldHeartbeat)}；裁判长释放 ${released ? brief(released) : "—"}，裁判重新取得 ${brief(again)}（代次 ${again.json?.takeoverGeneration ?? "—"}）`,
        ok: takeover.ok && takeover.json!.takeoverGeneration === oldControl.takeoverGeneration + 1 && oldCommand.code === "not_controller" && oldHeartbeat.code === "not_controller" && again.ok,
        match: code,
      });
    }

    // 心跳中断超过租约（2 分钟）。
    {
      await toRally(d);
      await d.heartbeatIfDue(true);
      const oldControl = { ...d.control! };
      const quietMs = 125_000;
      env.registry.intentionalWaits.set(`inject:heartbeat:${code}`, Date.now() + quietMs + 30_000);
      await sleep(quietMs);
      const oldCommand = await d.post(d.envelope("RALLY_WON", { side: "A" }), { control: oldControl });
      const oldHeartbeat = await heartbeatWith(d.client, code, oldControl);
      const again = await d.acquire();
      await d.refresh();
      const next = again.ok && d.state?.phase === "IN_PROGRESS" ? await d.post(d.envelope("RALLY_WON", { side: "A" })) : null;
      env.registry.intentionalWaits.delete(`inject:heartbeat:${code}`);
      probe(env, {
        id: "7.9",
        title: "心跳中断超过 2 分钟",
        expected: "会话过期；重新取得后代次 +1，旧令牌被拒",
        actual: `停心跳 ${quietMs / 1000} 秒后旧令牌记分 ${brief(oldCommand)}、心跳 ${brief(oldHeartbeat)}；重新取得 ${brief(again)}（代次 ${oldControl.takeoverGeneration} → ${again.json?.takeoverGeneration ?? "—"}）；续记 ${next ? brief(next) : "—"}`,
        ok: !oldCommand.ok && !oldHeartbeat.ok && again.ok && again.json!.takeoverGeneration === oldControl.takeoverGeneration + 1,
        match: code,
      });
    }
    return d.play();
  });
}

// ---------------------------------------------------------------- §13.9 共用账号下的交接

/** 离场交接三种方式：主动释放、不释放等租约过期、裁判长接管。记从离场到接替者第一条命令被受理的耗时。 */
async function handoverProbes(env: Env) {
  await withBorrowed(env, "离场交接", async (borrowed) => {
    const code = borrowed.code;
    const [first, second] = env.tablets;
    let current = driver(env, borrowed, first);
    if (!(await current.acquire()).ok) throw new Error("取得控制失败");
    await current.refresh();
    await toRally(current, 2);

    const successorFirstCommand = async (next: MatchDriver) => {
      await next.refresh();
      await toRally(next);
      return next.post(next.envelope("RALLY_WON", { side: "A" }));
    };

    // ① 离场前主动释放。
    {
      const left = Date.now();
      await current.release();
      const next = driver(env, borrowed, second);
      const acquired = await next.acquire();
      const command = acquired.ok ? await successorFirstCommand(next) : null;
      const elapsed = Date.now() - left;
      probe(env, {
        id: "13.9-leave-release",
        group: HANDOVER,
        title: "裁判带设备离场：① 离场前主动释放",
        expected: "接替者立即取得控制",
        actual: `取得 ${brief(acquired)}，第一条命令 ${command ? brief(command) : "—"}，耗时 ${(elapsed / 1000).toFixed(1)} 秒`,
        ok: acquired.ok && command?.status === 201 && elapsed < 10_000,
        match: code,
        detail: { elapsedMs: elapsed },
      });
      current = next;
    }

    // ② 不释放、停心跳，接替者每 5 秒尝试一次，直到租约过期。
    {
      await toRally(current, 1);
      await current.heartbeatIfDue(true);
      const left = Date.now();
      env.registry.intentionalWaits.set(`inject:lease:${code}`, left + 4 * 60_000);
      const next = driver(env, borrowed, current.client === first ? second : first);
      let acquired: CallResult<Control & { status: string }> | null = null;
      let tries = 0;
      const codes = new Map<string, number>();
      while (Date.now() - left < 4 * 60_000) {
        tries += 1;
        acquired = await next.acquire();
        if (acquired.ok) break;
        codes.set(brief(acquired), (codes.get(brief(acquired)) ?? 0) + 1);
        await sleep(5000);
      }
      const command = acquired?.ok ? await successorFirstCommand(next) : null;
      const elapsed = Date.now() - left;
      env.registry.intentionalWaits.delete(`inject:lease:${code}`);
      probe(env, {
        id: "13.9-leave-lease",
        group: HANDOVER,
        title: "裁判带设备离场：② 不释放，等租约过期",
        expected: "接替者 ≤2 分钟（加轮询间隔）后取得控制",
        actual: `尝试 ${tries} 次（期间 ${[...codes].map(([key, count]) => `${key}×${count}`).join("、")}），取得 ${acquired ? brief(acquired) : "—"}，第一条命令 ${command ? brief(command) : "—"}，耗时 ${(elapsed / 1000).toFixed(1)} 秒`,
        ok: Boolean(acquired?.ok) && command?.status === 201 && elapsed <= 130_000 + 10_000,
        match: code,
        detail: { elapsedMs: elapsed, tries },
      });
      current = next;
    }

    // ③ 不释放，由裁判长接管后交给接替者。
    {
      await toRally(current, 1);
      const left = Date.now();
      const takeover = await chiefTakeover(env, code, "仿真注入：裁判离场，裁判长接管后交接");
      const released = takeover.ok ? await releaseWith(env.tournament.chiefs[0].client, code, takeover.json!) : null;
      const next = driver(env, borrowed, current.client === first ? second : first);
      const acquired = await next.acquire();
      const command = acquired.ok ? await successorFirstCommand(next) : null;
      const elapsed = Date.now() - left;
      probe(env, {
        id: "13.9-leave-takeover",
        group: HANDOVER,
        title: "裁判带设备离场：③ 裁判长接管",
        expected: "耗时取决于裁判长队列；接替者在裁判长释放后取得",
        actual: `接管 ${brief(takeover)}，释放 ${released ? brief(released) : "—"}，接替者取得 ${brief(acquired)}，第一条命令 ${command ? brief(command) : "—"}，耗时 ${(elapsed / 1000).toFixed(1)} 秒（裁判长即时处理）`,
        ok: takeover.ok && acquired.ok && command?.status === 201,
        match: code,
        detail: { elapsedMs: elapsed },
      });
      current = next;
    }
    return current.play();
  });
}

/** 交接时有未完成的待办：间歇待确认、换边待确认、比赛结束未提交。接替者应看到同一项待办并能完成，不丢、不重复确认。 */
async function pendingHandoverProbes(env: Env) {
  await withBorrowed(env, "带待办交接", async (borrowed) => {
    const code = borrowed.code;
    let current = driver(env, borrowed, env.tablets[0]);
    if (!(await current.acquire()).ok) throw new Error("取得控制失败");
    await current.refresh();
    const points: { id: string; title: string; when: (state: MatchStateView) => boolean }[] = [
      { id: "interval", title: "间歇待确认", when: (state) => state.pendingObligations.some((item) => item.type === "INTERVAL") },
      { id: "change-ends", title: "换边待确认", when: (state) => state.pendingObligations.some((item) => item.type === "CHANGE_ENDS") },
      { id: "submit", title: "比赛结束、尚未提交", when: (state) => state.phase === "MATCH_COMPLETE_PENDING_SUBMISSION" },
    ];
    for (const point of points) {
      const paused = await current.play({ onPhase: async (state) => (point.when(state) ? "pause" : "continue") });
      if (paused.reason !== "paused") {
        probe(env, { id: `13.9-pending-${point.id}`, group: HANDOVER, title: `交接时有待办：${point.title}`, expected: "接替者看到同一项待办并完成", actual: `比赛已到 ${paused.finalPhase}，未出现该时点`, ok: "skipped", match: code });
        if (paused.outcome === "submitted") return paused;
        continue;
      }
      const before = current.state!;
      // 局末可能同时挂着间歇与换边两项：取本时点关心的那一项。
      const wanted = point.id === "interval" ? "INTERVAL" : point.id === "change-ends" ? "CHANGE_ENDS" : null;
      const obligation = wanted ? (before.pendingObligations.find((item) => item.type === wanted) ?? null) : null;
      await current.release();
      const next = driver(env, borrowed, current.client === env.tablets[0] ? env.tablets[1] : env.tablets[0]);
      const acquired = await next.acquire();
      await next.refresh();
      const seen = next.state!;
      const sameTodo = seen.phase === before.phase && (obligation ? seen.pendingObligations.some((item) => item.id === obligation.id) : true);
      // 接替者做到这一项完成为止（同时挂着的前一项会先被处理）。
      let steps = 0;
      const after = await next.play({
        onPhase: async (state) => (steps++ > 0 && (!obligation || !state.pendingObligations.some((item) => item.id === obligation.id)) ? "pause" : "continue"),
      });
      const completedType = point.id === "interval" ? "ACKNOWLEDGE_INTERVAL" : point.id === "change-ends" ? "CONFIRM_CHANGE_ENDS" : "SUBMIT_RESULT";
      const completions = obligation
        ? await prisma.matchEvent.count({ where: { match: { code }, type: completedType, payload: { path: ["obligationId"], equals: obligation.id } } })
        : await prisma.matchEvent.count({ where: { match: { code }, type: completedType } });
      probe(env, {
        id: `13.9-pending-${point.id}`,
        group: HANDOVER,
        title: `交接时有待办：${point.title}`,
        expected: "接替者从 GET state 看到同一项待办并完成；不丢失、不确认两次",
        actual: `交出时 ${before.phase}${obligation ? ` / ${obligation.type}` : ""}；接替者取得 ${brief(acquired)}，看到 ${seen.phase}${sameTodo ? "（同一项）" : "（不同）"}；完成后该项事件 ${completions} 条，接替者结局 ${after.outcome === "submitted" ? "已提交" : seen.phase}`,
        ok: acquired.ok && sameTodo && completions === 1,
        match: code,
      });
      current = next;
      if (after.outcome === "submitted") return after;
    }
    return current.play();
  });
}

// ---------------------------------------------------------------- §7 中途重启服务进程

async function restartProbe(env: Env) {
  if (env.server.options.external) {
    probe(env, { id: "7.13", title: "中途重启服务进程", expected: "恢复后原 commandId 可找回、继续记分", actual: "连接外部实例，本机不能重启", ok: "skipped", match: "—" });
    return;
  }
  await withBorrowed(env, "服务重启", async (borrowed) => {
    const code = borrowed.code;
    const d = driver(env, borrowed, env.tablets[0]);
    if (!(await d.acquire()).ok) throw new Error("取得控制失败");
    await d.refresh();
    await toRally(d, 4);
    const envelope = d.envelope("RALLY_WON", { side: "A" });
    const before = await eventCount(code);
    // 命令发出的同时停服务：命令可能已提交，也可能没到。
    const inflight = d.post(envelope, { duringOutage: true });
    await sleep(env.rng.int(0, 15));
    beginOutage();
    const stopAt = Date.now();
    const stopping = env.server.stop();
    const windowCodes = new Map<string, number>();
    const sample = async () => {
      const health = await d.client.call("GET", "/api/health", undefined, { route: "/api/health", duringOutage: true, timeoutMs: 2000 });
      windowCodes.set(brief(health), (windowCodes.get(brief(health)) ?? 0) + 1);
    };
    const first = await inflight;
    await stopping;
    const stoppedAt = Date.now();
    await sample();
    let readyMs = 0;
    try {
      readyMs = await env.server.start();
    } finally {
      endOutage();
    }
    const upAt = Date.now();
    await sample();
    const lookup = await d.client.call<{ state?: MatchStateView }>("GET", `/api/matches/${code}/commands/${envelope.commandId}`, undefined, { route: "/api/matches/[code]/commands/[id]" });
    if (lookup.ok) d.markAccepted(envelope.commandId);
    const resend = await d.post(envelope);
    const heartbeat = await d.heartbeatIfDue(true);
    await d.refresh();
    const added = (await eventCount(code)) - before;
    probe(env, {
      id: "7.13",
      title: "中途重启服务进程（命令在途时停服务）",
      expected: "恢复后原 commandId 可找回、继续记分；重发恰好 1 条事件；记录重启窗口内的错误码",
      actual: `在途命令 ${brief(first)}；停机 ${((stoppedAt - stopAt) / 1000).toFixed(1)} 秒、重新就绪 ${(readyMs / 1000).toFixed(1)} 秒（停机到恢复共 ${((upAt - stopAt) / 1000).toFixed(1)} 秒）；窗口内 ${[...windowCodes].map(([key, count]) => `${key}×${count}`).join("、")}；恢复后对账 ${brief(lookup)}，重发 ${brief(resend)}，心跳 ${heartbeat ? brief(heartbeat) : "—"}；事件 +${added}`,
      ok: added === 1 && (lookup.ok ? resend.status === 200 : resend.status === 201) && Boolean(heartbeat?.ok),
      match: code,
      detail: { inflight: first.code, readyMs },
    });
    return d.play();
  });
}

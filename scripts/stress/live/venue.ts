/**
 * 场地调度（§5.1「守纪律的现场」）：每块场地一个协程、一台「平板」（共用裁判账号的一个登录会话）。
 * 选下一场只看「我的执裁」：本场地已发布、尚未开始、双方已确定、上场人员都不在进行中的比赛，按计划时间取最早的；
 * 允许比计划提前开赛（情形 6）。没有被排到场地的比赛（例如自动建议未排入）由任一空闲场地接手，并记为发现。
 *
 * 场地空着但所有候选都在等人或等名单时原地轮询；整个赛事长时间没有进展时由 run.ts 判定为卡住。
 */
import type { Clock } from "../core/clock";
import { sleep } from "../core/clock";
import type { Client } from "../core/http";
import type { Rng } from "../core/rng";
import type { RunContext, TournamentRuntime } from "../scenario/context";
import { addFinding } from "../scenario/context";
import { Narrative } from "./narrative";
import type { OfficiatingCache, OfficiatingMatch } from "./officiating";
import { MatchDriver, type MatchRunResult } from "./referee";

export interface LiveRegistry {
  /** 仿真正在执裁的比赛 → 场地。 */
  active: Map<string, string>;
  results: MatchRunResult[];
  /** 执裁中止、遗留在进行中的比赛：记为发现后不再占住场地，否则整个场地永远停摆。 */
  abandoned: Set<string>;
  lastProgressAt: number;
  stop: boolean;
}

export async function courtLoop(options: {
  context: RunContext;
  tournament: TournamentRuntime;
  court: { id: string; name: string };
  device: Client;
  cache: OfficiatingCache;
  registry: LiveRegistry;
  rng: Rng;
  clock: Clock;
}) {
  const { context, tournament, court, device, cache, registry, rng, clock } = options;
  const notedUnplaced = new Set<string>();
  while (!registry.stop) {
    let view;
    try {
      view = await cache.get();
    } catch (error) {
      context.log(`${court.name} 读取我的执裁失败：${error instanceof Error ? error.message : String(error)}`);
      await sleep(2000);
      continue;
    }
    const inProgress = view.matches.filter((match) => match.status === "IN_PROGRESS" && !registry.abandoned.has(match.code));
    if (inProgress.some((match) => match.court?.id === court.id && !registry.active.has(match.code))) {
      // 本场地有一场不由本协程执裁的进行中比赛（例如重启后遗留），先不开新场。
      await sleep(1000);
      continue;
    }
    const candidates = view.matches
      .filter((match) => match.status === "NOT_STARTED" && !registry.active.has(match.code) && !registry.abandoned.has(match.code))
      .filter((match) => match.court?.id === court.id || (!match.court && match.sideA !== "待定"))
      .sort((left, right) => sortKey(left) - sortKey(right));
    if (!candidates.length) {
      await sleep(1500);
      continue;
    }
    const busyCodes = [...new Set([...inProgress.map((match) => match.code), ...registry.active.keys()])];
    const players = await cache.playersOf([...busyCodes, ...candidates.slice(0, 8).map((match) => match.code)]);
    const busyPlayers = new Set(busyCodes.flatMap((code) => players.get(code) ?? []));
    const next = candidates.slice(0, 8).find((match) => {
      const list = players.get(match.code) ?? [];
      return list.length > 0 && !list.some((id) => busyPlayers.has(id));
    });
    if (!next) {
      await sleep(1500);
      continue;
    }
    if (!next.court && !notedUnplaced.has(next.code)) {
      notedUnplaced.add(next.code);
      addFinding(context, { kind: "observation", area: "调度", title: `未排场地的比赛 ${next.code} 由 ${court.name} 接手`, detail: { matchCode: next.code } });
    }
    registry.active.set(next.code, court.id);
    try {
      const driver = new MatchDriver(device, next.code, rng.uuid(), Narrative.pick(rng.fork(`narrative:${next.code}`)), clock, rng.fork(`rally:${next.code}`));
      const acquired = await driver.acquire();
      if (!acquired.ok) {
        context.log(`${court.name} 取得 ${next.code} 控制失败：${acquired.status} ${acquired.code}`);
        if (acquired.status !== 409) registry.abandoned.add(next.code);
        await sleep(2000);
        continue;
      }
      const first = await driver.refresh();
      if (!first.ok) {
        // 团体小场在双方名单交齐前取得控制会成功，但读状态得到 match_not_ready：放回控制、稍后再来。
        await driver.release();
        if (first.code !== "match_not_ready") {
          registry.abandoned.add(next.code);
          addFinding(context, { kind: "blocked", area: "执裁", title: `${next.code} 读取权威状态失败`, detail: { status: first.status, code: first.code, message: first.message } });
        }
        await sleep(2000);
        continue;
      }
      const result = await driver.play();
      registry.results.push(result);
      registry.lastProgressAt = Date.now();
      if (result.outcome !== "submitted") {
        addFinding(context, {
          kind: result.outcome === "failed" ? "script_error" : "blocked",
          area: "执裁",
          title: `${next.code} 执裁中止：${result.reason}`,
          detail: { ...result, tournament: tournament.plan.key, court: court.name },
        });
        await driver.release().catch(() => undefined);
        registry.abandoned.add(next.code);
      }
    } finally {
      registry.active.delete(next.code);
      cache.invalidate();
    }
  }
}

function sortKey(match: OfficiatingMatch) {
  return match.scheduledAt ? new Date(match.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
}

/**
 * 场地调度（§5.1「守纪律的现场」）：每块场地一个调度协程，每名裁判一个「人」（officials.ts）。
 * 选下一场只看系统给出的数据：本场地已发布、尚未开始、双方已确定、上场人员都不在进行中的比赛，按计划时间取最早的；
 * 允许比计划提前开赛（情形 6）。没有被排到场地的比赛（例如自动建议未排入）由任一空闲场地接手，并记为发现。
 *
 * 谁来执裁：
 * - 共用账号模式：场地平板（共用账号的一个登录会话）+ 仿真轮换表挑一名空闲裁判（系统不知道是谁）；
 * - 逐场指派模式：以系统指派为准，等指派的那个人到场（休息结束、上一场结束）才开赛，用他自己的手机。
 *
 * 场地空着但所有候选都在等人或等名单时原地轮询；整个赛事长时间没有进展时由 run.ts 判定为卡住。
 */
import type { Clock } from "../core/clock";
import { sleep } from "../core/clock";
import type { Client } from "../core/http";
import type { Rng } from "../core/rng";
import { prisma } from "../core/db";
import type { RunContext, SpecialHookMatch, SpecialPlan, TournamentRuntime } from "../scenario/context";
import { addFinding } from "../scenario/context";
import { Narrative } from "./narrative";
import { OfficiatingCache, type MatchSource, type VenueMatch } from "./officiating";
import { available, checkIn, checkOut, pickSharedOfficial, type Official } from "./officials";
import { MatchDriver, type MatchRunResult } from "./referee";

export interface LiveRegistry {
  /** 仿真正在执裁的比赛 → 场地。 */
  active: Map<string, string>;
  /** 仿真正在执裁的比赛 → 上场人员。与 active 同步写入，开赛前同步核对，避免两个场地协程在 await 间隙选中同一名选手。 */
  activePlayers: Map<string, string[]>;
  /** 仿真有意的等待（例如延误情形 3 的复核延后）：比赛 → 等到何时。卡住检测在此期间不判卡住。 */
  intentionalWaits: Map<string, number>;
  results: MatchRunResult[];
  /** 执裁中止、遗留在进行中的比赛：记为发现后不再占住场地，否则整个场地永远停摆。 */
  abandoned: Set<string>;
  /** 真正在执裁（已读到权威状态、开始打分）的比赛 → 开始时刻。取得控制后因名单未齐放回的不算，卡住判定只看它。 */
  playing: Map<string, number>;
  /** 最近一次看到系统有实际进展（新事件或比赛状态变化）的时刻，由 run.ts 的进展探针更新。 */
  lastProgressAt: number;
  /** 注入借用的场地 → 比赛：本场地的调度协程打完手上这场后停下，等注入把借用的比赛打完。 */
  borrowedCourts: Map<string, string>;
  stop: boolean;
}

export async function courtLoop(options: {
  context: RunContext;
  tournament: TournamentRuntime;
  court: { id: string; name: string };
  /** 场地平板（场地固定设备）；个人设备模式下为 null。逐场指派模式下平板交接时退出上一个人、由到场裁判登录。 */
  device: Client | null;
  cache: MatchSource;
  registry: LiveRegistry;
  rng: Rng;
  clock: Clock;
}) {
  const { context, tournament, court, device, cache, registry, rng, clock } = options;
  const perMatch = tournament.plan.refereeMode === "PER_MATCH";
  const notedUnplaced = new Set<string>();
  const notedUnassigned = new Set<string>();
  /** 逐场指派：本场地开始等某名裁判到场的时刻（按比赛）。 */
  const waitingSince = new Map<string, number>();
  /** 名单未齐（match_not_ready）的团体小场 → 暂缓到何时。暂缓期间本场地先打别的比赛，避免队头一场开不了就堵住整块场地。 */
  const notReadyUntil = new Map<string, number>();
  while (!registry.stop) {
    if (registry.borrowedCourts.has(court.id)) {
      await sleep(1000);
      continue;
    }
    let view;
    try {
      view = await cache.get();
    } catch (error) {
      context.log(`${court.name} 读取赛程失败：${error instanceof Error ? error.message : String(error)}`);
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
      .filter((match) => match.status === "NOT_STARTED" && !registry.active.has(match.code) && !registry.abandoned.has(match.code) && !tournament.heldMatches.has(match.code))
      .filter((match) => match.court?.id === court.id || (!match.court && match.sideA !== "待定"))
      .filter((match) => match.sideA !== "待定")
      .filter((match) => (notReadyUntil.get(match.code) ?? 0) <= Date.now())
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
    // 上面的人员判断跨过了 await：别的场地协程可能刚开了一场同一选手的比赛。这里同步再核对一次（之后到 active.set 之间没有 await）。
    const claimed = new Set([...registry.activePlayers.values()].flat());
    if ((players.get(next.code) ?? []).some((id) => claimed.has(id))) {
      await sleep(500);
      continue;
    }

    // 谁来执裁。
    let official: Official | null;
    if (perMatch) {
      if (!next.refereeUserId) {
        if (!notedUnassigned.has(next.code)) {
          notedUnassigned.add(next.code);
          addFinding(context, { kind: "observation", area: "裁判轮换", title: `${next.code} 没有有效的主裁判指派，场地无法开赛`, detail: { matchCode: next.code, court: court.name } });
        }
        await sleep(1500);
        continue;
      }
      official = tournament.officials.find((item) => item.userId === next.refereeUserId) ?? null;
      if (!official) {
        if (!notedUnassigned.has(next.code)) {
          notedUnassigned.add(next.code);
          addFinding(context, { kind: "script_error", area: "裁判轮换", title: `${next.code} 指派的裁判不在仿真名册中`, detail: { matchCode: next.code, refereeUserId: next.refereeUserId } });
        }
        await sleep(1500);
        continue;
      }
      if (!available(official)) {
        // 人不到场就不开赛：在休息或还在别场执裁。
        if (!waitingSince.has(next.code)) waitingSince.set(next.code, Date.now());
        await sleep(1000);
        continue;
      }
    } else {
      official = pickSharedOfficial(tournament.officials);
      if (!official) {
        await sleep(1000);
        continue;
      }
    }
    if (!checkIn(context, official, next.code)) {
      await sleep(1000);
      continue;
    }
    const waitedMs = waitingSince.has(next.code) ? Date.now() - waitingSince.get(next.code)! : 0;
    waitingSince.delete(next.code);

    if (!next.court && !notedUnplaced.has(next.code)) {
      notedUnplaced.add(next.code);
      addFinding(context, { kind: "observation", area: "调度", title: `未排场地的比赛 ${next.code} 由 ${court.name} 接手`, detail: { matchCode: next.code } });
    }
    registry.active.set(next.code, court.id);
    registry.activePlayers.set(next.code, players.get(next.code) ?? []);
    const startedAt = Date.now();
    let outcome = "not_started";
    let client: Client;
    try {
      client = device ?? official.client!;
      if (device && perMatch && device.userId !== official.userId) {
        // 场地平板交接：退出上一名裁判，由到场的这名裁判用自己的账号登录（§13.9 场地固定设备）。
        const handoverStarted = Date.now();
        if (device.signedIn) await device.signOut();
        const password = official.login === context.refereeLogin.login ? context.refereeLogin.password : context.secrets[official.login];
        const signedIn = await device.signIn(official.login, password, { maxWaitMs: 10 * 60_000 });
        official.handovers.push({ matchCode: next.code, ms: Date.now() - handoverStarted, rateLimited: signedIn.rateLimited });
      }
      if (perMatch) {
        // 本人的「我的执裁」里应当有这场（系统指派可见）。
        const mine = await new OfficiatingCache(official.userId, tournament.slug, 0).get(true);
        if (!mine.matches.some((match) => match.code === next.code)) {
          addFinding(context, { kind: "unexpected", area: "裁判轮换", title: `${next.code} 的指派裁判 ${official.key} 在「我的执裁」里看不到这场`, detail: { matchCode: next.code, official: official.key } });
        }
      }
      const spec = tournament.forced.get(next.code);
      const narrativeRng = rng.fork(`narrative:${next.code}`);
      const narrative = spec ? Narrative.forced(spec, narrativeRng) : Narrative.pick(narrativeRng);
      const driver = new MatchDriver(client, next.code, rng.uuid(), narrative, clock, rng.fork(`rally:${next.code}`));
      const acquired = await driver.acquire();
      if (!acquired.ok) {
        context.log(`${court.name} 取得 ${next.code} 控制失败：${acquired.status} ${acquired.code}`);
        outcome = `acquire_${acquired.status}`;
        // 5xx / 网络错误是暂时的（数据库故障注入期间），稍后再来；其余拒绝说明这场开不了。
        if (acquired.status !== 409 && acquired.status !== 0 && acquired.status < 500) registry.abandoned.add(next.code);
        await sleep(2000);
        continue;
      }
      const first = await driver.refresh();
      if (!first.ok) {
        // 团体小场在双方名单交齐前取得控制会成功，但读状态得到 match_not_ready：放回控制、稍后再来。
        await driver.release();
        outcome = first.code ?? "state_failed";
        if (first.code === "match_not_ready") notReadyUntil.set(next.code, Date.now() + 15_000);
        if (first.code !== "match_not_ready" && first.status !== 0 && first.status < 500) {
          registry.abandoned.add(next.code);
          addFinding(context, { kind: "blocked", area: "执裁", title: `${next.code} 读取权威状态失败`, detail: { status: first.status, code: first.code, message: first.message } });
        }
        await sleep(2000);
        continue;
      }
      registry.playing.set(next.code, Date.now());
      const special = await specialFor(tournament, next.code);
      const result = await driver.play({ special }).finally(() => registry.playing.delete(next.code));
      result.official = official.key;
      result.officialUserId = official.userId;
      registry.results.push(result);
      registry.lastProgressAt = Date.now();
      outcome = result.outcome;
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
      registry.activePlayers.delete(next.code);
      cache.invalidate();
      if (outcome === "submitted" || outcome === "stopped" || outcome === "failed") {
        checkOut(official, { matchCode: next.code, courtId: court.id, start: startedAt, end: Date.now(), waitedMs, outcome }, clock, rng.fork(`rest:${official.key}:${next.code}`));
        // 个人设备：休息时偶尔退出登录再登录、或清空 Cookie 再登录（登录会话 7 天不过期，用这两种方式代替自然过期）。
        if (!device && official.client && official.restUntil > Date.now()) {
          const roll = rng.next();
          if (roll < 0.25) void relogin(context, official, roll < 0.12 ? "sign-out" : "clear-cookies");
        }
      } else {
        // 没有真正执裁（名单未齐、控制被占）：人回到空闲，不计入轮换。
        official.busyWith = null;
      }
    }
  }
}

async function relogin(context: RunContext, official: Official, kind: "sign-out" | "clear-cookies") {
  const client = official.client!;
  const started = Date.now();
  // 重新登录期间人不可派（还没登进来）。
  official.busyWith = `relogin:${kind}`;
  try {
    if (kind === "sign-out") await client.signOut();
    else client.clearCookies();
    const password = official.login === context.refereeLogin.login ? context.refereeLogin.password : context.secrets[official.login];
    const result = await client.signIn(official.login, password, { maxWaitMs: 10 * 60_000 });
    official.relogins.push({ kind, ms: Date.now() - started, rateLimited: result.rateLimited });
  } catch (error) {
    addFinding(context, { kind: "unexpected", area: "登录会话", title: `${official.key} ${kind === "sign-out" ? "退出后" : "清空 Cookie 后"}重新登录失败`, detail: { message: error instanceof Error ? error.message : String(error) } });
  } finally {
    official.busyWith = null;
  }
}

/**
 * 本场按计划录入的特殊结果（M5，§6）：先看指定到场次的计划，再看双方是否已退出比赛——
 * 一方退出记弃权（WO，对方胜），双方都退出记中止（ABANDONED，无胜方）。团体小场不在这里处理（退出的队不交名单）。
 */
export async function specialFor(tournament: TournamentRuntime, code: string): Promise<SpecialPlan | null> {
  const planned = tournament.specials.get(code);
  if (planned) return planned;
  if (!tournament.withdrawn.size && !tournament.specialHooks.length) return null;
  const row = await prisma.match.findUnique({
    where: { code },
    select: { sideAEntryId: true, sideBEntryId: true, rubberKind: true, groupId: true, stage: { select: { competition: { select: { code: true } } } }, fixture: { select: { round: true, kind: true } } },
  });
  if (!row) return null;
  const facts: SpecialHookMatch = {
    code,
    competitionCode: row.stage.competition.code,
    groupId: row.groupId,
    round: row.fixture?.round ?? null,
    fixtureKind: row.fixture?.kind ?? null,
    sideAEntryId: row.sideAEntryId,
    sideBEntryId: row.sideBEntryId,
  };
  // 指定规则只用于个人比赛；退出的队在团体小场上按弃权录（前提是名单已交，否则小场根本载入不了）。
  for (const hook of row.rubberKind ? [] : tournament.specialHooks) {
    const plan = hook(facts);
    if (plan) return plan;
  }
  const outA = Boolean(row.sideAEntryId && tournament.withdrawn.has(row.sideAEntryId));
  const outB = Boolean(row.sideBEntryId && tournament.withdrawn.has(row.sideBEntryId));
  if (outA && outB) return { type: "ABANDONED", loser: null, at: null, reason: "仿真：双方均已退出比赛，未到场" };
  if (outA || outB) {
    const reason = tournament.withdrawn.get((outA ? row.sideAEntryId : row.sideBEntryId)!)!.reason;
    return { type: "WO", loser: outA ? "A" : "B", at: null, reason: `仿真：${reason}，未到场弃权` };
  }
  return null;
}

function sortKey(match: VenueMatch) {
  return match.scheduledAt ? new Date(match.scheduledAt).getTime() : Number.MAX_SAFE_INTEGER;
}

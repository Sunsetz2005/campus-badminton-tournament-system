/**
 * 裁判（人）与轮换（§13.9）。仿真内部维护「裁判」实体：姓名、所在位置、手上的设备、执裁记录。
 *
 * - 逐场指派模式（PER_MATCH）：每名裁判是一个独立账号，由管理员经 `POST .../referees` 开通；
 *   个人设备＝每人一个登录会话（M3 只跑个人设备；场地固定设备的交接在 M5）。下一场由谁执裁**以系统指派为准**，
 *   仿真只决定这个人什么时候到场：人在休息或还在别场，就不开赛。
 * - 共用账号模式（SHARED_ACCOUNT）：系统里没有「具名裁判」，仿真用自己的轮换表决定谁上场（取执裁最少的空闲者），
 *   设备是场地平板；系统不知道是谁在执裁（判定里标为设计未定义）。
 *
 * 轮换节奏：每人连续执裁 1—2 场后下场休息，休息时长为现实 5—15 分钟（经压缩时钟）。
 */
import type { Clock } from "../core/clock";
import { Client } from "../core/http";
import type { Rng } from "../core/rng";
import type { RunContext, TournamentRuntime } from "../scenario/context";
import { addFinding } from "../scenario/context";

export interface OfficialAssignmentLog {
  matchCode: string;
  courtId: string | null;
  start: number;
  end: number;
  /** 场地等这名裁判到场的时长（毫秒）。只在逐场指派模式下有意义。 */
  waitedMs: number;
  outcome: string;
}

export interface Official {
  key: string;
  name: string;
  login: string;
  userId: string;
  /** 个人设备（逐场指派模式）；共用账号模式下为 null，用场地平板。 */
  client: Client | null;
  busyWith: string | null;
  restUntil: number;
  streak: number;
  streakTarget: number;
  log: OfficialAssignmentLog[];
  rests: number[];
  longestStreak: number;
  /** 场地平板交接（逐场指派 + 场地固定设备）：退出上一个人、本人登录的耗时与被限流次数。 */
  handovers: { matchCode: string; ms: number; rateLimited: number }[];
  /** 个人设备的「退出后重新登录」「清空 Cookie 后重新登录」（§13.9 登录与会话）。 */
  relogins: { kind: "sign-out" | "clear-cookies"; ms: number; rateLimited: number }[];
}

export function createOfficialRecord(key: string, name: string, login: string, userId: string, client: Client | null, rng: Rng): Official {
  return { key, name, login, userId, client, busyWith: null, restUntil: 0, streak: 0, streakTarget: rng.int(1, 2), log: [], rests: [], longestStreak: 0, handovers: [], relogins: [] };
}

/**
 * 开赛前的集中登录（§13.9）：在现实 10 分钟（经压缩时钟）里随机错开、并发登录。登录按 Better Auth 限流自动退避，
 * 被限流次数与全部登入耗时记进 authLog（§13.2 同出口时必然遇到 429）。
 */
async function loginBurst(context: RunContext, items: { client: Client; login: string; password: string }[]) {
  const rng = context.rng.fork("officials:login");
  const windowMs = context.clock.ms(10 * 60);
  const startedAt = Date.now();
  const results = await Promise.all(items.map(async (item) => {
    await new Promise((resolve) => setTimeout(resolve, rng.int(0, windowMs)));
    return item.client.signIn(item.login, item.password, { maxWaitMs: 10 * 60_000 });
  }));
  return { ms: Date.now() - startedAt, rateLimited: results.reduce((sum, item) => sum + item.rateLimited, 0) };
}

/**
 * 逐场指派模式：开通具名裁判账号。个人设备模式下每人一台手机并集中登录；场地固定设备模式下不登录，
 * 到场后在场地平板上登录（venue.ts 记交接耗时）。
 */
export async function provisionNamedReferees(context: RunContext, tournament: TournamentRuntime, count: number) {
  const rng = context.rng.fork(`officials:${tournament.plan.key}`);
  const officials: Official[] = [];
  const startedAt = Date.now();
  for (let index = 0; index < count; index += 1) {
    const key = `R${String(index + 1).padStart(2, "0")}`;
    const username = `ref_${context.runId}_${tournament.plan.key}_${index + 1}`.toLowerCase();
    const name = `仿真裁判${key}`;
    const created = await context.admin.must<{ userId: string; password: string | null }>("POST", `/api/admin/tournaments/${tournament.slug}/referees`, { username, name }, {
      route: "/api/admin/tournaments/[slug]/referees",
    });
    context.secrets[username] = created.password ?? "";
    const client = tournament.deviceMode === "personal" ? new Client(context.origin, `phone-${tournament.plan.key}-${key}`, context.metrics, context.nextIp()) : null;
    officials.push(createOfficialRecord(key, name, username, created.userId, client, rng.fork(key)));
  }
  if (tournament.deviceMode === "personal") {
    const burst = await loginBurst(context, officials.map((official) => ({ client: official.client!, login: official.login, password: context.secrets[official.login] })));
    context.log(`具名裁判 ${count} 人开通并集中登录（${Math.round((Date.now() - startedAt) / 1000)} 秒，登录被限流 ${burst.rateLimited} 次）`);
  } else {
    context.log(`具名裁判 ${count} 人开通（场地固定设备：到场后在场地平板上登录）`);
  }
  tournament.officials = officials;
  return officials;
}

/**
 * 共用账号模式：仿真裁判（只存在于仿真内部）。场地固定设备时都用场地平板；
 * 个人设备时每人一台手机，同一共用账号集中登录，形成同一账号的多个登录会话。
 */
export async function simulatedOfficials(context: RunContext, tournament: TournamentRuntime, count: number, sharedUserId: string) {
  const rng = context.rng.fork(`officials:${tournament.plan.key}`);
  tournament.officials = Array.from({ length: count }, (_, index) => {
    const key = `R${String(index + 1).padStart(2, "0")}`;
    const client = tournament.deviceMode === "personal" ? new Client(context.origin, `phone-${tournament.plan.key}-${key}`, context.metrics, context.nextIp()) : null;
    return createOfficialRecord(key, `仿真裁判${key}`, context.refereeLogin.login, sharedUserId, client, rng.fork(key));
  });
  if (tournament.deviceMode === "personal") {
    const burst = await loginBurst(context, tournament.officials.map((official) => ({ client: official.client!, login: context.refereeLogin.login, password: context.refereeLogin.password })));
    context.log(`共用账号 ${count} 台个人设备集中登录（${Math.round(burst.ms / 1000)} 秒，登录被限流 ${burst.rateLimited} 次）`);
  }
  return tournament.officials;
}

export function available(official: Official, now = Date.now()) {
  return !official.busyWith && official.restUntil <= now;
}

/** 共用账号模式下由仿真挑人：空闲者里执裁最少的。 */
export function pickSharedOfficial(officials: Official[]) {
  return officials.filter((official) => available(official)).sort((x, y) => x.log.length - y.log.length || x.key.localeCompare(y.key))[0] ?? null;
}

/** 上场：同一人不得同时在两场（仿真自身的不变量，违反即脚本错误）。 */
export function checkIn(context: RunContext, official: Official, matchCode: string) {
  if (official.busyWith) {
    addFinding(context, { kind: "script_error", area: "裁判轮换", title: `${official.key} 已在 ${official.busyWith} 执裁，又被派到 ${matchCode}`, detail: { official: official.key } });
    return false;
  }
  official.busyWith = matchCode;
  return true;
}

/** 下场：按轮换节奏决定是否休息。 */
export function checkOut(official: Official, entry: OfficialAssignmentLog, clock: Clock, rng: Rng) {
  official.busyWith = null;
  official.log.push(entry);
  official.streak += 1;
  official.longestStreak = Math.max(official.longestStreak, official.streak);
  if (official.streak >= official.streakTarget) {
    const rest = clock.ms(rng.int(5 * 60, 15 * 60));
    official.restUntil = Date.now() + rest;
    official.rests.push(rest);
    official.streak = 0;
    official.streakTarget = rng.int(1, 2);
  }
}

/** 报告「裁判轮换」一节的统计（只统计，不判错）。 */
export function rotationStats(officials: Official[]) {
  const per = officials.map((official) => {
    return {
      key: official.key,
      matches: official.log.length,
      officiatingMinutes: Math.round(official.log.reduce((sum, entry) => sum + (entry.end - entry.start), 0) / 6000) / 10,
      longestStreak: official.longestStreak,
      restSeconds: official.rests.map((value) => Math.round(value / 1000)),
      waitedSeconds: Math.round(official.log.reduce((sum, entry) => sum + entry.waitedMs, 0) / 1000),
      handovers: official.handovers.length,
      relogins: official.relogins.length,
    };
  });
  const counts = per.map((item) => item.matches).sort((a, b) => a - b);
  const handovers = officials.flatMap((official) => official.handovers).map((item) => item.ms).sort((a, b) => a - b);
  const relogins = officials.flatMap((official) => official.relogins);
  return {
    officials: per,
    handover: handovers.length
      ? { count: handovers.length, medianMs: handovers[Math.floor(handovers.length / 2)], maxMs: handovers[handovers.length - 1], rateLimited: officials.flatMap((official) => official.handovers).reduce((sum, item) => sum + item.rateLimited, 0) }
      : null,
    relogin: relogins.length ? { count: relogins.length, byKind: Object.fromEntries(["sign-out", "clear-cookies"].map((kind) => [kind, relogins.filter((item) => item.kind === kind).map((item) => item.ms)])) } : null,
    matchesPerOfficial: counts.length ? { min: counts[0], median: counts[Math.floor(counts.length / 2)], max: counts[counts.length - 1] } : null,
    unused: per.filter((item) => item.matches === 0).map((item) => item.key),
  };
}

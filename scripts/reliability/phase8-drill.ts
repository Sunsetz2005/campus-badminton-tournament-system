/**
 * 阶段 8：小规模校园赛事负载基准 + 服务器重启演练。可复现，只连接 `_test` 库。
 *
 * 前置：
 *   pnpm run db:test:prepare
 *   pnpm exec dotenv -e .env.test -- tsx scripts/build-production-startup-test.ts   # 生产构建
 * 运行：
 *   pnpm exec dotenv -e .env.test -- tsx scripts/reliability/phase8-drill.ts
 * 可调：MATCHES（≤6）、RALLIES、RALLY_PACE_MS（默认 1000）、PUBLIC_READERS、REFEREE_READERS、PUBLIC_INTERVAL_MS（默认 10000，
 * 与公开比分页一致）、REFEREE_INTERVAL_MS（默认 2000，与裁判工作台一致）、PUBLIC_RATE_LIMIT_PER_MINUTE。
 * 所有读者来自本机同一地址，相当于校园网出口 NAT 后的一群观众，会共同消耗同一份公开限流额度。
 *
 * 做什么：
 * 1. 以生产模式（`next start`，不带示例账号配置与故障注入）在 BETTER_AUTH_URL 的端口启动服务；
 * 2. 同一裁判账号在 N 场比赛上各取得控制权，并发逐分记分；同时有 P 个未登录观众轮询公开比赛详情、
 *    R 个裁判只读端轮询权威状态；统计命令与读取延迟、错误、限流次数、写入→公开可见延迟；
 * 3. 重启演练：记一分 → 停止服务器 → 重新启动 → 同一会话 Cookie、同一控制令牌下验证：
 *    原 commandId 可找回、同内容重发只算一次、同 ID 异内容被拒、旧版本被拒、继续记分成功；
 * 4. 把用到的比赛恢复为种子时的全新 0:0 状态（与 e2e 夹具相同的复位），删除本脚本登录产生的会话。
 *
 * 结果写到 artifacts/phase8-mobile/local-run/drill-<时间>.json；只报告实际测到的数字。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

assertTestDatabaseUrl(process.env.DATABASE_URL);

const BASE = new URL(process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3100");
const ORIGIN = BASE.origin;
const PORT = BASE.port || "3100";
/** 数值参数必须是非负整数；非法值直接报错，避免静默跑出 0 个读者这类假结果。 */
function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name}=${JSON.stringify(raw)} 不是非负整数。`);
  return value;
}
const MATCH_CODES = ["MS-DEMO-001", "MD-DEMO-002", "MS-FRESH-001", "MS-FRESH-002", "MD-FRESH-001", "MD-FRESH-002"];
const MATCHES = Math.min(numberEnv("MATCHES", 6), MATCH_CODES.length);
const RALLIES = numberEnv("RALLIES", 40);
// 每场两分之间的间隔。0 = 突发写入（压测上限）；真实回合约 10—20 秒，默认 1 秒已是现实节奏的十倍以上。
const RALLY_PACE_MS = numberEnv("RALLY_PACE_MS", 1_000);
const PUBLIC_READERS = numberEnv("PUBLIC_READERS", 80);
const REFEREE_READERS = numberEnv("REFEREE_READERS", 6);
const PUBLIC_INTERVAL_MS = numberEnv("PUBLIC_INTERVAL_MS", 10_000);
const REFEREE_INTERVAL_MS = numberEnv("REFEREE_INTERVAL_MS", 2_000);
const SLUG = "phase-1-demo";
const outDir = path.join(process.cwd(), "artifacts", "phase8-mobile", "local-run");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const serverLog = createWriteStream(path.join(outDir, `drill-server-${stamp}.log`));

type Json = Record<string, unknown> & { state?: MatchStateLite; version?: number };
type MatchStateLite = {
  version: number;
  phase: string;
  format: "SINGLES" | "DOUBLES";
  players: { A: string[]; B: string[] };
  pendingObligations: { id: string; type: string }[];
  servingSide: "A" | "B" | null;
};

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]);
}
function summary(values: number[]) {
  return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) };
}

// ---------- 服务器进程 ----------
let server: ChildProcess | null = null;
function serverEnv() {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("DEMO_")) delete env[key];
  return {
    ...env,
    NODE_ENV: "production",
    ALLOW_DEMO_ACCOUNTS: "false",
    ENABLE_TEST_FAULT_INJECTION: "false",
    ENABLE_PUBLIC_UI_PREVIEW: "false",
    BETTER_AUTH_SECRET: "production-startup-test-secret-with-more-than-32-characters",
  };
}
async function startServer() {
  const startedAt = Date.now();
  const child: ChildProcess = spawn("pnpm", ["exec", "tsx", "scripts/start-production-server.ts", "--", "--hostname", BASE.hostname, "--port", PORT], {
    env: serverEnv() as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = child;
  child.stdout?.pipe(serverLog, { end: false });
  child.stderr?.pipe(serverLog, { end: false });
  for (;;) {
    try {
      const response = await fetch(`${ORIGIN}/api/health`);
      if (response.ok) return Date.now() - startedAt;
    } catch {
      // 尚未监听
    }
    if (Date.now() - startedAt > 60_000) throw new Error("生产服务 60 秒内未就绪，见 drill-server 日志。");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
async function stopServer() {
  if (!server) return;
  const child = server;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
  server = null;
  // 等端口真正释放
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(`${ORIGIN}/api/health`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      return;
    }
  }
}

// ---------- HTTP ----------
async function signIn(email: string, password: string) {
  const response = await fetch(`${ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`登录失败 ${response.status} ${await response.text()}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function call(method: string, url: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  const response = await fetch(`${ORIGIN}${url}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json", Origin: ORIGIN } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json().catch(() => null)) as Json | null;
  return { status: response.status, json, ms: performance.now() - started };
}

// ---------- 夹具复位（与 e2e 相同：只动这几场比赛） ----------
async function resetMatches(codes: string[]) {
  const matches = await prisma.match.findMany({ where: { code: { in: codes } }, select: { id: true } });
  const ids = matches.map((item) => item.id);
  await prisma.matchEvent.deleteMany({ where: { matchId: { in: ids } } });
  await prisma.matchSnapshot.deleteMany({ where: { matchId: { in: ids } } });
  await prisma.resultRevision.deleteMany({ where: { matchId: { in: ids } } });
  await prisma.scoringSession.deleteMany({ where: { matchId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
  await prisma.game.updateMany({ where: { matchId: { in: ids } }, data: { scoreA: 0, scoreB: 0, completed: false } });
  await prisma.match.updateMany({
    where: { id: { in: ids } },
    data: { version: 0, controlGeneration: 1, lifecycleStatus: "READY", outcomeType: null, verificationStatus: "UNVERIFIED", startedAt: null, endedAt: null },
  });
}

// ---------- 记分端 ----------
type Control = { controlToken: string; sessionId: string; takeoverGeneration: number };
const commandLatency: number[] = [];
const commandErrors: Record<string, number> = {};
const acks = new Map<string, { version: number; at: number }[]>();

function envelope(control: Control, state: MatchStateLite, type: string, payload: unknown) {
  return {
    commandId: randomUUID(),
    occurredAt: new Date().toISOString(),
    expectedVersion: state.version,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type,
    payload,
  };
}

async function send(code: string, cookie: string, control: Control, state: MatchStateLite, type: string, payload: unknown) {
  const body = envelope(control, state, type, payload);
  const result = await call("POST", `/api/matches/${code}/commands`, cookie, body, { Authorization: `Bearer ${control.controlToken}` });
  commandLatency.push(result.ms);
  if (result.status !== 201) {
    const key = `${result.status}:${(result.json?.error as { code?: string } | undefined)?.code ?? "?"}`;
    commandErrors[key] = (commandErrors[key] ?? 0) + 1;
    throw new Error(`${code} ${type} → ${key}`);
  }
  const next = result.json!.state as MatchStateLite;
  const list = acks.get(code) ?? [];
  list.push({ version: next.version, at: Date.now() });
  acks.set(code, list);
  return { state: next, envelope: body };
}

async function openMatch(code: string, cookie: string) {
  const acquired = await call("POST", `/api/matches/${code}/control`, cookie, { deviceSessionId: randomUUID() });
  if (acquired.status !== 201) throw new Error(`${code} 取得控制失败 ${acquired.status} ${JSON.stringify(acquired.json)}`);
  const control = acquired.json as unknown as Control;
  let state = (await call("GET", `/api/matches/${code}/state`, cookie)).json!.state as MatchStateLite;
  state = (await send(code, cookie, control, state, "RECORD_COIN_TOSS", {
    valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" },
  })).state;
  const courts = state.format === "DOUBLES"
    ? { A: { R: state.players.A[0], L: state.players.A[1] }, B: { R: state.players.B[0], L: state.players.B[1] } }
    : null;
  state = (await send(code, cookie, control, state, "CONFIRM_OPENING_SETUP", {
    serverPlayerId: state.players.A[0], receiverPlayerId: state.players.B[0], logicalCourts: courts,
  })).state;
  return { control, state };
}

/** 单场出错时记录并停止该场，不中断其他比赛与读者，最后如实报告。 */
const matchFailures: Record<string, string> = {};
async function scoreMatch(code: string, cookie: string, control: Control, initial: MatchStateLite) {
  try {
    return await scoreMatchUnsafe(code, cookie, control, initial);
  } catch (error) {
    matchFailures[code] = error instanceof Error ? error.message : String(error);
    const latest = (await call("GET", `/api/matches/${code}/state`, cookie)).json?.state as MatchStateLite | undefined;
    return latest ?? initial;
  }
}

async function scoreMatchUnsafe(code: string, cookie: string, control: Control, initial: MatchStateLite) {
  let state = initial;
  let lastHeartbeat = Date.now();
  for (let rally = 0; rally < RALLIES; rally += 1) {
    while (state.pendingObligations.length) {
      const obligation = state.pendingObligations[0];
      state = (await send(code, cookie, control, state, obligation.type === "INTERVAL" ? "ACKNOWLEDGE_INTERVAL" : "CONFIRM_CHANGE_ENDS", { obligationId: obligation.id })).state;
    }
    if (RALLY_PACE_MS > 0 && rally > 0) await new Promise((resolve) => setTimeout(resolve, RALLY_PACE_MS));
    state = (await send(code, cookie, control, state, "RALLY_WON", { side: rally % 2 === 0 ? "A" : "B" })).state;
    if (Date.now() - lastHeartbeat > 20_000) {
      await call("PUT", `/api/matches/${code}/control/heartbeat`, cookie,
        { scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration },
        { Authorization: `Bearer ${control.controlToken}` });
      lastHeartbeat = Date.now();
    }
  }
  return state;
}

// ---------- 只读端 ----------
const stop = { done: false };
const readLatency = { public: [] as number[], referee: [] as number[] };
const readErrors: Record<string, number> = {};
const observations = new Map<string, { version: number; at: number; reader: number }[]>();
let readerSequence = 0;

async function reader(kind: "public" | "referee", code: string, cookie: string | null, offset: number) {
  const interval = kind === "public" ? PUBLIC_INTERVAL_MS : REFEREE_INTERVAL_MS;
  const readerId = (readerSequence += 1);
  await new Promise((resolve) => setTimeout(resolve, offset));
  while (!stop.done) {
    const url = kind === "public" ? `/api/public/tournaments/${SLUG}/matches/${code}` : `/api/matches/${code}/state`;
    try {
      const result = await call("GET", url, cookie);
      readLatency[kind].push(result.ms);
      if (result.status !== 200) {
        readErrors[`${kind}:${result.status}`] = (readErrors[`${kind}:${result.status}`] ?? 0) + 1;
      } else if (kind === "public") {
        const version = ((result.json as { match?: { scoreVersion?: number } }).match?.scoreVersion) ?? -1;
        const list = observations.get(code) ?? [];
        list.push({ version, at: Date.now(), reader: readerId });
        observations.set(code, list);
      }
    } catch {
      readErrors[`${kind}:network`] = (readErrors[`${kind}:network`] ?? 0) + 1;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * 两种口径：
 * - anyViewer：该比分被「任意一位」观众最早看到的延迟（观众越多越小，只说明服务端投影已更新）；
 * - perViewer：每位观众各自看到该比分的延迟（主要取决于轮询间隔，这才是单个观众的体验）。
 */
function visibilityDelays() {
  const anyViewer: number[] = [];
  const perViewer: number[] = [];
  for (const [code, list] of acks) {
    const seen = observations.get(code) ?? [];
    const byReader = new Map<number, typeof seen>();
    for (const item of seen) byReader.set(item.reader, [...(byReader.get(item.reader) ?? []), item]);
    for (const ack of list) {
      const first = seen.find((item) => item.version >= ack.version);
      if (first) anyViewer.push(Math.max(0, first.at - ack.at));
      for (const readerSeen of byReader.values()) {
        if (!readerSeen.some((item) => item.at < ack.at)) continue; // 该观众此时尚未开始观看
        const hit = readerSeen.find((item) => item.version >= ack.version);
        if (hit) perViewer.push(Math.max(0, hit.at - ack.at));
      }
    }
  }
  return { anyViewer: summary(anyViewer), perViewer: summary(perViewer) };
}

// ---------- 主流程 ----------
async function main() {
  const email = process.env.DEMO_REFEREE_EMAIL;
  const password = process.env.DEMO_REFEREE_PASSWORD;
  if (!email || !password) throw new Error(".env.test 缺少 DEMO_REFEREE_EMAIL / DEMO_REFEREE_PASSWORD。");
  const codes = MATCH_CODES.slice(0, MATCHES);
  await resetMatches(codes);

  const environment = {
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model} × ${os.cpus().length}`,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    postgres: ((await prisma.$queryRawUnsafe<{ version: string }[]>("select version()"))[0]?.version ?? "").split(",")[0],
    server: "next start（生产构建），与数据库、压测客户端同在本机",
    publicRateLimitPerMinute: process.env.PUBLIC_RATE_LIMIT_PER_MINUTE ?? "默认 600",
  };

  const firstStartMs = await startServer();
  const cookie = await signIn(email, password);

  // 1. 负载
  const opened = await Promise.all(codes.map(async (code) => ({ code, ...(await openMatch(code, cookie)) })));
  const readers = [
    ...Array.from({ length: PUBLIC_READERS }, (_, index) => reader("public", codes[index % codes.length], null, Math.round((index / Math.max(1, PUBLIC_READERS)) * PUBLIC_INTERVAL_MS))),
    ...Array.from({ length: REFEREE_READERS }, (_, index) => reader("referee", codes[index % codes.length], cookie, Math.round((index / Math.max(1, REFEREE_READERS)) * REFEREE_INTERVAL_MS))),
  ];
  const loadStarted = Date.now();
  const scored = await Promise.all(opened.map((item) => scoreMatch(item.code, cookie, item.control, item.state)));
  const loadMs = Date.now() - loadStarted;
  await new Promise((resolve) => setTimeout(resolve, PUBLIC_INTERVAL_MS + 500)); // 让读者看到最后一分
  stop.done = true;
  await Promise.all(readers);

  const eventsWritten = await prisma.matchEvent.count({ where: { match: { code: { in: codes } } } });
  const load = {
    matches: codes.length,
    ralliesPerMatch: RALLIES,
    rallyPaceMs: RALLY_PACE_MS,
    publicReaders: PUBLIC_READERS,
    refereeReaders: REFEREE_READERS,
    publicIntervalMs: PUBLIC_INTERVAL_MS,
    refereeIntervalMs: REFEREE_INTERVAL_MS,
    durationMs: loadMs,
    commandsAccepted: commandLatency.length - Object.values(commandErrors).reduce((a, b) => a + b, 0),
    eventsInDatabase: eventsWritten,
    commandLatencyMs: summary(commandLatency),
    commandErrors,
    matchFailures,
    commandsPerSecond: Math.round((commandLatency.length / (loadMs / 1000)) * 10) / 10,
    publicReadLatencyMs: summary(readLatency.public),
    refereeReadLatencyMs: summary(readLatency.referee),
    readErrors,
    writeToPublicVisibleMs: visibilityDelays(),
    finalVersions: Object.fromEntries(scored.map((state, index) => [codes[index], state.version])),
  };
  console.info("负载结果", JSON.stringify(load, null, 2));

  // 2. 重启演练（用第一场比赛）
  const targetIndex = Math.max(0, opened.findIndex((item) => !matchFailures[item.code]));
  const target = opened[targetIndex];
  let state = scored[targetIndex];
  const beforeRestart = await send(target.code, cookie, target.control, state, "RALLY_WON", { side: "A" });
  state = beforeRestart.state;
  const eventsBefore = await prisma.matchEvent.count({ where: { match: { code: target.code } } });
  const stopAt = Date.now();
  await stopServer();
  const downDuringRestart = await fetch(`${ORIGIN}/api/health`).then(() => false, () => true);
  const restartMs = await startServer();
  const outageMs = Date.now() - stopAt;

  const sessionAfter = await call("GET", `/api/matches/${target.code}/state`, cookie);
  const lookup = await call("GET", `/api/matches/${target.code}/commands/${beforeRestart.envelope.commandId}`, cookie);
  const resend = await call("POST", `/api/matches/${target.code}/commands`, cookie, beforeRestart.envelope, { Authorization: `Bearer ${target.control.controlToken}` });
  const mutated = await call("POST", `/api/matches/${target.code}/commands`, cookie,
    { ...beforeRestart.envelope, payload: { side: "B" } }, { Authorization: `Bearer ${target.control.controlToken}` });
  const eventsAfterResend = await prisma.matchEvent.count({ where: { match: { code: target.code } } });
  const stale = await call("POST", `/api/matches/${target.code}/commands`, cookie,
    envelope(target.control, { ...state, version: state.version - 1 }, "RALLY_WON", { side: "A" }), { Authorization: `Bearer ${target.control.controlToken}` });
  const next = await call("POST", `/api/matches/${target.code}/commands`, cookie,
    envelope(target.control, state, "RALLY_WON", { side: "B" }), { Authorization: `Bearer ${target.control.controlToken}` });

  const restart = {
    serverStoppedAndUnreachable: downDuringRestart,
    restartReadyMs: restartMs,
    totalOutageMs: outageMs,
    sessionCookieStillValid: sessionAfter.status === 200,
    versionAfterRestart: (sessionAfter.json?.version as number | undefined) ?? null,
    lookupOriginalCommandId: { status: lookup.status, version: lookup.json?.state?.version ?? lookup.json?.version ?? null },
    resendSameEnvelope: { status: resend.status, resultStatus: resend.json?.status ?? null },
    sameIdDifferentPayload: { status: mutated.status, code: (mutated.json?.error as { code?: string } | undefined)?.code ?? null },
    eventsBefore,
    eventsAfterResend,
    staleExpectedVersion: { status: stale.status, code: (stale.json?.error as { code?: string } | undefined)?.code ?? null },
    continueWithSameControl: { status: next.status, version: next.json?.state?.version ?? null },
  };
  console.info("重启演练", JSON.stringify(restart, null, 2));

  const result = { measuredAt: new Date().toISOString(), environment, firstStartMs, load, restart };
  const file = path.join(outDir, `drill-${stamp}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.info(`结果已写入 ${path.relative(process.cwd(), file)}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    stop.done = true;
    await stopServer().catch(() => undefined);
    await resetMatches(MATCH_CODES.slice(0, MATCHES)).catch(() => undefined);
    const email = process.env.DEMO_REFEREE_EMAIL;
    if (email) await prisma.session.deleteMany({ where: { user: { email } } }).catch(() => undefined);
    await prisma.$disconnect();
    serverLog.end();
  });

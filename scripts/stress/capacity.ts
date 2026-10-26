/**
 * 容量探测入口（测试方案 §13.1，M4b，P-02）。
 *
 *   pnpm run stress:capacity -- --seed 20261026 [--steps 6,12,24,48] [--external]
 *
 * 默认最快节奏（--clock BURST）：没有回合间隔、间歇与局间等待；每个并发单位是一个协程，收到上一条回应才发下一条（与工作台「一次只在途一条」一致）。
 * 每个协程负责一个 4 人小组，连续打完组内 6 场单循环（约 500 条命令，满足「每场至少 200 条命令」的口径）。
 * 并发场数按 6 → 12 → 24 → 48 逐级加压；每级用新的客户端与新的指标，互不混算。
 *
 * 每级记录：命令成功率与错误码、P50/P95/P99/最大延迟、5xx 数与首次出现时的并发数、服务端日志里的错误码、
 * 本库 `pg_stat_database.xact_rollback` 增量（重试次数的上界近似，含所有回滚）、被测服务连接峰值、
 * 每 5 秒的被测服务与仿真进程 CPU/内存及系统负载。门槛：命令 P99 < 1 秒且零 5xx。
 *
 * 所有写入只经 HTTP 接口；本进程的数据库会话是只读的（readonly-env.ts 必须最先导入）。
 */
import "./core/readonly-env";

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import type { EventPlan, LevelConfig, TournamentPlan } from "./config/levels";
import { Clock, CLOCKS, sleep } from "./core/clock";
import { groupsOf, prisma } from "./core/db";
import { Client } from "./core/http";
import { latencySummary, Metrics, type RequestRecord } from "./core/metrics";
import { Rng } from "./core/rng";
import { Server } from "./core/server";
import { Narrative } from "./live/narrative";
import { MatchDriver } from "./live/referee";
import type { RunContext, TournamentRuntime } from "./scenario/context";
import { publishDraws } from "./scenario/draw";
import { closeRegistration, mapEntries, registerIndividuals } from "./scenario/registration";
import { generateRoster } from "./scenario/roster";
import { configureSchedule, suggestAndPublish } from "./scenario/schedule";
import { createTournament } from "./scenario/setup";

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((item) => item !== "--"),
  options: {
    seed: { type: "string", default: "20261026" },
    steps: { type: "string", default: "6,12,24,48" },
    external: { type: "boolean", default: false },
    "p99-ms": { type: "string", default: "1000" },
    /** 每个并发单位打几场（组内 6 场；3 场约 250 条命令，仍满足「至少 200 条」）。 */
    "matches-per-unit": { type: "string", default: "6" },
    /** 节奏：BURST 为 §13.1 的最快节奏；C8/C3/R1 按对应时间档的回合间隔与间歇（对照「真实节奏下」的表现）。 */
    clock: { type: "string", default: "BURST" },
  },
});

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`环境文件缺少 ${name}。`);
  return value;
}

const COMMAND_ROUTE = "POST /api/matches/[code]/commands";
const GROUPS_PER_EVENT = 16;

const groupEvent = (kind: "MS" | "WS" | "MD", name: string): EventPlan => ({ kind, code: kind, name, entries: GROUPS_PER_EVENT * 4, format: "GROUPS_KNOCKOUT", groupCount: GROUPS_PER_EVENT, qualifiersPerGroup: 1, thirdPlaceMatch: false });

/** 一个容量赛事：三个项目各 16 组 × 4 人，共 48 个小组、288 场组内比赛，双方在抽签发布时就已确定。 */
const capacityPlan = (key: string): TournamentPlan => ({
  key,
  name: `容量探测 ${key}`,
  rulePreset: "traditional-21",
  refereeMode: "SHARED_ACCOUNT",
  courts: 40,
  events: [groupEvent("MS", "男子单打"), groupEvent("WS", "女子单打"), groupEvent("MD", "男子双打")],
  team: null,
});

const LEVEL: LevelConfig = {
  name: "CAP",
  units: 16,
  multiEventRatio: 0,
  teamCrossoverRatio: 0,
  tournaments: [],
  spectators: 0,
  spectatorIntervalSeconds: 10,
  chiefs: 0,
  referees: 0,
};

interface Sample {
  at: string;
  serverCpu: number;
  serverRssMiB: number;
  simCpu: number;
  simRssMiB: number;
  load1: number;
  serverConnections: number;
}

/** 以被测服务的启动进程为根，汇总整棵进程树的 CPU 与常驻内存（pnpm → tsx → next-server）。 */
function processTree(rootPid: number | null) {
  let output = "";
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,%cpu=,rss="], { encoding: "utf8" });
  } catch {
    // 容器里可能没有 ps：资源改由宿主机的 docker stats 采样。
    return { server: { cpu: 0, rss: 0 }, sim: { cpu: 0, rss: 0 } };
  }
  const rows = output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const usage = (pids: Set<number>) => rows.filter(([pid]) => pids.has(pid)).reduce((sum, [, , cpu, rss]) => ({ cpu: sum.cpu + cpu, rss: sum.rss + rss }), { cpu: 0, rss: 0 });
  const tree = new Set<number>(rootPid ? [rootPid] : []);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [pid, ppid] of rows) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        changed = true;
      }
    }
  }
  return { server: usage(tree), sim: usage(new Set([process.pid])) };
}

async function serverConnections() {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`select count(*)::bigint as count from pg_stat_activity where datname = current_database() and application_name = 'stress-server'`;
  return Number(rows[0]?.count ?? 0);
}

async function xactRollback() {
  const rows = await prisma.$queryRaw<{ rollback: bigint; commit: bigint }[]>`select xact_rollback::bigint as rollback, xact_commit::bigint as commit from pg_stat_database where datname = current_database()`;
  return { rollback: Number(rows[0]?.rollback ?? 0), commit: Number(rows[0]?.commit ?? 0) };
}

/** 服务端日志（每行一条 JSON）在本级窗口内新增部分里的 5xx 错误码与未处理异常。外部实例没有本地日志时返回 null。 */
function serverLogSince(file: string, offset: number) {
  if (!existsSync(file)) return null;
  const codes = new Map<string, number>();
  let unhandled = 0;
  for (const line of readFileSync(file, "utf8").slice(offset).split("\n")) {
    if (!line.startsWith("{")) {
      if (/Unhandled|uncaught|TypeError|ReferenceError/i.test(line)) unhandled += 1;
      continue;
    }
    try {
      const entry = JSON.parse(line) as { status?: number; route?: string; code?: string; errorCode?: string; level?: string };
      if ((entry.status ?? 0) >= 500) {
        const key = `${entry.route} ${entry.status} ${entry.code}${entry.errorCode ? ` ${entry.errorCode}` : ""}`;
        codes.set(key, (codes.get(key) ?? 0) + 1);
      }
    } catch {
      // 不是完整 JSON 的行（启动输出等）。
    }
  }
  return { codes: Object.fromEntries(codes), unhandled };
}

class RecordingMetrics extends Metrics {
  readonly records: RequestRecord[] = [];
  record(entry: RequestRecord) {
    super.record(entry);
    this.records.push(entry);
  }
}

async function main() {
  const seed = Number(args.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed 必须是整数");
  const steps = args.steps!.split(",").map((item) => Number(item.trim()));
  if (steps.some((step) => !Number.isInteger(step) || step < 1 || step > 48)) throw new Error("--steps 每级须在 1—48 之间");
  const p99Limit = Number(args["p99-ms"]);
  const matchesPerUnit = Math.max(1, Math.min(6, Number(args["matches-per-unit"])));
  const clockProfile = CLOCKS[args.clock as keyof typeof CLOCKS];
  if (!clockProfile) throw new Error(`未知节奏 ${args.clock}`);

  const origin = new URL(requireEnv("BETTER_AUTH_URL")).origin;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const runId = `${String(seed).slice(-4)}${stamp.slice(4, 8)}${stamp.slice(9, 13)}`.toLowerCase();
  const runDir = path.join(process.cwd(), "artifacts", "stress", `capacity-${clockProfile.name.toLowerCase()}-${seed}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const secretsDir = path.join(process.cwd(), ".local", "stress");
  mkdirSync(secretsDir, { recursive: true });
  const setupMetrics = new Metrics(path.join(runDir, "setup-requests.jsonl"));
  const log = (message: string) => console.info(`${new Date().toISOString().slice(11, 19)} ${message}`);
  let ipCounter = 10;
  const nextIp = () => `10.78.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 2}`;

  const context: RunContext = {
    runId,
    probes: [],
    inject: { lineup500: null, lineup500Used: false, withholdLineup: false, withheldKey: null, reviewHoldSeconds: 0 },
    runDir,
    origin,
    level: LEVEL,
    rng: new Rng(seed),
    clock: new Clock(clockProfile),
    metrics: setupMetrics,
    admin: null as unknown as Client,
    refereeLogin: { login: requireEnv("DEMO_REFEREE_EMAIL"), password: requireEnv("DEMO_REFEREE_PASSWORD") },
    tournaments: [],
    findings: [],
    distinctClientIps: true,
    secretsFile: path.join(secretsDir, `${runId}.json`),
    secrets: {},
    log,
    nextIp,
  };
  const serverLog = path.join(runDir, "server.log");
  const server = new Server({ origin, logFile: serverLog, external: args.external });
  const environment = {
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model} × ${os.cpus().length}`,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    sameMachine: !args.external,
    seed,
    steps,
    matchesPerUnit,
    clock: clockProfile.name,
    p99LimitMs: p99Limit,
  };
  writeFileSync(path.join(runDir, "params.json"), JSON.stringify({ args, environment }, null, 2));

  const levels: Record<string, unknown>[] = [];
  let firstServerErrorAt: number | null = null;
  try {
    log(`被测服务就绪（${await server.start()} ms）`);
    context.admin = new Client(origin, "admin", setupMetrics, nextIp());
    await context.admin.signIn(requireEnv("DEMO_ADMIN_EMAIL"), requireEnv("DEMO_ADMIN_PASSWORD"));

    // 准备：每个赛事 48 个小组；按需要的小组总数建一到两个赛事。
    const needed = steps.reduce((sum, step) => sum + step, 0);
    const pools: { tournament: TournamentRuntime; groups: { code: string; matches: string[] }[] }[] = [];
    for (let index = 0; pools.reduce((sum, pool) => sum + pool.groups.length, 0) < needed; index += 1) {
      const plan = capacityPlan(`C${index + 1}`);
      const roster = generateRoster(context.rng.fork(`roster:${plan.key}`), LEVEL, plan, runId.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 6));
      const tournament = await createTournament(context, plan, roster);
      context.tournaments.push(tournament);
      await registerIndividuals(context, tournament);
      await mapEntries(tournament);
      await closeRegistration(context, tournament);
      const startsAt = new Date(Date.now() + 60_000);
      await configureSchedule(context, tournament, startsAt);
      await publishDraws(context, tournament);
      await suggestAndPublish(context, tournament, startsAt, "容量探测发布");
      const groups: { code: string; matches: string[] }[] = [];
      for (const competition of tournament.competitions.values()) {
        for (const group of await groupsOf(competition.id)) {
          if (group.stage.type !== "ROUND_ROBIN") continue;
          groups.push({ code: `${competition.code}-${group.code}`, matches: group.matches.map((match) => match.code).sort() });
        }
      }
      pools.push({ tournament, groups });
      log(`容量赛事 ${plan.key}：${groups.length} 个小组、${groups.reduce((sum, group) => sum + group.matches.length, 0)} 场组内比赛`);
    }
    writeFileSync(context.secretsFile, JSON.stringify(context.secrets, null, 2), { mode: 0o600 });

    for (const concurrency of steps) {
      // 每级用新的小组，不跨赛事混用（同一级的小组都来自同一赛事时，读写的是同一批行）。
      const pool = pools.find((item) => item.groups.length >= concurrency) ?? pools[0];
      const groups = pool.groups.splice(0, concurrency);
      if (groups.length < concurrency) throw new Error(`第 ${concurrency} 级可用小组不足`);
      const metrics = new RecordingMetrics(path.join(runDir, `requests-${concurrency}.jsonl`));
      const tablets: Client[] = [];
      for (let index = 0; index < concurrency; index += 1) {
        const tablet = new Client(origin, `cap-${concurrency}-${index + 1}`, metrics, nextIp());
        await tablet.signIn(context.refereeLogin.login, context.refereeLogin.password);
        tablets.push(tablet);
      }
      const before = await xactRollback();
      const logOffset = existsSync(serverLog) ? statSync(serverLog).size : 0;
      const samples: Sample[] = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const usage = processTree(server.pid);
          samples.push({
            at: new Date().toISOString(),
            serverCpu: Math.round(usage.server.cpu),
            serverRssMiB: Math.round(usage.server.rss / 1024),
            simCpu: Math.round(usage.sim.cpu),
            simRssMiB: Math.round(usage.sim.rss / 1024),
            load1: Math.round(os.loadavg()[0] * 100) / 100,
            serverConnections: await serverConnections(),
          });
          await sleep(5000);
        }
      })();
      log(`第 ${concurrency} 级开始（${pool.tournament.plan.key}：${groups.map((group) => group.code).join(" ")}）`);
      const startedAt = Date.now();
      const outcomes = await Promise.all(
        groups.map(async (group, index) => {
          const rng = context.rng.fork(`cap:${concurrency}:${group.code}`);
          const device = rng.uuid();
          let commands = 0;
          const stops: string[] = [];
          for (const code of group.matches.slice(0, matchesPerUnit)) {
            const driver = new MatchDriver(tablets[index], code, device, Narrative.pick(rng.fork(`narrative:${code}`)), context.clock, rng.fork(`rally:${code}`));
            let done = false;
            for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
              const acquired = await driver.acquire();
              if (!acquired.ok) {
                stops.push(`${code} 取得控制 ${acquired.status} ${acquired.code}`);
                await sleep(1000);
                continue;
              }
              await driver.refresh();
              const result = await driver.play();
              if (result.outcome === "submitted") done = true;
              else stops.push(`${code} ${result.outcome} ${result.reason ?? ""}`.trim());
            }
            commands += driver.commands.length;
          }
          return { group: group.code, commands, stops };
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      sampling = false;
      await sampler;
      const after = await xactRollback();

      const commandRecords = metrics.records.filter((record) => `${record.method} ${record.route}` === COMMAND_ROUTE);
      const statuses = new Map<string, number>();
      for (const record of commandRecords) {
        const key = record.code ? `${record.status} ${record.code}` : String(record.status);
        statuses.set(key, (statuses.get(key) ?? 0) + 1);
      }
      const serverErrors = metrics.records.filter((record) => record.status >= 500);
      if (serverErrors.length && firstServerErrorAt === null) firstServerErrorAt = concurrency;
      const latency = latencySummary(commandRecords.map((record) => record.ms));
      const success = commandRecords.filter((record) => record.status === 200 || record.status === 201).length;
      const cpuPeak = Math.max(0, ...samples.map((sample) => sample.serverCpu + sample.simCpu));
      const level = {
        concurrency,
        tournament: pool.tournament.plan.key,
        elapsedSeconds: Math.round(elapsedMs / 100) / 10,
        commands: commandRecords.length,
        commandsPerSecond: Math.round((commandRecords.length / (elapsedMs / 1000)) * 10) / 10,
        successRate: commandRecords.length ? Math.round((success / commandRecords.length) * 10000) / 100 : null,
        statuses: Object.fromEntries([...statuses.entries()].sort()),
        latency,
        allRoutes: metrics.summary().routes.map((route) => ({ route: route.route, count: route.count, p50: route.p50, p95: route.p95, p99: route.p99, max: route.max, statuses: route.statuses })),
        serverErrors: serverErrors.length,
        serverErrorCodes: Object.fromEntries(
          [...serverErrors.reduce((map, record) => map.set(`${record.method} ${record.route} ${record.status} ${record.code}`, (map.get(`${record.method} ${record.route} ${record.status} ${record.code}`) ?? 0) + 1), new Map<string, number>())],
        ),
        serverLog: serverLogSince(serverLog, logOffset),
        xactRollbackDelta: after.rollback - before.rollback,
        xactCommitDelta: after.commit - before.commit,
        peakServerConnections: Math.max(0, ...samples.map((sample) => sample.serverConnections)),
        minCommandsPerUnit: Math.min(...outcomes.map((item) => item.commands)),
        stops: outcomes.flatMap((item) => item.stops.map((stop) => `${item.group}: ${stop}`)),
        resources: { samples, cpuPeakPercent: cpuPeak, cpuCores: os.cpus().length, nearSaturation: cpuPeak > os.cpus().length * 100 * 0.85 },
        safe: serverErrors.length === 0 && (latency.p99 ?? Infinity) < p99Limit,
      };
      levels.push(level);
      log(
        `第 ${concurrency} 级：${level.commands} 条命令 / ${level.elapsedSeconds} 秒（${level.commandsPerSecond}/秒），成功率 ${level.successRate}%，` +
          `P50/P95/P99/最大 ${latency.p50}/${latency.p95}/${latency.p99}/${latency.max} ms，5xx ${level.serverErrors}，回滚增量 ${level.xactRollbackDelta}，` +
          `连接峰值 ${level.peakServerConnections}，CPU 峰值 ${cpuPeak}%，${level.safe ? "达标" : "未达标"}`,
      );
      await metrics.close();
      await sleep(5000);
    }
  } finally {
    await server.close();
    await setupMetrics.close();
  }

  const safeLevels = levels.filter((level) => level.safe).map((level) => level.concurrency as number);
  // 连续达标的最大并发：一旦某级未达标，之后更高的级即使碰巧达标也不计。
  let maxSafe = 0;
  for (const level of levels) {
    if (!level.safe) break;
    maxSafe = level.concurrency as number;
  }
  const result = {
    runId,
    environment,
    thresholds: { p99Ms: p99Limit, serverErrors: 0 },
    levels,
    firstServerErrorAtConcurrency: firstServerErrorAt,
    safeLevels,
    maxSafeConcurrency: maxSafe,
    // 每块场地同时最多一场：并发场数即场地数。
    maxSafeCourts: maxSafe,
    twelveCourtsSafe: levels.some((level) => (level.concurrency as number) >= 12) ? maxSafe >= 12 : null,
    notes: [
      "xact_rollback 增量包含所有回滚（不只是可串行化重试），只作重试次数的上界近似。",
      environment.sameMachine ? "压测端与被测服务同机运行，延迟数据可信度有限。" : "压测端与被测服务分离。",
    ],
  };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  log(`结束。连续达标的最大并发 ${maxSafe} 场；首次 5xx 出现在 ${firstServerErrorAt ?? "—"} 场；产物 ${path.relative(process.cwd(), runDir)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

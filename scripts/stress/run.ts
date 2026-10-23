/**
 * 全赛制并发仿真入口（测试方案 §12）。
 *
 *   pnpm run stress:prepare                 # 建/迁移 badminton_tournament_stress_test（只增不删）
 *   pnpm run stress:build                   # 生产构建（与阶段 8 相同的构建参数）
 *   pnpm run stress -- --level L1 --clock C8 --seed 20261023
 *
 * 参数：--level L0|L1|L3  --clock C8|C3|R1  --seed <整数>  --external（连接已在运行的实例，不自起服务）
 *       --same-ip（所有模拟客户端共用一个来源，§13.2）  --public-rate <每分钟>  --max-minutes <总时限>
 *
 * 所有写入只经 HTTP 接口；本进程的数据库会话是只读的（readonly-env.ts 必须最先导入）。
 * 产物写到 artifacts/stress/<seed>-<时间>/；运行时生成的口令写到未提交的 .local/stress/。
 */
import "./core/readonly-env";

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { LEVELS, type LevelConfig } from "./config/levels";
import { Clock, CLOCKS, sleep } from "./core/clock";
import { courtsOf, matchesOfTournament, prisma } from "./core/db";
import { Client } from "./core/http";
import { Metrics } from "./core/metrics";
import { Rng } from "./core/rng";
import { Server } from "./core/server";
import { chiefReviewLoop, groupRankingLoop, type ReviewRecord } from "./live/chief";
import { OfficiatingCache } from "./live/officiating";
import { courtLoop, type LiveRegistry } from "./live/venue";
import { addFinding, type RunContext, type TournamentRuntime } from "./scenario/context";
import { publishDraws } from "./scenario/draw";
import { lineupLoop, type LineupRecord } from "./scenario/lineup";
import { closeRegistration, mapEntries, registerIndividuals, registerTeams } from "./scenario/registration";
import { generateRoster } from "./scenario/roster";
import { configureSchedule, suggestAndPublish } from "./scenario/schedule";
import { createTournament } from "./scenario/setup";
import { verifyRun, type RunResultFile } from "./verify";

const { values: args } = parseArgs({
  // pnpm run 会把分隔用的 `--` 原样传进来。
  args: process.argv.slice(2).filter((item) => item !== "--"),
  options: {
    level: { type: "string", default: "L1" },
    clock: { type: "string", default: "C8" },
    seed: { type: "string", default: "20261023" },
    external: { type: "boolean", default: false },
    "same-ip": { type: "boolean", default: false },
    "public-rate": { type: "string" },
    "max-minutes": { type: "string", default: "240" },
    "stall-minutes": { type: "string", default: "6" },
  },
});

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`.env.stress 缺少 ${name}。`);
  return value;
}

async function main() {
  const level: LevelConfig | undefined = LEVELS[args.level!];
  if (!level) throw new Error(`未知规模 ${args.level}`);
  const clockProfile = CLOCKS[args.clock as keyof typeof CLOCKS];
  if (!clockProfile) throw new Error(`未知时间档 ${args.clock}`);
  const seed = Number(args.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed 必须是整数");

  const origin = new URL(requireEnv("BETTER_AUTH_URL")).origin;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const runId = `${String(seed).slice(-4)}${stamp.slice(4, 8)}${stamp.slice(9, 13)}`.toLowerCase();
  const runDir = path.join(process.cwd(), "artifacts", "stress", `${seed}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const secretsDir = path.join(process.cwd(), ".local", "stress");
  mkdirSync(secretsDir, { recursive: true });
  const metrics = new Metrics(path.join(runDir, "requests.jsonl"));
  const logLines: string[] = [];
  const log = (message: string) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${message}`;
    logLines.push(line);
    console.info(line);
  };

  let ipCounter = 10;
  const context: RunContext = {
    runId,
    runDir,
    origin,
    level,
    rng: new Rng(seed),
    clock: new Clock(clockProfile),
    metrics,
    admin: null as unknown as Client,
    refereeLogin: { login: requireEnv("DEMO_REFEREE_EMAIL"), password: requireEnv("DEMO_REFEREE_PASSWORD") },
    tournaments: [],
    findings: [],
    distinctClientIps: !args["same-ip"],
    secretsFile: path.join(secretsDir, `${runId}.json`),
    secrets: {},
    log,
    nextIp: () => (args["same-ip"] ? null : `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 2}`),
  };
  const adminLogin = { login: requireEnv("DEMO_ADMIN_EMAIL"), password: requireEnv("DEMO_ADMIN_PASSWORD") };

  const server = new Server({ origin, logFile: path.join(runDir, "server.log"), publicRateLimitPerMinute: args["public-rate"], external: args.external });
  const environment = {
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model} × ${os.cpus().length}`,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    sameMachine: !args.external,
    level: level.name,
    clock: clockProfile.name,
    seed,
    distinctClientIps: context.distinctClientIps,
  };
  writeFileSync(path.join(runDir, "params.json"), JSON.stringify({ args, environment, level, clock: clockProfile }, null, 2));

  const registry: LiveRegistry = { active: new Map(), results: [], abandoned: new Set(), lastProgressAt: Date.now(), stop: false };
  const reviews: ReviewRecord[] = [];
  const lineups: LineupRecord[] = [];
  const rankings: { competition: string; group: string; at: number; status: number; code: string | null; lots: boolean }[] = [];
  const phases: Record<string, number> = {};
  const mark = (name: string) => (phases[name] = Date.now());
  let outcome = "completed";

  try {
    mark("serverStart");
    log(`被测服务就绪（${await server.start()} ms）`);
    context.admin = new Client(origin, "admin", metrics, context.nextIp());
    await context.admin.signIn(adminLogin.login, adminLogin.password);

    mark("setup");
    for (const plan of level.tournaments) {
      const roster = generateRoster(context.rng.fork(`roster:${plan.key}`), level, plan, runId.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 6));
      const tournament = await createTournament(context, plan, roster);
      context.tournaments.push(tournament);
      await registerIndividuals(context, tournament);
      await registerTeams(context, tournament);
      await mapEntries(tournament);
      await closeRegistration(context, tournament);
      const startsAt = new Date(Date.now() + 60_000);
      await configureSchedule(context, tournament, startsAt);
      await publishDraws(context, tournament);
      await suggestAndPublish(context, tournament, startsAt, "仿真首次发布");
      await mapEntries(tournament);
      tournament.courts = (await courtsOf(tournament.id)).map((court) => court.id);
    }
    writeFileSync(context.secretsFile, JSON.stringify(context.secrets, null, 2), { mode: 0o600 });

    mark("live");
    const refereeUser = await prisma.user.findFirstOrThrow({ where: { email: context.refereeLogin.login.toLowerCase() }, select: { id: true } });
    const loops: Promise<unknown>[] = [];
    for (const tournament of context.tournaments) {
      const cache = new OfficiatingCache(refereeUser.id, tournament.slug);
      const courts = await courtsOf(tournament.id);
      for (const court of courts) {
        // 场地固定设备：每块场地一台平板，共用裁判账号各自登录一次。
        const device = new Client(origin, `tablet-${tournament.plan.key}-${court.code}`, metrics, context.nextIp());
        await device.signIn(context.refereeLogin.login, context.refereeLogin.password);
        loops.push(courtLoop({ context, tournament, court, device, cache, registry, rng: context.rng.fork(`court:${tournament.plan.key}:${court.code}`), clock: context.clock }));
      }
      tournament.chiefs.forEach((_, index) => loops.push(chiefReviewLoop({ context, tournament, index, registry, reviews, rng: context.rng.fork(`chief:${tournament.plan.key}:${index}`) })));
      loops.push(groupRankingLoop({ context, tournament, registry, rng: context.rng.fork(`ranking:${tournament.plan.key}`), confirmations: rankings }));
      loops.push(lineupLoop({ context, tournament, registry, rng: context.rng.fork(`lineup:${tournament.plan.key}`), records: lineups }));
    }
    for (let index = 0; index < level.spectators; index += 1) loops.push(spectator(context, registry, index));

    const deadline = Date.now() + Number(args["max-minutes"]) * 60_000;
    const stallMs = Number(args["stall-minutes"]) * 60_000;
    let lastReport = 0;
    for (;;) {
      await sleep(5000);
      const status = await tournamentStatus(context.tournaments);
      if (Date.now() - lastReport > 30_000) {
        lastReport = Date.now();
        log(`进度：${status.done}/${status.total} 场已锁定或未进行，进行中 ${registry.active.size}，待复核 ${status.pendingReview}，未开始 ${status.notStarted}`);
      }
      if (status.done === status.total && status.groupsPending === 0) break;
      if (Date.now() > deadline) {
        outcome = "timeout";
        break;
      }
      if (registry.active.size === 0 && Date.now() - registry.lastProgressAt > stallMs) {
        outcome = "stalled";
        addFinding(context, { kind: "blocked", area: "全局", title: `赛事在 ${args["stall-minutes"]} 分钟内没有进展`, detail: { unfinished: status.unfinished.slice(0, 50) } });
        break;
      }
    }
    registry.stop = true;
    await Promise.allSettled(loops);
    mark("standings");
    for (const tournament of context.tournaments) {
      for (const competition of tournament.competitions.values()) {
        if (competition.entryType === "TEAM") continue;
        const published = await context.admin.call("POST", `/api/admin/tournaments/${tournament.slug}/competitions/${competition.code}/standings/publish`, { note: "仿真结束发布" }, {
          route: "/api/admin/tournaments/[slug]/competitions/[code]/standings/publish",
        });
        if (!published.ok) addFinding(context, { kind: "blocked", area: "名次榜单", title: `${tournament.plan.key}/${competition.code} 榜单发布失败`, detail: { status: published.status, code: published.code, message: published.message } });
      }
    }
  } catch (error) {
    outcome = "crashed";
    addFinding(context, { kind: "script_error", area: "仿真", title: "运行中断", detail: { message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) } });
  } finally {
    registry.stop = true;
    mark("end");
    await server.close();
    await metrics.close();
  }

  const finalStatus = context.tournaments.length ? await tournamentStatus(context.tournaments) : null;
  const result = {
    outcome,
    runId,
    environment,
    phases,
    tournaments: context.tournaments.map((item) => ({ key: item.plan.key, slug: item.slug, rulePreset: item.plan.rulePreset, refereeMode: item.plan.refereeMode })),
    finalStatus: finalStatus && { ...finalStatus, unfinished: finalStatus.unfinished.slice(0, 100) },
    matches: registry.results,
    reviews,
    lineups,
    rankings,
    findings: context.findings,
    metrics: metrics.summary(),
    server: { starts: server.starts, log: Server.scanLog(path.join(runDir, "server.log")) },
  };
  writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(path.join(runDir, "run.log"), `${logLines.join("\n")}\n`);
  if (context.tournaments.length) {
    const verification = await verifyRun(runDir, result as unknown as RunResultFile);
    for (const tournament of verification.tournaments) {
      for (const check of tournament.checks) log(`判定 ${tournament.key} ${check.passed ? "通过" : "失败"} ${check.title}（${check.checked} 项，${check.failures.length} 处失败）`);
    }
  }
  log(`结束：${outcome}。产物 ${path.relative(process.cwd(), runDir)}`);
  await prisma.$disconnect();
  if (outcome === "crashed") process.exitCode = 1;
}

async function tournamentStatus(tournaments: TournamentRuntime[]) {
  let total = 0;
  let done = 0;
  let pendingReview = 0;
  let notStarted = 0;
  let groupsPending = 0;
  const unfinished: { tournament: string; code: string; lifecycle: string; verification: string; sides: string }[] = [];
  for (const tournament of tournaments) {
    for (const match of await matchesOfTournament(tournament.id)) {
      total += 1;
      const finished = Boolean(match.notPlayedAt) || match.verificationStatus === "LOCKED";
      if (finished) done += 1;
      else {
        if (match.verificationStatus === "PENDING_REVIEW") pendingReview += 1;
        if (match.lifecycleStatus === "READY" || match.lifecycleStatus === "SCHEDULED") notStarted += 1;
        unfinished.push({
          tournament: tournament.plan.key,
          code: match.code,
          lifecycle: match.lifecycleStatus,
          verification: match.verificationStatus,
          sides: `${match.sideAEntryId ? "A" : "-"}${match.sideBEntryId ? "B" : "-"}`,
        });
      }
    }
    groupsPending += await prisma.group.count({ where: { stage: { competition: { tournamentId: tournament.id } }, rankingConfirmedAt: null } });
  }
  return { total, done, pendingReview, notStarted, groupsPending, unfinished };
}

/** 公开观众：未登录，按间隔轮询公开赛程与一场比赛详情（§9：默认 10 秒）。 */
async function spectator(context: RunContext, registry: LiveRegistry, index: number) {
  const client = new Client(context.origin, `spectator-${index}`, context.metrics, context.nextIp());
  const rng = context.rng.fork(`spectator:${index}`);
  await sleep(rng.int(0, context.level.spectatorIntervalSeconds * 1000));
  // 学号格式固定为「运行标签 + 赛事键 + 4 位序号」（roster.ts）；公开响应里出现这种串就是白名单泄露（§8.8）。
  // 只匹配完整学号格式：运行标签本身也出现在赛事 slug 里，单看标签会误报。
  const studentTag = context.runId.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 6);
  const studentIdPattern = new RegExp(`${studentTag}(${context.level.tournaments.map((plan) => plan.key).join("|")})\\d{4}`);
  const inspect = (result: { json: unknown }, where: string) => {
    if (studentIdPattern.test(JSON.stringify(result.json ?? ""))) {
      addFinding(context, { kind: "unexpected", area: "公开白名单", title: `${where} 响应中出现学号`, detail: { where } });
    }
  };
  while (!registry.stop) {
    const tournament = context.tournaments.length ? rng.pick(context.tournaments) : null;
    if (tournament) {
      inspect(await client.call("GET", `/api/public/tournaments/${tournament.slug}/schedule`, undefined, { route: "/api/public/tournaments/[slug]/schedule" }), "公开赛程");
      const live = [...registry.active.keys()];
      if (live.length) {
        inspect(await client.call("GET", `/api/public/tournaments/${tournament.slug}/matches/${rng.pick(live)}`, undefined, { route: "/api/public/tournaments/[slug]/matches/[code]" }), "公开比赛详情");
      }
    }
    await sleep(context.level.spectatorIntervalSeconds * 1000);
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await prisma.$disconnect().catch(() => undefined);
});

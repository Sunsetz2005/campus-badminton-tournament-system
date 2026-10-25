/**
 * 全赛制并发仿真入口（测试方案 §12）。
 *
 *   pnpm run stress:prepare                 # 建/迁移 badminton_tournament_stress_test（只增不删）
 *   pnpm run stress:build                   # 生产构建（与阶段 8 相同的构建参数）
 *   pnpm run stress -- --level L1 --clock C8 --seed 20261023
 *
 * 参数：--level L0|L1|L2|L3  --clock C8|C3|R1  --seed <整数>  --external（连接已在运行的实例，不自起服务）
 *       --same-ip（所有模拟客户端共用一个来源，§13.2）  --public-rate <每分钟>  --max-minutes <总时限>
 *       --referee-mode SHARED_ACCOUNT|PER_MATCH（只作用于主赛事 M；卫星赛事固定共用账号，§13.9）
 *       --scenarios ties,delays,inject（强制同分 / 延误七情形 / 异常注入；默认 C3 档开前两者，其余档只开 ties）
 *       --only commands,sessions,handover,pending,restart,lineup,confirm,reopen（异常注入只跑指定组）
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
import { chiefReviewLoop, groupRankingLoop, type RankingRecord, type ReviewRecord } from "./live/chief";
import { GlobalScheduleView, OfficiatingCache } from "./live/officiating";
import { injectionLoop } from "./live/injections";
import { teamInjectionLoop, teamOutcomeProbes } from "./live/team-injections";
import { planRefereeOverrun, refereeInjectionLoop } from "./live/referee-injections";
import { createOfficialRecord, provisionNamedReferees, rotationStats, simulatedOfficials } from "./live/officials";
import { delayWatchLoop, narrowFirstDay, planDelayScenarios, rescheduleLoop, summarizeDelayScenarios, type DelayObservation } from "./scenario/delays";
import { planForcedTies } from "./scenario/ties";
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
    "referee-mode": { type: "string" },
    scenarios: { type: "string" },
    /** 故障注入，逗号分隔：lineup-500、lineup-500-saved、lineup-withhold、review-hold=<现实秒数>。 */
    inject: { type: "string" },
    /** 异常注入（--scenarios inject）只跑指定组，逗号分隔：commands、sessions、handover、pending、browser、restart、dbfaults、lineup、confirm、reopen；逐场指派：swap-before、swap-busy、swap-mid、swap-mid-other、overrun。 */
    only: { type: "string" },
  },
});

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`.env.stress 缺少 ${name}。`);
  return value;
}

async function main() {
  const baseLevel: LevelConfig | undefined = LEVELS[args.level!];
  if (!baseLevel) throw new Error(`未知规模 ${args.level}`);
  const refereeMode = args["referee-mode"];
  if (refereeMode && refereeMode !== "SHARED_ACCOUNT" && refereeMode !== "PER_MATCH") throw new Error("--referee-mode 只能是 SHARED_ACCOUNT 或 PER_MATCH");
  const level: LevelConfig = {
    ...baseLevel,
    tournaments: baseLevel.tournaments.map((plan) => (plan.key === "M" && refereeMode ? { ...plan, refereeMode: refereeMode as "SHARED_ACCOUNT" | "PER_MATCH" } : plan)),
  };
  const clockProfile = CLOCKS[args.clock as keyof typeof CLOCKS];
  if (!clockProfile) throw new Error(`未知时间档 ${args.clock}`);
  const seed = Number(args.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed 必须是整数");
  const scenarios = new Set((args.scenarios ?? (clockProfile.name === "C3" ? "ties,delays" : "ties")).split(",").map((item) => item.trim()).filter(Boolean));

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
  const injectArgs = new Map((args.inject ?? "").split(",").map((item) => item.trim()).filter(Boolean).map((item) => [item.split("=")[0], item.split("=")[1] ?? ""] as const));
  for (const key of injectArgs.keys()) if (!["lineup-500", "lineup-500-saved", "lineup-withhold", "review-hold"].includes(key)) throw new Error(`未知注入 ${key}`);
  const context: RunContext = {
    runId,
    probes: [],
    inject: {
      lineup500: injectArgs.has("lineup-500-saved") ? "saved" : injectArgs.has("lineup-500") ? "unsent" : null,
      lineup500Used: false,
      withholdLineup: injectArgs.has("lineup-withhold"),
      withheldKey: null,
      reviewHoldSeconds: Number(injectArgs.get("review-hold") || 0),
    },
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
    injections: args.inject ?? null,
    node: process.version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: `${os.cpus()[0]?.model} × ${os.cpus().length}`,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    sameMachine: !args.external,
    level: level.name,
    clock: clockProfile.name,
    seed,
    distinctClientIps: context.distinctClientIps,
    scenarios: [...scenarios],
    refereeModes: Object.fromEntries(level.tournaments.map((plan) => [plan.key, plan.refereeMode])),
  };
  writeFileSync(path.join(runDir, "params.json"), JSON.stringify({ args, environment, level, clock: clockProfile }, null, 2));

  const registry: LiveRegistry = { active: new Map(), results: [], activePlayers: new Map(), intentionalWaits: new Map(), abandoned: new Set(), playing: new Map(), lastProgressAt: Date.now(), borrowedCourts: new Map(), stop: false };
  const reviews: ReviewRecord[] = [];
  const lineups: LineupRecord[] = [];
  const rankings: RankingRecord[] = [];
  const phases: Record<string, number> = {};
  const delayObservations = new Map<string, DelayObservation>();
  const mark = (name: string) => (phases[name] = Date.now());
  let outcome = "completed";
  let refereeOverrun: Awaited<ReturnType<typeof planRefereeOverrun>> = null;

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
      const main = plan.key === "M";
      if (main && scenarios.has("ties")) await planForcedTies(context, tournament);
      if (plan.refereeMode === "PER_MATCH") await provisionNamedReferees(context, tournament, level.referees);
      await suggestAndPublish(context, tournament, startsAt, "仿真首次发布");
      await mapEntries(tournament);
      tournament.courts = (await courtsOf(tournament.id)).map((court) => court.id);
      if (main && context.inject.reviewHoldSeconds > 0) {
        const first = (await matchesOfTournament(tournament.id))
          .filter((match) => !match.rubberKind && match.sideAEntryId && match.sideBEntryId)
          .sort((a, b) => (a.scheduledAt?.getTime() ?? Infinity) - (b.scheduledAt?.getTime() ?? Infinity))[0];
        if (first) {
          tournament.reviewHolds.set(first.code, context.inject.reviewHoldSeconds);
          log(`[注入] ${first.code} 复核延后现实 ${context.inject.reviewHoldSeconds} 秒（约 ${Math.round(context.clock.ms(context.inject.reviewHoldSeconds) / 1000)} 秒墙钟）`);
        }
      }
      if (main && scenarios.has("inject") && plan.refereeMode === "PER_MATCH") refereeOverrun = await planRefereeOverrun(context, tournament);
      if (main && scenarios.has("delays")) {
        await planDelayScenarios(context, tournament);
        await narrowFirstDay(context, tournament, startsAt);
      }
    }
    writeFileSync(context.secretsFile, JSON.stringify(context.secrets, null, 2), { mode: 0o600 });

    mark("live");
    const refereeUser = await prisma.user.findFirstOrThrow({ where: { email: context.refereeLogin.login.toLowerCase() }, select: { id: true } });
    const loops: Promise<unknown>[] = [];
    // 协程抛错只记为脚本错误：未处理的拒绝会让 Node 直接退出，跳过 finally，留下被测服务和停着的数据库容器。
    const track = (loop: Promise<unknown>) =>
      loops.push(loop.catch((error) => addFinding(context, { kind: "script_error", area: "仿真", title: "协程异常退出", detail: { message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) } })));
    const sharedModes = context.tournaments.filter((item) => item.plan.refereeMode === "SHARED_ACCOUNT").map((item) => item.plan.key);
    if (sharedModes.length) {
      addFinding(context, {
        kind: "design_undefined",
        area: "裁判轮换",
        title: `共用账号模式（${sharedModes.join("、")}）下系统无法区分是哪名裁判执裁`,
        detail: { tournaments: sharedModes, traceableTo: "scoringSessionId → deviceSessionId（设备）", note: "执裁人只记在仿真内部的轮换表，赛后追溯需要线下签到记录（§13.9 判定补充 3）" },
      });
    }
    for (const tournament of context.tournaments) {
      const perMatch = tournament.plan.refereeMode === "PER_MATCH";
      const cache = perMatch ? new GlobalScheduleView(tournament.id) : new OfficiatingCache(refereeUser.id, tournament.slug);
      const courts = await courtsOf(tournament.id);
      if (!perMatch) simulatedOfficials(context, tournament, tournament.plan.key === "M" ? level.referees : Math.max(2, tournament.plan.courts * 2), refereeUser.id);
      else {
        // 平台共用裁判账号也会被自动建议分配（见排班发现）：由一名持平板的仿真裁判用它执裁。
        const tablet = new Client(origin, `tablet-${tournament.plan.key}-platform`, metrics, context.nextIp());
        await tablet.signIn(context.refereeLogin.login, context.refereeLogin.password);
        tournament.officials.push(createOfficialRecord("PLATFORM", "平台共用裁判账号", context.refereeLogin.login, refereeUser.id, tablet, context.rng.fork("officials:platform")));
      }
      for (const court of courts) {
        // 共用账号模式：场地固定设备，每块场地一台平板，共用裁判账号各自登录一次。逐场指派模式：裁判用自己的手机。
        let device: Client | null = null;
        if (!perMatch) {
          device = new Client(origin, `tablet-${tournament.plan.key}-${court.code}`, metrics, context.nextIp());
          await device.signIn(context.refereeLogin.login, context.refereeLogin.password);
        }
        track(courtLoop({ context, tournament, court, device, cache, registry, rng: context.rng.fork(`court:${tournament.plan.key}:${court.code}`), clock: context.clock }));
      }
      if (tournament.plan.key === "M" && scenarios.has("inject")) {
        const only = args.only ? new Set(args.only.split(",").map((item) => item.trim())) : undefined;
        // 逐场指派模式只做 §13.9 裁判相关注入；§7 通用、团体与共用账号交接在共用账号模式的轮次里做。
        if (perMatch) track(refereeInjectionLoop({ context, tournament, registry, server, rng: context.rng.fork("inject:referee"), overrun: refereeOverrun, only }));
        else {
          track(injectionLoop({ context, tournament, registry, server, rng: context.rng.fork("inject"), only }));
          track(teamInjectionLoop({ context, tournament, registry, rng: context.rng.fork("inject:team"), reviews, only }));
        }
      }
      if (tournament.delayScenarios.length) {
        track(delayWatchLoop({ context, tournament, registry, observations: delayObservations }));
        track(rescheduleLoop({ context, tournament, registry }));
      }
      tournament.chiefs.forEach((_, index) => track(chiefReviewLoop({ context, tournament, index, registry, reviews, rng: context.rng.fork(`chief:${tournament.plan.key}:${index}`) })));
      track(groupRankingLoop({ context, tournament, registry, rng: context.rng.fork(`ranking:${tournament.plan.key}`), confirmations: rankings }));
      track(lineupLoop({ context, tournament, registry, rng: context.rng.fork(`lineup:${tournament.plan.key}`), records: lineups }));
    }
    for (let index = 0; index < level.spectators; index += 1) track(spectator(context, registry, index));

    // 宿主暂停检测：本机睡眠（合盖、闲置）时仿真与被测服务一起停住，但服务端的租约按墙钟继续计时，
    // 醒来后所有控制会话同时过期——那是环境假象，不是系统问题。1 秒节拍的墙钟跳变超过 20 秒即判本次运行无效。
    let hostPause: { at: string; gapSeconds: number } | null = null;
    let lastTick = Date.now();
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastTick > 20_000 && !hostPause) {
        hostPause = { at: new Date(lastTick).toISOString(), gapSeconds: Math.round((now - lastTick) / 1000) };
        addFinding(context, { kind: "script_error", area: "运行环境", title: `宿主暂停 ${hostPause.gapSeconds} 秒（本机睡眠？），本次运行无效`, detail: hostPause });
      }
      lastTick = now;
    }, 1000);
    const deadline = Date.now() + Number(args["max-minutes"]) * 60_000;
    const stallMs = Number(args["stall-minutes"]) * 60_000;
    let lastReport = 0;
    for (;;) {
      await sleep(5000);
      if (hostPause) {
        outcome = "host_paused";
        break;
      }
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
      // 卡住：没有比赛真正在打分、没有仿真有意安排的等待（复核延后、名单 5xx 退避），且超过设定时间没有新进展。
      // 取得控制后因名单未齐放回的反复取放不算进展；等上游比赛打完、等裁判休息结束都会有比赛在打，不会误判。
      const now = Date.now();
      for (const [code, until] of registry.intentionalWaits) if (until <= now) registry.intentionalWaits.delete(code);
      if (registry.playing.size === 0 && registry.intentionalWaits.size === 0 && now - registry.lastProgressAt > stallMs) {
        outcome = "stalled";
        addFinding(context, {
          kind: "blocked",
          area: "全局",
          title: `赛事在 ${args["stall-minutes"]} 分钟内没有进展，本轮结束`,
          detail: {
            lastProgressAt: new Date(registry.lastProgressAt).toISOString(),
            simulatorHolding: [...registry.active.keys()],
            abandoned: [...registry.abandoned],
            unfinished: status.unfinished.slice(0, 100),
          },
        });
        break;
      }
    }
    clearInterval(watchdog);
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
  if (scenarios.has("inject")) {
    for (const tournament of context.tournaments.filter((item) => item.plan.key === "M")) await teamOutcomeProbes(context, tournament).catch((error) => log(`团体提前决出汇总失败：${error}`));
  }
  for (const tournament of context.tournaments) {
    if (tournament.delayScenarios.length) await summarizeDelayScenarios(tournament, delayObservations, { reviews, lineups }).catch((error) => log(`延误情形汇总失败：${error}`));
  }
  const result = {
    outcome,
    runId,
    environment,
    phases,
    tournaments: context.tournaments.map((item) => ({
      key: item.plan.key,
      slug: item.slug,
      rulePreset: item.plan.rulePreset,
      refereeMode: item.plan.refereeMode,
      tieScenarios: item.tieScenarios,
      delayScenarios: item.delayScenarios,
      refereeDraft: item.refereeDraft ?? null,
      rotation: rotationStats(item.officials),
      officials: item.officials.map((official) => ({ key: official.key, userId: official.userId, log: official.log })),
    })),
    finalStatus: finalStatus && { ...finalStatus, unfinished: finalStatus.unfinished.slice(0, 100) },
    matches: registry.results,
    reviews,
    lineups,
    rankings,
    findings: context.findings,
    probes: context.probes,
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
  const unfinished: { tournament: string; code: string; lifecycle: string; verification: string; sides: string; competition: string; fixture: string | null; rubber: string | null; scheduledAt: string | null; startedAt: string | null; version: number }[] = [];
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
          competition: match.stage.competition.code,
          fixture: match.fixture?.code ?? null,
          rubber: match.rubberKind ? `${match.rubberOrder}:${match.rubberKind}` : null,
          scheduledAt: match.scheduledAt?.toISOString() ?? null,
          startedAt: match.startedAt?.toISOString() ?? null,
          version: match.version,
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

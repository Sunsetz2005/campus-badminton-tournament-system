/**
 * 数据库层故障注入（测试方案 §13.4，P-11；M4）。
 *
 * 本机 PostgreSQL 与其他项目共用：不重启实例、不占满实例连接。这里只做两项：
 * - 连接中断：`pg_terminate_backend` 只断开 `datname = 当前 stress 库`、`usename = 本库角色`、`application_name = 'stress-server'`
 *   （被测服务，见 readonly-env.ts）的连接；记分命令在故障前后持续发出，记录错误码、恢复耗时、是否不重启就自动恢复，
 *   以及每条命令经对账和重发后是否恰好一条事件。
 * - 连接池耗尽：大量并发读请求把应用池（pg 默认 10 个连接、取连接不设超时）占满，比较记分命令在压力前后的延迟与错误。
 * 数据库重启与实例 `max_connections` 占满只在独立数据库容器上做（不在本模块）。
 */
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import pg from "pg";

import { sleep } from "../core/clock";
import { prisma } from "../core/db";
import { Client, type CallResult } from "../core/http";
import { recordProbe, type ProbeVerdict } from "../scenario/context";
import { driver, eventCount, toRally, withBorrowed, type Env } from "./injections";

const GROUP = "§13.4 数据库层故障（共用实例）";

function probe(env: Env, item: { id: string; title: string; expected: string; actual: string; ok: boolean | "undefined" | "skipped"; match: string; detail?: Record<string, unknown> }) {
  const verdict: ProbeVerdict = item.ok === "undefined" ? "设计未定义" : item.ok === "skipped" ? "未触发" : item.ok ? "符合" : "不符";
  recordProbe(env.context, { id: item.id, group: GROUP, title: item.title, expected: item.expected, actual: item.actual, verdict, match: item.match, detail: item.detail });
}

const serverConnections = async () =>
  (await prisma.$queryRawUnsafe<{ n: number }[]>("select count(*)::int n from pg_stat_activity where datname = current_database() and usename = current_user and application_name = 'stress-server'"))[0].n;

const tally = (results: { status: number; code: string | null }[]) => {
  const map = new Map<string, number>();
  for (const item of results) {
    const key = `${item.status}${item.code ? ` ${item.code}` : ""}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map].map(([key, count]) => `${key}×${count}`).join("、");
};

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
};

export async function dbFaultProbes(env: Env) {
  if (env.server.options.external) {
    probe(env, { id: "13.4-*", title: "数据库层故障", expected: "—", actual: "连接外部实例，本机不注入", ok: "skipped", match: "—" });
    return;
  }
  // 独立数据库容器（STRESS_DB_CONTAINER，见 .env.stress-container）：做重启与占满实例连接；共用实例只做断开连接与池耗尽。
  const container = process.env.STRESS_DB_CONTAINER;
  if (container) {
    await containerProbes(env, container);
    return;
  }
  await withBorrowed(env, "数据库连接中断", async (borrowed) => {
    const code = borrowed.code;
    const d = driver(env, borrowed, env.tablets[0]);
    if (!(await d.acquire()).ok) throw new Error("取得控制失败");
    await d.refresh();
    await toRally(d, 2);

    // 连接中断：命令持续发出（每条走工作台同样的「5xx → 按原 ID 对账 → 重发」），第 3 条之后断开被测服务的全部连接。
    const timeline: { at: number; status: number; code: string | null; ms: number }[] = [];
    const before = await eventCount(code);
    const sent = new Set<string>();
    let terminated = 0;
    let terminatedAt = 0;
    const metricsMark = env.context.metrics.serverErrorLog.length;
    for (let index = 0; index < 12; index += 1) {
      await toRally(d);
      if (index === 3) {
        const connections = await serverConnections();
        terminated = (await prisma.$queryRawUnsafe<{ ok: boolean }[]>("select pg_terminate_backend(pid) ok from pg_stat_activity where datname = current_database() and usename = current_user and application_name = 'stress-server'")).filter((row) => row.ok).length;
        terminatedAt = Date.now();
        env.context.log(`[注入] 断开被测服务的数据库连接 ${terminated}/${connections} 条`);
      }
      const commandsBefore = d.commands.length;
      const result = await d.send("RALLY_WON", { side: index % 2 ? "A" : "B" });
      for (const command of d.commands.slice(commandsBefore)) {
        sent.add(command.commandId);
        timeline.push({ at: Date.now(), status: command.status, code: command.code, ms: Math.round(command.ms) });
      }
      if (!result.ok && result.status !== 409) break;
    }
    const added = (await eventCount(code)) - before;
    const accepted = d.acceptedIds().filter((id) => sent.has(id)).length;
    const after = timeline.filter((item) => item.at >= terminatedAt);
    const firstOk = after.find((item) => item.status === 200 || item.status === 201);
    const errors = env.context.metrics.serverErrorLog.slice(metricsMark);
    probe(env, {
      id: "13.4-terminate",
      title: "连接中断：断开被测服务到 stress 库的全部连接",
      expected: "记录故障期间错误码与延迟；应用不重启即自动恢复；对账重发后每条命令恰好一条事件；快照与重放一致（由判定核对）",
      actual: `断开 ${terminated} 条连接；之后的命令 ${tally(after)}，首个成功距断开 ${firstOk ? `${((firstOk.at - terminatedAt) / 1000).toFixed(1)} 秒` : "—"}；全程 5xx ${errors.length} 次（${tally(errors.map((item) => ({ status: item.status, code: item.code })))}）；受理 ${accepted} 条、事件 +${added}`,
      ok: terminated > 0 && Boolean(firstOk) && added === accepted,
      match: code,
      detail: { timeline, errors: errors.slice(0, 20) },
    });

    // 连接池耗尽：基线 → 并发读压力下 → 压力后，各发 8 条记分命令比较延迟。
    const measure = async (label: string) => {
      const samples: { ms: number; status: number; code: string | null }[] = [];
      for (let index = 0; index < 8; index += 1) {
        await toRally(d);
        const result = await d.post(d.envelope("RALLY_WON", { side: index % 2 ? "A" : "B" }));
        samples.push({ ms: result.ms, status: result.status, code: result.code });
        if (!result.ok) await d.refresh();
      }
      return { label, p50: percentile(samples.map((item) => item.ms), 50), max: percentile(samples.map((item) => item.ms), 100), statuses: tally(samples), allOk: samples.every((item) => item.status === 201) };
    };
    const baseline = await measure("基线");
    // 一半用管理员会话打开排程工作台（服务端组件，一次读很多表，且不受公开限流），一半用匿名客户端读公开赛程。
    const loadClients = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? env.context.admin.cloneAs(`pool-load-admin-${index}`) : new Client(env.context.origin, `pool-load-${index}`, env.context.metrics, env.context.nextIp())));
    const loadResults: CallResult[] = [];
    let stop = false;
    let peakConnections = 0;
    const slug = env.tournament.slug;
    const load = loadClients.map(async (client, index) => {
      while (!stop) {
        const path = index % 2 === 0 ? `/management/${slug}/schedule` : index % 4 === 1 ? `/api/public/tournaments/${slug}/schedule` : `/api/public/tournaments/${slug}/matches/${code}`;
        loadResults.push(await client.call("GET", path, undefined, { route: `pool-load:${path.replace(slug, "[slug]").replace(code, "[code]")}`, note: "连接池压力" }));
      }
    });
    const sampler = (async () => {
      while (!stop) {
        peakConnections = Math.max(peakConnections, await serverConnections());
        await sleep(500);
      }
    })();
    await sleep(3000);
    const underLoad = await measure("压力中");
    stop = true;
    await Promise.all([...load, sampler]);
    const recovered = await measure("压力后");
    const loadMs = loadResults.map((item) => item.ms);
    probe(env, {
      id: "13.4-pool",
      title: "连接池耗尽：60 个并发读客户端占满应用池",
      expected: "pg 池 10 个连接、取连接不设超时：预计请求排队变慢而不是快速失败；压力解除后恢复",
      actual: `压力请求 ${loadResults.length} 次（P50 ${percentile(loadMs, 50)} ms，P95 ${percentile(loadMs, 95)} ms；${tally(loadResults)}），被测服务连接峰值 ${peakConnections}；记分命令 P50/最大：基线 ${baseline.p50}/${baseline.max} ms，压力中 ${underLoad.p50}/${underLoad.max} ms，压力后 ${recovered.p50}/${recovered.max} ms；压力中命令 ${underLoad.statuses}`,
      ok: !loadResults.some((item) => item.status >= 500 || item.status === 0) && underLoad.allOk && recovered.allOk && recovered.p50 <= Math.max(baseline.p50 * 3, baseline.p50 + 200),
      match: code,
      detail: { baseline, underLoad, recovered, peakConnections },
    });
    return d.play();
  });
}

const run = promisify(execFile);

/** 只操作仿真专用的容器：名字必须以 badminton-stress- 开头。 */
async function docker(container: string, ...args: string[]) {
  if (!container.startsWith("badminton-stress-")) throw new Error(`拒绝操作非仿真容器 ${container}`);
  return run("docker", [...args, container]);
}

async function containerProbes(env: Env, container: string) {
  await withBorrowed(env, "数据库容器故障", async (borrowed) => {
    const code = borrowed.code;
    const d = driver(env, borrowed, env.tablets[0]);
    if (!(await d.acquire()).ok) throw new Error("取得控制失败");
    await d.refresh();
    await toRally(d, 2);

    // 1. 数据库重启：比赛进行中停数据库约 10 秒再启动；命令在停机前、中、后持续发出。
    {
      const before = await eventCount(code);
      const metricsMark = env.context.metrics.serverErrorLog.length;
      const timeline: { at: number; status: number; code: string | null }[] = [];
      let stoppedAt = 0;
      let startedAt = 0;
      const outage = (async () => {
        await sleep(3000);
        stoppedAt = Date.now();
        // 仿真进程若在停机期间退出，退出前同步把容器启动回来，不留下停着的库。
        const restore = () => spawnSync("docker", ["start", container], { stdio: "ignore" });
        process.once("exit", restore);
        try {
          await docker(container, "stop", "-t", "0");
          await sleep(10_000);
        } finally {
          await docker(container, "start");
          process.off("exit", restore);
        }
        for (let index = 0; index < 60; index += 1) {
          try {
            await run("docker", ["exec", container, "pg_isready", "-U", "stress"]);
            break;
          } catch {
            await sleep(500);
          }
        }
        startedAt = Date.now();
      })();
      const sent = new Set<string>();
      const until = Date.now() + 40_000;
      env.registry.intentionalWaits.set(`inject:dbrestart:${code}`, until + 60_000);
      while (Date.now() < until) {
        // 起点放在 toRally 之前：它处理间歇、换边待办时也会发命令，同样要算进受理。
        const mark = d.commands.length;
        await toRally(d);
        const result = await d.send("RALLY_WON", { side: timeline.length % 2 ? "A" : "B" });
        for (const command of d.commands.slice(mark)) {
          sent.add(command.commandId);
          timeline.push({ at: Date.now(), status: command.status, code: command.code });
        }
        if (!result.ok && result.status !== 409) break;
        await sleep(500);
      }
      await outage;
      env.registry.intentionalWaits.delete(`inject:dbrestart:${code}`);
      // 停机前已在途的请求（其他协程）可能晚到；稍等再数事件。
      await sleep(2000);
      const added = (await eventCount(code)) - before;
      const accepted = d.acceptedIds().filter((id) => sent.has(id)).length;
      const during = timeline.filter((item) => item.at >= stoppedAt && item.at <= startedAt + 1000);
      const firstOk = timeline.find((item) => item.at > startedAt && (item.status === 201 || item.status === 200));
      const errors = env.context.metrics.serverErrorLog.slice(metricsMark);
      probe(env, {
        id: "13.4-restart",
        title: "数据库重启：比赛进行中停数据库约 10 秒",
        expected: "记录故障期间错误码与延迟；数据库恢复后应用不重启即自动恢复；对账重发后每条命令恰好一条事件",
        actual: `停机 ${((startedAt - stoppedAt) / 1000).toFixed(1)} 秒；停机期间记分请求 ${tally(during) || "无"}；恢复后首个成功距数据库就绪 ${firstOk ? `${((firstOk.at - startedAt) / 1000).toFixed(1)} 秒` : "—"}；全程 5xx ${errors.length} 次（${tally(errors.map((item) => ({ status: item.status, code: item.code })))}）；受理 ${accepted} 条、事件 +${added}`,
        ok: Boolean(firstOk) && added === accepted,
        match: code,
        detail: { timeline, errors: errors.slice(0, 30) },
      });
    }

    // 2. 实例 max_connections 占满：仿真侧开普通连接直到被拒，再看被测服务的请求。
    {
      const url = new URL(process.env.STRESS_SERVER_DATABASE_URL!);
      url.searchParams.delete("schema");
      url.searchParams.set("application_name", "stress-hog");
      const hogs: pg.Client[] = [];
      let refusal = "";
      for (let index = 0; index < 400; index += 1) {
        const client = new pg.Client({ connectionString: url.toString() });
        client.on("error", () => undefined);
        try {
          await client.connect();
          hogs.push(client);
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
          break;
        }
      }
      const metricsMark = env.context.metrics.serverErrorLog.length;
      const samples: { status: number; code: string | null; ms: number }[] = [];
      for (let index = 0; index < 6; index += 1) {
        await toRally(d).catch(() => undefined);
        const result = await d.post(d.envelope("RALLY_WON", { side: index % 2 ? "A" : "B" }), { timeoutMs: 15_000 });
        samples.push({ status: result.status, code: result.code, ms: Math.round(result.ms) });
        if (!result.ok) await d.refresh();
        await sleep(500);
      }
      const health = await d.client.call("GET", "/api/health", undefined, { route: "/api/health", timeoutMs: 10_000 });
      await Promise.all(hogs.map((client) => client.end().catch(() => undefined)));
      await sleep(1000);
      const after = await d.post(d.envelope("RALLY_WON", { side: "A" }));
      if (!after.ok) await d.refresh();
      const errors = env.context.metrics.serverErrorLog.slice(metricsMark);
      probe(env, {
        id: "13.4-max-connections",
        title: "实例 max_connections 占满（独立容器）",
        expected: "记录被测服务此时的错误码与延迟（池里已有的连接可能继续可用）；释放后自动恢复",
        actual: `仿真侧占用 ${hogs.length} 条后被拒（${refusal.slice(0, 80) || "未被拒"}）；此时记分 ${tally(samples)}（${samples.map((item) => item.ms).join("/")} ms），健康检查 ${health.status}；5xx ${errors.length} 次；释放后记分 ${after.status}${after.code ? ` ${after.code}` : ""}`,
        ok: Boolean(refusal) && (after.status === 201),
        match: code,
        detail: { samples, refusal },
      });
    }
    return d.play();
  });
}


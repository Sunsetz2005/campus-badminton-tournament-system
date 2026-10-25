/**
 * 浏览器真实操作注入（测试方案 §13.3，P-12；M4）：用无头 Chromium 驱动真实的裁判工作台 `/officiating/[matchCode]`，
 * 不用 HTTP 模拟。每项记恢复所需时间与是否需要裁判长介入，并记下界面上显示的提示。
 *
 * 开局（抛币、首局设置）由 HTTP 驱动做完再交给浏览器，浏览器只做「取得控制、记分」这类本项要观察的操作。
 * 浏览器发出的 commandId 从请求体里收集，结束时按库里实际存在的事件并入本场结果，判定里的请求↔事件对应照常核对。
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { sleep } from "../core/clock";
import { prisma } from "../core/db";
import { brief, driver, eventCount, toRally, withBorrowed, type Env } from "./injections";
import { recordProbe, type ProbeVerdict } from "../scenario/context";

const GROUP = "§13.3 浏览器真实操作";
const LEASE_MS = 2 * 60_000;

/** CDP 调用没有超时：卡住时按脚本错误抛出，而不是挂住整轮。 */
function withTimeout<T>(promise: Promise<T>, label: string, ms = 10_000) {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`${label} 超过 ${ms / 1000} 秒无回应`)))]);
}

function probe(env: Env, item: { id: string; title: string; expected: string; actual: string; ok: boolean | "undefined" | "skipped"; match: string; detail?: Record<string, unknown> }) {
  const verdict: ProbeVerdict = item.ok === "undefined" ? "设计未定义" : item.ok === "skipped" ? "未触发" : item.ok ? "符合" : "不符";
  recordProbe(env.context, { id: item.id, group: GROUP, title: item.title, expected: item.expected, actual: item.actual, verdict, match: item.match, detail: item.detail });
}

export async function browserProbes(env: Env) {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    probe(env, { id: "13.3-*", title: "浏览器真实操作", expected: "—", actual: `无法启动 Chromium：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, ok: "skipped", match: "—" });
    return;
  }
  // 运行结束（含宿主暂停判无效）时直接关掉浏览器：冻结中的页面上 CDP 与页面调用没有超时，不关会一直挂住整轮。
  const stopWatch = setInterval(() => {
    if (env.registry.stop) void browser.close().catch(() => undefined);
  }, 1000);
  try {
    await withBorrowed(env, "浏览器真实操作", async (borrowed) => {
      const code = borrowed.code;
      // HTTP 驱动做完开局，放回控制交给浏览器。
      const opener = driver(env, borrowed, env.tablets[0]);
      if (!(await opener.acquire()).ok) throw new Error("开局取得控制失败");
      await opener.refresh();
      await toRally(opener, 1);
      await opener.release();

      const commandIds = new Set<string>();
      const context = await browser.newContext({ baseURL: env.context.origin, viewport: { width: 1024, height: 768 }, hasTouch: true });
      context.setDefaultTimeout(30_000);
      const watch = (page: Page) => {
        page.on("request", (request) => {
          if (request.method() === "POST" && /\/api\/matches\/[^/]+\/commands$/.test(new URL(request.url()).pathname)) {
            try {
              const id = (request.postDataJSON() as { commandId?: string }).commandId;
              if (id) commandIds.add(id);
            } catch {
              // 不是 JSON 的请求不是记分命令。
            }
          }
        });
      };
      context.on("page", watch);
      const page = await context.newPage();
      await login(page, env.context.refereeLogin.login, env.context.refereeLogin.password);

      try {
        await closeAndReopen(env, context, page, code);
        await duplicateTab(env, context, code);
        await freezeAndCrash(env, context, code);
        await inflightOffline(env, context, code);
      } finally {
        await context.close().catch(() => undefined);
      }

      // 浏览器发出、且库里确有事件的命令并入本场；之后由 HTTP 驱动经裁判长接管收回控制、打完。
      const existing = await prisma.matchEvent.findMany({ where: { commandId: { in: [...commandIds] } }, select: { commandId: true } });
      for (const row of existing) if (row.commandId) opener.markAccepted(row.commandId);
      const chief = env.tournament.chiefs[0].client;
      const takeover = await chief.call<{ sessionId: string; controlToken: string; takeoverGeneration: number }>("POST", `/api/matches/${code}/control/takeover`, { deviceSessionId: env.rng.uuid(), reason: "仿真：浏览器注入结束，收回控制" }, { route: "/api/matches/[code]/control/takeover" });
      if (takeover.ok) {
        await chief.call("DELETE", `/api/matches/${code}/control`, { scoringSessionId: takeover.json!.sessionId, takeoverGeneration: takeover.json!.takeoverGeneration }, {
          route: "/api/matches/[code]/control",
          headers: { Authorization: `Bearer ${takeover.json!.controlToken}` },
        });
      }
      const finisher = driver(env, borrowed, env.tablets[0]);
      if (!(await finisher.acquire()).ok) throw new Error("浏览器注入结束后取得控制失败");
      await finisher.refresh();
      return finisher.play();
    });
  } finally {
    clearInterval(stopWatch);
    await browser.close().catch(() => undefined);
  }
}

async function login(page: Page, login: string, password: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.goto("/login");
    await page.getByLabel("账号", { exact: false }).fill(login);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    try {
      await page.waitForURL((url) => url.pathname === "/", { timeout: 10_000 });
      return;
    } catch {
      await sleep(4000); // 登录限流（每来源 10 秒 3 次）
    }
  }
  throw new Error("浏览器登录失败");
}

/** 两方轮流得分：浏览器部分总共只记十几分，轮流记不会触发 11 分间歇或局终待办（那些不是本项要观察的）。 */
let pointCounter = 0;
const pointButton = (page: Page) => page.getByRole("button", { name: /赢得一分$/ }).nth(pointCounter % 2);
const acquireButton = (page: Page) => page.getByRole("button", { name: "取得本机控制权" });

async function notice(page: Page) {
  const parts = await page.locator(".scoring-alert, .control-strip span, .scoring-stale").allInnerTexts().catch(() => [] as string[]);
  return parts.map((item) => item.trim()).filter(Boolean).join(" / ") || "（无提示）";
}

/** 打开比赛页并尝试取得控制、记一分。返回是否成功与界面提示。 */
async function openAndScore(page: Page, code: string, options: { goto?: boolean; acquire?: boolean } = {}) {
  if (options.goto !== false) await page.goto(`/officiating/${code}`);
  const point = pointButton(page);
  const acquire = acquireButton(page);
  await point.or(acquire).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  if (options.acquire !== false && (await acquire.isVisible().catch(() => false))) {
    await acquire.click();
    await sleep(1500);
  }
  if (!(await point.isEnabled().catch(() => false))) return { scored: false, notice: await notice(page) };
  const before = await eventCount(code);
  await point.click();
  pointCounter += 1;
  for (let index = 0; index < 20; index += 1) {
    if ((await eventCount(code)) > before) return { scored: true, notice: await notice(page) };
    await sleep(250);
  }
  return { scored: false, notice: await notice(page) };
}

async function chiefTakeoverAndRelease(env: Env, code: string) {
  const chief = env.tournament.chiefs[0].client;
  const takeover = await chief.call<{ sessionId: string; controlToken: string; takeoverGeneration: number }>("POST", `/api/matches/${code}/control/takeover`, { deviceSessionId: env.rng.uuid(), reason: "仿真注入：浏览器恢复由裁判长接管" }, { route: "/api/matches/[code]/control/takeover" });
  if (!takeover.ok) return takeover;
  return chief.call("DELETE", `/api/matches/${code}/control`, { scoringSessionId: takeover.json!.sessionId, takeoverGeneration: takeover.json!.takeoverGeneration }, {
    route: "/api/matches/[code]/control",
    headers: { Authorization: `Bearer ${takeover.json!.controlToken}` },
  });
}

/** 新标签页反复尝试取得控制直到成功（等租约过期），返回耗时。 */
async function retryUntilControl(page: Page, code: string, limitMs: number) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const result = await openAndScore(page, code);
    if (result.scored) return { ms: Date.now() - started, notice: result.notice };
    await sleep(10_000);
  }
  return { ms: null, notice: await notice(page) };
}

async function closeAndReopen(env: Env, context: BrowserContext, page: Page, code: string) {
  const first = await openAndScore(page, code);
  if (!first.scored) throw new Error(`浏览器第一次记分失败：${first.notice}`);
  env.registry.intentionalWaits.set(`inject:browser:${code}`, Date.now() + 25 * 60_000);
  // 等租约：关闭（不释放），新标签页反复尝试。
  await page.close();
  const closedAt = Date.now();
  const reopened = await context.newPage();
  const immediate = await openAndScore(reopened, code);
  const lease = immediate.scored ? { ms: 0, notice: immediate.notice } : await retryUntilControl(reopened, code, LEASE_MS + 60_000);
  // 裁判长接管：再关一次，由裁判长接管、释放后新标签页取得。
  await reopened.close();
  const again = await context.newPage();
  const blocked = await openAndScore(again, code);
  const takeoverAt = Date.now();
  const taken = await chiefTakeoverAndRelease(env, code);
  const afterTakeover = await openAndScore(again, code);
  const takeoverMs = Date.now() - takeoverAt;
  await again.close();
  probe(env, {
    id: "13.3-close-reopen",
    title: "误关标签页后重新打开",
    expected: "新标签页没有设备 ID，409 controller_exists；恢复只有两条路：等租约（≤2 分钟）或裁判长接管",
    actual: `新标签页立即尝试：${immediate.scored ? "直接取得" : `未取得（${immediate.notice}）`}；等租约恢复 ${lease.ms === null ? "超时未恢复" : `${(lease.ms / 1000).toFixed(0)} 秒`}（从关闭算 ${((Date.now() - closedAt) / 1000).toFixed(0)} 秒内）；再关一次后裁判长接管 ${brief(taken)}，新标签页 ${afterTakeover.scored ? "取得并记分" : `未取得（${afterTakeover.notice}）`}，耗时 ${(takeoverMs / 1000).toFixed(1)} 秒；接管前提示：${blocked.notice}`,
    ok: !immediate.scored && lease.ms !== null && lease.ms <= LEASE_MS + 15_000 && afterTakeover.scored,
    match: code,
  });
}

async function duplicateTab(env: Env, context: BrowserContext, code: string) {
  const original = await context.newPage();
  const start = await openAndScore(original, code);
  if (!start.scored) {
    // 上一项结束时控制在已关闭的标签页上：裁判长接管后再开始。
    await chiefTakeoverAndRelease(env, code);
    if (!(await openAndScore(original, code)).scored) throw new Error("复制标签页：原标签页取得控制失败");
  }
  const deviceKey = `badminton-device:${code}`;
  const deviceValue = await original.evaluate((key) => sessionStorage.getItem(key), deviceKey);
  // 复现「复制标签页」：新标签页加载前写入原标签页的设备 ID。
  const copy = await context.newPage();
  await copy.addInitScript(([key, value]) => {
    if (value && !sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
  }, [deviceKey, deviceValue] as const);
  const copyResult = await openAndScore(copy, code);
  const originalAfter = await openAndScore(original, code, { goto: false, acquire: false });
  const bothThinkControl = (await pointButton(copy).isEnabled().catch(() => false)) && (await pointButton(original).isEnabled().catch(() => false));
  probe(env, {
    id: "13.3-duplicate-tab",
    title: "复制标签页（两个标签页同一设备 ID）",
    expected: "后取得的标签页当作同一设备续用并换发新令牌；原标签页下一次写入 not_controller；记录两边界面显示",
    actual: `复制出的标签页 ${copyResult.scored ? "取得并记分" : `未取得（${copyResult.notice}）`}；原标签页再记分 ${originalAfter.scored ? "成功" : "失败"}，提示：${originalAfter.notice}；此刻两边记分按钮${bothThinkControl ? "都可用（两边都以为自己在控制）" : "不同时可用"}`,
    ok: copyResult.scored && !originalAfter.scored,
    match: code,
    detail: { bothThinkControl },
  });
  await original.close();
  await copy.close();
}

async function freezeAndCrash(env: Env, context: BrowserContext, code: string) {
  const results: string[] = [];
  let ok = true;
  for (const [label, frozenMs, expectKept] of [["冻结 1 分钟", 60_000, true], ["冻结 3 分钟", 180_000, false]] as const) {
    const page = await context.newPage();
    let start = await openAndScore(page, code);
    if (!start.scored) {
      await chiefTakeoverAndRelease(env, code);
      start = await openAndScore(page, code);
    }
    if (!start.scored) throw new Error(`${label}：取得控制失败`);
    // 冻结用调试器暂停页面脚本：无头 Chromium 的 Page.setWebLifecycleState frozen 不停计时器，心跳照发，模拟不到后台冻结。
    const cdp = await context.newCDPSession(page);
    await withTimeout(cdp.send("Debugger.enable"), "Debugger.enable");
    await withTimeout(cdp.send("Debugger.pause"), "Debugger.pause");
    await sleep(frozenMs);
    await withTimeout(cdp.send("Debugger.resume"), "Debugger.resume");
    await withTimeout(cdp.send("Debugger.disable"), "Debugger.disable").catch(() => undefined);
    await sleep(2000);
    const after = await openAndScore(page, code, { goto: false, acquire: false });
    const generation = await prisma.match.findUnique({ where: { code }, select: { controlGeneration: true } });
    let recovered = after.scored;
    if (!after.scored) recovered = (await openAndScore(page, code, { goto: false })).scored;
    results.push(`${label}后直接记分 ${after.scored ? "成功" : `失败（${after.notice}）`}${after.scored ? "" : `，重新取得 ${recovered ? "成功" : "失败"}`}（代次 ${generation?.controlGeneration ?? "?"}）`);
    if (after.scored !== expectKept || !recovered) ok = false;
    await page.close();
  }
  // 页面被杀：处理方式同误关标签页，这里只记界面与是否需要等租约。
  const page = await context.newPage();
  let start = await openAndScore(page, code);
  if (!start.scored) {
    await chiefTakeoverAndRelease(env, code);
    start = await openAndScore(page, code);
  }
  const cdp = await context.newCDPSession(page);
  // Page.crash 没有回应（目标已崩溃），不等它。
  void cdp.send("Page.crash").catch(() => undefined);
  await sleep(1000);
  await page.close().catch(() => undefined);
  const reopened = await context.newPage();
  const afterCrash = await openAndScore(reopened, code);
  results.push(`页面被杀后新开标签页 ${afterCrash.scored ? "直接取得" : `未取得（${afterCrash.notice}），同误关标签页`}`);
  await reopened.close();
  probe(env, {
    id: "13.3-freeze-crash",
    title: "后台冻结 / 页面被杀，心跳停止",
    expected: "冻结不到 2 分钟恢复后仍在本页控制；超过 2 分钟租约过期，重新取得后代次 +1；被杀同误关标签页",
    actual: results.join("；"),
    ok: ok && !afterCrash.scored,
    match: code,
  });
}

async function inflightOffline(env: Env, context: BrowserContext, code: string) {
  await chiefTakeoverAndRelease(env, code);
  const page = await context.newPage();
  const start = await openAndScore(page, code);
  if (!start.scored) throw new Error("在途命令：取得控制失败");
  // 让记分命令真实到达服务器，但浏览器拿不到回应（等同发出后立刻断网）。
  let intercepted = 0;
  await page.route(/\/api\/matches\/[^/]+\/commands$/, async (route) => {
    if (route.request().method() !== "POST" || intercepted > 0) return route.continue();
    intercepted += 1;
    await route.fetch().catch(() => undefined);
    await context.setOffline(true);
    await route.abort("internetdisconnected");
  });
  const before = await eventCount(code);
  await pointButton(page).click();
  pointCounter += 1;
  await sleep(3000);
  const offlineNotice = await notice(page);
  await context.setOffline(false);
  await page.unroute(/\/api\/matches\/[^/]+\/commands$/);
  // 工作台恢复在线后按原 commandId 对账；给它一点时间。
  let reconciled = false;
  for (let index = 0; index < 40; index += 1) {
    if (await pointButton(page).isEnabled().catch(() => false)) {
      reconciled = true;
      break;
    }
    await sleep(500);
  }
  const afterNotice = await notice(page);
  const added = (await eventCount(code)) - before;
  probe(env, {
    id: "13.3-inflight",
    title: "恢复时有一条在途命令（发出后立刻断网）",
    expected: "工作台按 GET commands/[id] 对账，不重复记分",
    actual: `断网时提示：${offlineNotice}；恢复后${reconciled ? "回到可写" : "仍未可写"}，提示：${afterNotice}；事件 +${added}`,
    ok: added === 1 && reconciled,
    match: code,
  });
  await page.close();
}

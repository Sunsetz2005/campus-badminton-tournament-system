import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

/**
 * 阶段 8：手机、平板、桌面五个视口的响应式与跨设备可靠性验收。
 *
 * 全部是 Chromium 浏览器设备模拟（手机视口开启 isMobile/hasTouch），**不是真机验收**；
 * 真机 iPhone/iPad/Android 的结果只能按手动验收清单另行记录。
 *
 * 截图默认写入未提交的 `local-run/`；固化证据时显式设 `PHASE8_SHOT_DIR=shots`。
 */
const shotDir = path.join(process.cwd(), "artifacts", "phase8-mobile", process.env.PHASE8_SHOT_DIR ?? "local-run");
const SLUG = "phase-1-demo";
const SINGLES = "MS-DEMO-001";
const DOUBLES = "MD-DEMO-002";
const LONG_NAME = "欧阳长名测试选手甲乙丙丁戊己庚辛壬癸子丑寅卯";

const VIEWPORTS = [
  { name: "phone-360x800", width: 360, height: 800, mobile: true },
  { name: "phone-390x844", width: 390, height: 844, mobile: true },
  { name: "tablet-768x1024", width: 768, height: 1024, mobile: true },
  { name: "tablet-1024x768", width: 1024, height: 768, mobile: true },
  { name: "desktop-1440x900", width: 1440, height: 900, mobile: false },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

function contextOptions(viewport: Viewport): BrowserContextOptions {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    deviceScaleFactor: viewport.mobile ? 2 : 1,
  };
}

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("账号", { exact: false }).fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function loggedIn(browser: Browser, email: string, password: string, options: BrowserContextOptions) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await login(page, email, password);
  return { context, page };
}

async function shot(page: Page, name: string, fullPage = true) {
  mkdirSync(shotDir, { recursive: true });
  // CSS 像素尺寸的 JPEG：五视口 × 多页面的证据体积控制在仓库可接受范围。
  await page.screenshot({ path: path.join(shotDir, `${name}.jpg`), fullPage, type: "jpeg", quality: 72, scale: "css" });
}

/** 根级横向溢出；溢出时列出越界元素，便于定位。受控的局部横向滚动容器不算。 */
async function expectNoRootOverflow(page: Page, label: string) {
  const report = await page.evaluate(() => {
    const root = document.documentElement;
    const overflow = root.scrollWidth - root.clientWidth;
    if (overflow <= 1) return { overflow, offenders: [] as string[] };
    const width = root.clientWidth;
    const offenders: string[] = [];
    for (const element of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const rect = element.getBoundingClientRect();
      if (rect.right <= width + 1 || rect.width === 0) continue;
      let scrollParent = element.parentElement;
      let clipped = false;
      while (scrollParent && scrollParent !== document.body) {
        const style = getComputedStyle(scrollParent);
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) { clipped = true; break; }
        scrollParent = scrollParent.parentElement;
      }
      if (!clipped) offenders.push(`${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)} → ${Math.round(rect.right)}`);
      if (offenders.length >= 6) break;
    }
    return { overflow, offenders };
  });
  expect(report.overflow, `${label} 根级横向溢出 ${report.overflow}px：${report.offenders.join("；")}`).toBeLessThanOrEqual(1);
}

async function resetMatches() {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const matches = await prisma.match.findMany({ where: { code: { in: [SINGLES, DOUBLES] } }, select: { id: true } });
  const ids = matches.map((item) => item.id);
  await prisma.matchEvent.deleteMany({ where: { matchId: { in: ids } } });
  await prisma.matchSnapshot.deleteMany({ where: { matchId: { in: ids } } });
  await prisma.resultRevision.deleteMany({ where: { matchId: { in: ids } } });
  await prisma.scoringSession.deleteMany({ where: { matchId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
  await prisma.game.updateMany({ where: { matchId: { in: ids } }, data: { scoreA: 0, scoreB: 0, completed: false } });
  await prisma.match.updateMany({
    where: { id: { in: ids } },
    data: {
      version: 0,
      controlGeneration: 1,
      lifecycleStatus: "READY",
      outcomeType: null,
      verificationStatus: "UNVERIFIED",
      startedAt: null,
      endedAt: null,
    },
  });
  const demoEmails = [process.env.DEMO_ADMIN_EMAIL, process.env.DEMO_REFEREE_EMAIL].filter(
    (email): email is string => Boolean(email),
  );
  await prisma.session.deleteMany({ where: { user: { email: { in: demoEmails } } } });
}

/** 把单打 A 方改成超长姓名，检查换行不截断；测试结束恢复。 */
async function setSinglesSideAName(name: string | null) {
  const match = await prisma.match.findUniqueOrThrow({
    where: { code: SINGLES },
    select: { sideAEntry: { select: { id: true, members: { select: { participantId: true } } } } },
  });
  const entry = match.sideAEntry!;
  const participantId = entry.members[0]!.participantId;
  const original = await prisma.participant.findUniqueOrThrow({ where: { id: participantId }, select: { displayName: true } });
  const originalEntry = await prisma.entry.findUniqueOrThrow({ where: { id: entry.id }, select: { displayName: true } });
  if (name) {
    await prisma.participant.update({ where: { id: participantId }, data: { displayName: name } });
    await prisma.entry.update({ where: { id: entry.id }, data: { displayName: name } });
  }
  return async () => {
    await prisma.participant.update({ where: { id: participantId }, data: { displayName: original.displayName } });
    await prisma.entry.update({ where: { id: entry.id }, data: { displayName: originalEntry.displayName } });
  };
}

async function recordDefaultCoinToss(page: Page) {
  await page.locator('input[name="coin-toss-winner"][value="A"]').check();
  await page.locator('input[name="coin-toss-category"][value="SERVICE"]').check();
  await page.locator('input[name="coin-toss-service"][value="SERVE"]').check();
  await page.locator('input[name="coin-toss-end"][value="END_2"]').check();
  await page.getByRole("button", { name: "确认并记录抛币" }).click();
}

async function serverVersion(page: Page, matchCode: string) {
  const response = await page.request.get(`/api/matches/${matchCode}/state`);
  expect(response.status()).toBe(200);
  return (await response.json()).version as number;
}

/** 计分区的触控与误触检查：+1 与更正都在视口内、够大，且两者之间留有明显间隔。 */
async function checkScoreConsole(page: Page, label: string) {
  const geometry = await page.evaluate(() => {
    const sides = Array.from(document.querySelectorAll<HTMLElement>(".court-score-side"));
    return sides.map((side) => {
      const plus = side.querySelector<HTMLElement>(".score-adjust.plus")!.getBoundingClientRect();
      const minus = side.querySelector<HTMLElement>(".score-adjust.minus")!.getBoundingClientRect();
      const gap = plus.left < minus.left ? minus.left - plus.right : plus.left - minus.right;
      return {
        gap,
        plus: { left: plus.left, right: plus.right, width: plus.width, height: plus.height },
        minus: { width: minus.width, height: minus.height },
        viewportWidth: document.documentElement.clientWidth,
      };
    });
  });
  expect(geometry, label).toHaveLength(2);
  for (const side of geometry) {
    expect(side.plus.left, `${label} +1 左缘在视口内`).toBeGreaterThanOrEqual(0);
    expect(side.plus.right, `${label} +1 右缘在视口内`).toBeLessThanOrEqual(side.viewportWidth);
    expect(side.plus.height, `${label} +1 触控高度`).toBeGreaterThanOrEqual(44);
    expect(side.plus.width, `${label} +1 触控宽度`).toBeGreaterThanOrEqual(44);
    expect(side.minus.width, `${label} 更正触控宽度`).toBeGreaterThanOrEqual(44);
    expect(side.minus.height, `${label} 更正触控高度`).toBeGreaterThanOrEqual(44);
    expect(side.gap, `${label} +1 与更正的间隔`).toBeGreaterThanOrEqual(12);
  }
}

test.describe("阶段 8：全站基础约束", () => {
  test("浏览器缩放未被禁止，应用清单与图标可用，安全响应头齐全", async ({ page, request }) => {
    const response = await page.goto("/");
    const viewportMeta = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewportMeta).toContain("width=device-width");
    expect(viewportMeta).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
    expect(viewportMeta).not.toMatch(/maximum-scale/i);

    const headers = response!.headers();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBeTruthy();
    const manifest = await (await request.get(manifestHref!)).json();
    expect(manifest).toMatchObject({ short_name: "赛事台", display: "standalone", start_url: "/" });
    for (const icon of manifest.icons as { src: string }[]) {
      const iconResponse = await request.get(icon.src);
      expect(iconResponse.status(), icon.src).toBe(200);
      expect(iconResponse.headers()["content-type"]).toBe("image/png");
    }
    expect((await request.get("/apple-icon.png")).status()).toBe(200);
    // 不注册 Service Worker：比分与执裁命令不能进入陈旧缓存。
    expect(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations())?.length ?? 0)).toBe(0);
  });

  test("跨站来源的写请求在进入权限校验前被拒绝；本站来源照常进入会话校验", async ({ request }) => {
    const crossSite = await request.post(`/api/matches/${SINGLES}/commands`, {
      headers: { Origin: "https://evil.example" },
      data: {},
    });
    expect(crossSite.status()).toBe(403);
    expect((await crossSite.json()).error.code).toBe("cross_origin_rejected");

    const opaque = await request.post(`/api/matches/${SINGLES}/control`, { headers: { Origin: "null" }, data: {} });
    expect(opaque.status()).toBe(403);

    const crossSiteFetch = await request.put(`/api/matches/${SINGLES}/control/heartbeat`, {
      headers: { "Sec-Fetch-Site": "cross-site" },
      data: {},
    });
    expect(crossSiteFetch.status()).toBe(403);

    const sameOrigin = await request.post(`/api/matches/${SINGLES}/commands`, {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: {},
    });
    expect(sameOrigin.status()).toBe(401);

    // 超大请求体在 proxy 按声明长度提前以 413 拒绝，不进入路由。
    const oversized = await request.post(`/api/matches/${SINGLES}/commands`, {
      headers: { Origin: "http://127.0.0.1:3100", "Content-Type": "application/json" },
      data: Buffer.alloc(5 * 1024 * 1024, 32),
    });
    expect(oversized.status()).toBe(413);
    expect((await oversized.json()).error.code).toBe("payload_too_large");

    // 公开只读接口不受写来源限制。
    const publicRead = await request.get(`/api/public/tournaments/${SLUG}`, { headers: { Origin: "https://evil.example" } });
    expect(publicRead.status()).toBe(200);
  });

  test("登录接口同样拒绝跨站来源：用户名登录不再绕过来源校验", async ({ request }) => {
    // 2026-10-09 演示站实测：不带 Cookie 时 Better Auth 的 /sign-in/username 不校验来源。
    const crossSiteHeaders = {
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "cors",
    };
    const attempts = [
      { path: "/api/auth/sign-in/username", data: { username: "nobodyx", password: "wrong-password-123" } },
      { path: "/api/auth/sign-in/email", data: { email: "nobody@example.com", password: "wrong-password-123" } },
      { path: "/api/auth/sign-out", data: {} },
    ];
    for (const attempt of attempts) {
      const response = await request.post(attempt.path, { headers: crossSiteHeaders, data: attempt.data });
      expect(response.status(), attempt.path).toBe(403);
      expect((await response.json()).error.code, attempt.path).toBe("cross_origin_rejected");
    }

    // 本站来源照常进入 Better Auth（口令错误 401；若撞上其登录限流则 429），不被 proxy 拦下。
    const sameOrigin = await request.post("/api/auth/sign-in/username", {
      headers: { Origin: "http://127.0.0.1:3100", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
      data: { username: "nobodyx", password: "wrong-password-123" },
    });
    expect([401, 429]).toContain(sameOrigin.status());
  });
});

test.describe("阶段 8：公开页面五视口", () => {
  for (const viewport of VIEWPORTS) {
    test(`公开页面在 ${viewport.name} 无根级横向溢出`, async ({ browser }) => {
      const context = await browser.newContext(contextOptions(viewport));
      const page = await context.newPage();
      const pages: [string, string, boolean][] = [
        ["home", "/", true],
        ["login", "/login", false],
        ["schedule", `/public/${SLUG}/schedule?date=2026-09-21`, true],
        ["match-detail", `/public/${SLUG}/matches/MS-DONE-001`, true],
        ["results", `/public/${SLUG}/results`, true],
        ["downloads", `/public/${SLUG}/downloads`, false],
        ["board", `/public/${SLUG}/board`, true],
      ];
      for (const [name, url, capture] of pages) {
        const response = await page.goto(url);
        expect(response?.status(), `${name} 状态码`).toBeLessThan(400);
        await expectNoRootOverflow(page, `${viewport.name} ${name}`);
        if (capture) await shot(page, `public-${name}-${viewport.name}`);
      }

      if (viewport.mobile && viewport.width < 768) {
        // iOS Safari 对小于 16px 的输入框会在聚焦时自动放大页面，打乱裁判/管理员的输入。
        await page.goto("/login");
        const fontSizes = await page.locator("input").evaluateAll((inputs) =>
          inputs.map((input) => parseFloat(getComputedStyle(input).fontSize)),
        );
        for (const size of fontSizes) expect(size, "手机输入框字号").toBeGreaterThanOrEqual(16);
      }
      await context.close();
    });
  }
});

test.describe.serial("阶段 8：裁判工作台五视口、长姓名与两设备同步", () => {
  test.describe.configure({ timeout: 240_000 });
  let restoreName: (() => Promise<void>) | null = null;

  test.beforeAll(async () => {
    await resetMatches();
    restoreName = await setSinglesSideAName(LONG_NAME);
  });

  test.afterAll(async () => {
    await restoreName?.();
    await resetMatches();
  });

  test("控制端在五个视口间旋转/缩放：计分区可用、不溢出、长姓名不截断、焦点可见，版本不因旋转改变", async ({ browser }) => {
    const controller = await loggedIn(
      browser,
      process.env.DEMO_REFEREE_EMAIL!,
      process.env.DEMO_REFEREE_PASSWORD!,
      { viewport: { width: 1024, height: 768 }, hasTouch: true },
    );
    const page = controller.page;
    await page.goto(`/officiating/${SINGLES}`);
    await page.getByRole("button", { name: "取得本机控制权" }).click();
    await recordDefaultCoinToss(page);
    await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    const plusA = page.getByRole("button", { name: `${LONG_NAME} 赢得一分` });
    await plusA.click();
    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("1");

    // 屏幕常亮：本地 HTTP 127.0.0.1 属安全上下文，Chromium 无头模式可能拒绝，三种结果都必须有文字说明。
    await expect(page.getByTestId("wake-lock-status")).toContainText(/常亮(已开启|未开启|不可用|被系统拒绝)/);

    const version = await serverVersion(page, SINGLES);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
      await expect(plusA).toBeEnabled();
      await expectNoRootOverflow(page, `工作台 ${viewport.name}`);
      await checkScoreConsole(page, `工作台 ${viewport.name}`);

      // 长姓名：换行显示，不能被省略号截断。
      const truncated = await page.locator(".scoreboard-team, .player-name").evaluateAll((nodes) =>
        nodes.filter((node) => node.textContent?.includes("欧阳") && node.scrollWidth > node.clientWidth + 1).length,
      );
      expect(truncated, `${viewport.name} 长姓名被截断`).toBe(0);

      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, `referee-singles-${viewport.name}`, false);
    }
    expect(await serverVersion(page, SINGLES), "旋转与缩放不产生服务器事件").toBe(version);

    // 键盘焦点可见：Tab 进入 +1 后有明显的焦点轮廓。
    await page.setViewportSize({ width: 390, height: 844 });
    await plusA.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const outline = await plusA.evaluate((node) => {
      const style = getComputedStyle(node);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), focused: node.matches(":focus-visible") };
    });
    expect(outline.focused).toBe(true);
    expect(outline.style).not.toBe("none");
    expect(outline.width).toBeGreaterThanOrEqual(2);

    // 状态不只靠颜色：网络、控制、同步都以文字给出。
    const statusText = await page.locator(".status-facts").innerText();
    for (const word of ["网络", "在线", "控制", "本机可写", "同步", "数据"]) expect(statusText).toContain(word);

    // 更正入口只打开服务器预览，点它不会写入。
    await page.getByRole("button", { name: `更正 ${LONG_NAME} 的最近得分` }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("关闭").click();
    expect(await serverVersion(page, SINGLES)).toBe(version);

    // 显式释放本机控制；否则租约有效期内另一台设备不能直接取得（需裁判长接管）。
    const control = JSON.parse((await page.evaluate((code) => sessionStorage.getItem(`badminton-control:${code}`), SINGLES))!);
    const released = await page.request.delete(`/api/matches/${SINGLES}/control`, {
      headers: { Authorization: `Bearer ${control.controlToken}` },
      data: { scoringSessionId: control.sessionId, takeoverGeneration: control.takeoverGeneration },
    });
    expect(released.status(), await released.text()).toBe(200);
    await controller.context.close();
  });

  test("两个独立浏览器上下文：控制端写入，手机只读端与公开页在实测延迟内看到同一权威版本；断网禁写、恢复后对账", async ({ browser }, testInfo) => {
    const controller = await loggedIn(
      browser,
      process.env.DEMO_REFEREE_EMAIL!,
      process.env.DEMO_REFEREE_PASSWORD!,
      { viewport: { width: 1024, height: 768 }, hasTouch: true },
    );
    const page = controller.page;
    await page.goto(`/officiating/${SINGLES}`);
    // 上一条用例的控制会话随上下文关闭仍在租期内；这里由同一裁判在新设备上重新取得。
    const acquire = page.getByRole("button", { name: "取得本机控制权" });
    await acquire.click();
    const plusA = page.getByRole("button", { name: `${LONG_NAME} 赢得一分` });
    const coinToss = page.getByRole("button", { name: "确认并记录抛币" });
    await expect(plusA.or(coinToss).first()).toBeVisible();
    if (await coinToss.isVisible()) {
      // 单独运行本用例时比赛尚未开局。
      await recordDefaultCoinToss(page);
      await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    }
    await expect(plusA).toBeEnabled();

    // 只读端 1：同一裁判的第二台设备（独立上下文，不持有控制权）。
    await new Promise((resolve) => setTimeout(resolve, 3_500)); // 避开登录接口 10 秒 3 次的限流
    const readonly = await loggedIn(
      browser,
      process.env.DEMO_REFEREE_EMAIL!,
      process.env.DEMO_REFEREE_PASSWORD!,
      contextOptions(VIEWPORTS[1]),
    );
    await readonly.page.goto(`/officiating/${SINGLES}`);
    await expect(readonly.page.getByRole("button", { name: `${LONG_NAME} 赢得一分` })).toBeDisabled();

    // 只读端 2：未登录观众的公开比分页（独立上下文，手机视口）。
    const viewerContext = await browser.newContext(contextOptions(VIEWPORTS[0]));
    const viewer = await viewerContext.newPage();
    await viewer.goto(`/public/${SLUG}/matches/${SINGLES}`);
    await expect(viewer.getByText(/每 10 秒自动更新/)).toBeVisible();

    const latencies = { refereeReadonlyMs: [] as number[], publicViewerMs: [] as number[] };
    for (let round = 0; round < 3; round += 1) {
      await plusA.click();
      const target = await serverVersion(page, SINGLES);
      await expect(page.locator(".status-facts small")).toHaveText(`服务器版本 ${target}`);
      const writtenAt = Date.now();
      await expect(readonly.page.locator(".status-facts small")).toHaveText(`服务器版本 ${target}`, { timeout: 15_000 });
      latencies.refereeReadonlyMs.push(Date.now() - writtenAt);
      await expect(viewer.getByText(`比分版本 ${target}`)).toBeVisible({ timeout: 25_000 });
      latencies.publicViewerMs.push(Date.now() - writtenAt);
    }
    testInfo.annotations.push({ type: "measured-latency", description: JSON.stringify(latencies) });
    console.info(`[phase8] 实测写入→只读可见延迟（毫秒）：${JSON.stringify(latencies)}`);
    // 只读工作台 2 秒轮询、公开页 10 秒轮询；上限按轮询间隔加渲染余量断言，不宣称实时。
    for (const value of latencies.refereeReadonlyMs) expect(value).toBeLessThan(6_000);
    for (const value of latencies.publicViewerMs) expect(value).toBeLessThan(16_000);
    await expect(viewer.getByText(/进行中/).first()).toBeVisible();
    await expect(viewer.getByText("已确认", { exact: true })).toHaveCount(0);
    await shot(viewer, "viewer-live-phone-360x800");
    await shot(readonly.page, "referee-readonly-phone-390x844", false);

    // 断网：控制端立即禁写并保留最后确认比分；公开页说明显示的是哪一刻的数据。
    const beforeOffline = await serverVersion(page, SINGLES);
    const scoreBefore = await page.locator('[data-scoreboard-side="A"] .court-score-number').innerText();
    await controller.context.setOffline(true);
    await expect(plusA).toBeDisabled();
    await expect(page.locator(".status-facts")).toContainText("离线");
    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText(scoreBefore);
    await viewerContext.setOffline(true);
    await expect(viewer.getByText(/网络已断开 · 显示的是/)).toBeVisible();
    await shot(viewer, "viewer-offline-phone-360x800");

    await controller.context.setOffline(false);
    await viewerContext.setOffline(false);
    await expect(page.locator(".status-facts")).toContainText("在线");
    await expect(plusA).toBeEnabled({ timeout: 10_000 });
    expect(await serverVersion(page, SINGLES), "断网期间没有任何写入").toBe(beforeOffline);
    await expect(viewer.getByText(/每 10 秒自动更新/)).toBeVisible();

    await controller.context.close();
    await readonly.context.close();
    await viewerContext.close();
  });
});

test.describe("阶段 8：后台与裁判长页面五视口", () => {
  test.describe.configure({ timeout: 240_000 });

  test("管理员后台各页在五个视口无根级溢出（大表格走局部横向滚动）", async ({ browser }) => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const admin = await loggedIn(
      browser,
      process.env.DEMO_ADMIN_EMAIL!,
      process.env.DEMO_ADMIN_PASSWORD!,
      { viewport: { width: 1440, height: 900 } },
    );
    const urls: [string, string][] = [
      ["management", "/management"],
      ["tournament", `/management/${SLUG}`],
      ["registrations", `/management/${SLUG}/registrations`],
      ["schedule", `/management/${SLUG}/schedule`],
      ["results", `/management/${SLUG}/results`],
      ["reports", `/management/${SLUG}/reports`],
      ["new-tournament", "/management/new"],
      // 演示数据里管理员同时是该赛事的裁判长。
      ["chief-board", `/officiating/board/${SLUG}`],
    ];
    for (const viewport of VIEWPORTS) {
      await admin.page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const [name, url] of urls) {
        const response = await admin.page.goto(url);
        expect(response?.status(), `${name} 状态码`).toBeLessThan(400);
        await expectNoRootOverflow(admin.page, `${viewport.name} 后台 ${name}`);
        if (name === "schedule" || name === "results" || name === "chief-board") await shot(admin.page, `admin-${name}-${viewport.name}`);
      }
    }
    await admin.context.close();
  });

  test("裁判的「我的执裁」在五个视口无根级溢出", async ({ browser }) => {
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const referee = await loggedIn(
      browser,
      process.env.DEMO_REFEREE_EMAIL!,
      process.env.DEMO_REFEREE_PASSWORD!,
      { viewport: { width: 1440, height: 900 } },
    );
    for (const viewport of VIEWPORTS) {
      await referee.page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const [name, url] of [["my-matches", "/officiating"]] as const) {
        const response = await referee.page.goto(url);
        expect(response?.status(), `${name} 状态码`).toBeLessThan(400);
        await expectNoRootOverflow(referee.page, `${viewport.name} ${name}`);
        await shot(referee.page, `referee-${name}-${viewport.name}`);
      }
    }
    await referee.context.close();
  });
});

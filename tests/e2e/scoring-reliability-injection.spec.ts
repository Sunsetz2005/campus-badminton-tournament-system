import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";

/**
 * R3-002 / R3-003 的浏览器注入回归。
 *
 * 这些缺陷只在真实页面的响应竞态里出现，因此在原项目里用 page.route 注入：
 * 迟到的历史回执、服务器已落库但网关返回 5xx、200 但响应结构不符。
 */

const MATCH_CODE = "MS-DEMO-001";
const PENDING_KEY = `badminton-pending:${MATCH_CODE}`;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("登录邮箱").fill(process.env.DEMO_REFEREE_EMAIL!);
  await page.getByLabel("密码").fill(process.env.DEMO_REFEREE_PASSWORD!);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

/**
 * RV3-002：抛币改为分步表单后，页面上不再有写死的“A 方胜并选先发”按钮。
 * 这个辅助函数按胜方/类别/具体选择驱动真实表单，默认组合与旧按钮等价（A 胜选先发、B 选 END_2）。
 */
async function recordCoinToss(page: Page, options?: {
  winner?: "A" | "B";
  category?: "SERVICE" | "END";
  service?: "SERVE" | "RECEIVE";
  end?: "END_1" | "END_2";
}) {
  const winner = options?.winner ?? "A";
  const category = options?.category ?? "SERVICE";
  const service = options?.service ?? "SERVE";
  const end = options?.end ?? "END_2";
  await page.locator(`input[name="coin-toss-winner"][value="${winner}"]`).check();
  await page.locator(`input[name="coin-toss-category"][value="${category}"]`).check();
  if (category === "SERVICE") {
    await page.locator(`input[name="coin-toss-service"][value="${service}"]`).check();
    await page.locator(`input[name="coin-toss-end"][value="${end}"]`).check();
  } else {
    await page.locator(`input[name="coin-toss-end"][value="${end}"]`).check();
    await page.locator(`input[name="coin-toss-service"][value="${service}"]`).check();
  }
  await page.getByRole("button", { name: "确认并记录抛币" }).click();
}

async function resetMatch() {
  const match = await prisma.match.findUniqueOrThrow({ where: { code: MATCH_CODE }, select: { id: true } });
  await prisma.matchEvent.deleteMany({ where: { matchId: match.id } });
  await prisma.matchSnapshot.deleteMany({ where: { matchId: match.id } });
  await prisma.resultRevision.deleteMany({ where: { matchId: match.id } });
  await prisma.scoringSession.deleteMany({ where: { matchId: match.id } });
  await prisma.auditLog.deleteMany({ where: { targetId: match.id } });
  await prisma.game.updateMany({ where: { matchId: match.id }, data: { scoreA: 0, scoreB: 0, completed: false } });
  await prisma.match.update({
    where: { id: match.id },
    data: {
      version: 0, controlGeneration: 1, lifecycleStatus: "READY",
      outcomeType: null, verificationStatus: "UNVERIFIED", startedAt: null, endedAt: null,
    },
  });
  const demoEmails = [process.env.DEMO_ADMIN_EMAIL, process.env.DEMO_REFEREE_EMAIL].filter(
    (email): email is string => Boolean(email),
  );
  await prisma.session.deleteMany({ where: { user: { email: { in: demoEmails } } } });
}

/** 打开工作台、取得控制权并开赛，返回时比分为 0:0。 */
async function openAndStart(page: Page) {
  await page.goto(`/officiating/${MATCH_CODE}`);
  await page.getByRole("button", { name: "取得本机控制权" }).click();
  await recordCoinToss(page);
  await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
  // 等到开赛命令的回执真正落地（加分按钮可用），否则后续注入会被这条命令的收尾覆盖。
  await expect(page.locator(".score-adjust.plus").first()).toBeEnabled();
  await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("0");
  await expect(page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)).resolves.toBeNull();
}

function scoreA(page: Page) {
  return page.locator('[data-scoreboard-side="A"] .court-score-number');
}

test.describe.serial("R3-002/R3-003 响应竞态与结果未知的浏览器注入回归", () => {
  test.beforeEach(resetMatch);
  test.afterEach(resetMatch);

  test("R3-002：按原 commandId 找回的旧回执可核销命令，但界面不得倒退到旧版本", async ({ page }) => {
    await login(page);
    await openAndStart(page);

    const addPoint = page.getByRole("button", { name: "模拟选手 01 赢得一分" });
    await addPoint.click();
    await expect(scoreA(page)).toHaveText("1");
    // 记下这一分的 commandId：服务器保存的回执停留在比分 1 的那个版本。
    const oldCommand = await prisma.matchEvent.findFirstOrThrow({
      where: { match: { code: MATCH_CODE }, type: "RALLY_WON" },
      orderBy: { version: "desc" },
      select: { commandId: true, version: true },
    });
    await addPoint.click();
    await expect(scoreA(page)).toHaveText("2");
    const newerVersion = (await prisma.match.findUniqueOrThrow({ where: { code: MATCH_CODE }, select: { version: true } })).version;
    expect(newerVersion).toBeGreaterThan(oldCommand.version);
    await expect(page.locator(".status-facts")).toContainText(`服务器版本 ${newerVersion}`);

    // 注入：页面在已经拿到较新版本后，才把这条旧命令当作待确认项去对账。
    await page.evaluate(([key, envelope]) => localStorage.setItem(key as string, envelope as string), [
      PENDING_KEY,
      JSON.stringify({
        commandId: oldCommand.commandId,
        occurredAt: new Date().toISOString(),
        expectedVersion: oldCommand.version - 1,
        scoringSessionId: "replayed-session",
        takeoverGeneration: 1,
        type: "RALLY_WON",
        payload: { side: "A" },
      }),
    ]);
    const recovery = page.locator(".pending-recovery");
    await expect(recovery).toBeVisible({ timeout: 8_000 });

    // 拖慢权威状态轮询，避免后续刷新把「短暂倒退」掩盖过去——倒退本身就是缺陷。
    await page.route(`**/api/matches/${MATCH_CODE}/state*`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.continue();
    });
    await recovery.getByRole("button", { name: "查询原命令结果" }).click();

    // 在整个采样窗口里比分都不得回到旧回执的 1 分。
    const samples: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      samples.push(await scoreA(page).innerText());
      await page.waitForTimeout(100);
    }
    expect(samples).not.toContain("1");
    await page.unroute(`**/api/matches/${MATCH_CODE}/state*`);

    // 命令被正确核销，但比分与版本都不得倒退，也不得把过期数据标成新鲜之外的状态。
    await expect(recovery).toBeHidden();
    await expect(page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)).resolves.toBeNull();
    await expect(scoreA(page)).toHaveText("2");
    await expect(page.locator(".status-facts")).toContainText(`服务器版本 ${newerVersion}`);
    await expect(page.locator(".scoring-alert")).toContainText("界面继续显示更新的服务器权威状态");
  });

  test("R3-003：服务器已落库但网关返回 502 时保留原 commandId，不允许开始新操作", async ({ page }) => {
    await login(page);
    await openAndStart(page);

    // 让请求真的打到服务器（命令会落库），再把响应替换成 502 网关错误。
    // 同时暂时挡住命令结果查询，好让"结果未知"这一刻在断言里稳定可见。
    let injectGatewayError = true;
    await page.route(`**/api/matches/${MATCH_CODE}/commands`, async (route) => {
      if (!injectGatewayError) return route.continue();
      await route.fetch();
      await route.fulfill({
        body: "<html><body>502 Bad Gateway</body></html>",
        contentType: "text/html",
        status: 502,
      });
    });
    await page.route(`**/api/matches/${MATCH_CODE}/commands/*`, async (route) => {
      if (!injectGatewayError) return route.continue();
      await route.fulfill({
        body: JSON.stringify({ error: { code: "command_not_found", message: "故障注入期间暂不返回命令结果。" } }),
        contentType: "application/json",
        status: 404,
      });
    });

    const addPoint = page.getByRole("button", { name: "模拟选手 01 赢得一分" });
    await addPoint.click();

    const recovery = page.locator(".pending-recovery");
    await expect(recovery).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".status-facts")).toContainText("响应待确认");
    // 关键断言：待确认命令没有被 5xx 直接删除。
    const pending = await page.evaluate((key) => localStorage.getItem(key), PENDING_KEY);
    expect(pending).not.toBeNull();
    const pendingCommandId = JSON.parse(pending!).commandId as string;
    await expect(page.locator(".score-adjust.plus").first()).toBeDisabled();
    await expect(page.locator(".score-adjust.plus").last()).toBeDisabled();

    // 命令确实落了库，而且只落了一次；恢复后按原 ID 对账而不是新建一条。
    await expect.poll(() => prisma.matchEvent.count({
      where: { match: { code: MATCH_CODE }, commandId: pendingCommandId },
    })).toBe(1);

    injectGatewayError = false;
    await recovery.getByRole("button", { name: "查询原命令结果" }).click();
    await expect(recovery).toBeHidden();
    await expect(scoreA(page)).toHaveText("1");
    await expect(page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)).resolves.toBeNull();
    await expect.poll(() => prisma.matchEvent.count({
      where: { match: { code: MATCH_CODE }, type: "RALLY_WON" },
    })).toBe(1);
  });

  test("R3-003：200 但响应结构不符时不清除待确认命令，也不显示已同步", async ({ page }) => {
    await login(page);
    await openAndStart(page);

    let injectMalformed = true;
    await page.route(`**/api/matches/${MATCH_CODE}/commands`, async (route) => {
      if (!injectMalformed) return route.continue();
      const real = await route.fetch();
      const body = await real.json();
      // 200，但缺少 state：不能据此判定命令成功。
      await route.fulfill({
        body: JSON.stringify({ status: "accepted", commandId: body.commandId, version: body.version }),
        contentType: "application/json",
        status: 200,
      });
    });
    await page.route(`**/api/matches/${MATCH_CODE}/commands/*`, async (route) => {
      if (!injectMalformed) return route.continue();
      await route.fulfill({
        body: JSON.stringify({ error: { code: "command_not_found", message: "故障注入期间暂不返回命令结果。" } }),
        contentType: "application/json",
        status: 404,
      });
    });

    await page.getByRole("button", { name: "模拟选手 01 赢得一分" }).click();
    const recovery = page.locator(".pending-recovery");
    await expect(recovery).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".status-facts")).toContainText("响应待确认");
    await expect(page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)).resolves.not.toBeNull();

    injectMalformed = false;
    await recovery.getByRole("button", { name: "查询原命令结果" }).click();
    await expect(recovery).toBeHidden();
    await expect(scoreA(page)).toHaveText("1");
  });

  test("R3-003：本机待确认记录损坏时进入受控恢复，不清空也不假成功", async ({ page }) => {
    await login(page);
    await openAndStart(page);
    await page.evaluate((key) => localStorage.setItem(key, "{损坏的记录"), PENDING_KEY);
    await expect(page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)).resolves.toBe("{损坏的记录");
    await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));

    const recovery = page.locator(".pending-recovery");
    await expect(recovery).toBeVisible({ timeout: 8_000 });
    await expect(recovery).toContainText("本机待确认命令记录无法解析");
    await expect(page.locator(".status-facts")).toContainText("响应待确认");
    // 损坏记录既没有被清空，也没有被当成"已同步"。
    await expect(page.evaluate((key) => localStorage.getItem(key), PENDING_KEY)).resolves.toBe("{损坏的记录");
    await expect(page.locator(".score-adjust.plus").first()).toBeDisabled();
  });
});

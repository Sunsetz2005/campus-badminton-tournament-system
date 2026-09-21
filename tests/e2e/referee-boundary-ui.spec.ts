/**
 * RV3-002 / RV3-004 的浏览器验收：抛币四类组合必须能在页面上表达，
 * 局末 / 赛末误点必须有正常撤销入口。领域测试支持这些组合不等于页面可操作。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import type { MatchState } from "../../src/domain/rules/match-engine";

type ScoringControl = { controlToken: string; sessionId: string; takeoverGeneration: number };

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("登录邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function resetMatches() {
  const matches = await prisma.match.findMany({ where: { code: { in: ["MS-DEMO-001", "MD-DEMO-002"] } }, select: { id: true } });
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
      version: 0, controlGeneration: 1, lifecycleStatus: "READY", outcomeType: null,
      verificationStatus: "UNVERIFIED", startedAt: null, endedAt: null,
    },
  });
  const demoEmails = [process.env.DEMO_ADMIN_EMAIL, process.env.DEMO_REFEREE_EMAIL].filter((email): email is string => Boolean(email));
  await prisma.session.deleteMany({ where: { user: { email: { in: demoEmails } } } });
}

async function readAuthoritativeState(request: APIRequestContext, matchCode: string) {
  const response = await request.get(`/api/matches/${matchCode}/state`);
  expect(response.status()).toBe(200);
  return (await response.json()).state as MatchState;
}

async function readBrowserControl(page: Page, matchCode: string) {
  const raw = await page.evaluate((code) => sessionStorage.getItem(`badminton-control:${code}`), matchCode);
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as ScoringControl;
}

async function sendCommand(
  request: APIRequestContext, matchCode: string, control: ScoringControl, state: MatchState,
  type: string, payload: unknown,
) {
  const response = await request.post(`/api/matches/${matchCode}/commands`, {
    headers: { Authorization: `Bearer ${control.controlToken}` },
    data: {
      commandId: crypto.randomUUID(), occurredAt: new Date().toISOString(),
      expectedVersion: state.version, scoringSessionId: control.sessionId,
      takeoverGeneration: control.takeoverGeneration, type, payload,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).state as MatchState;
}

async function openWithControl(page: Page, matchCode: string) {
  await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
  await page.goto(`/officiating/${matchCode}`);
  await page.getByRole("button", { name: "取得本机控制权" }).click();
}

test.describe.serial("RV3-002 / RV3-004 裁判页边界交互", () => {
  test.beforeEach(resetMatches);
  test.afterAll(async () => { await prisma.$disconnect(); });

  test("RV3-002 胜方选发球类别后，负方可以自行选择任一场地端", async ({ page }) => {
    const matchCode = "MS-DEMO-001";
    const request = page.context().request;
    await openWithControl(page, matchCode);

    // 确认提交前不产生任何事件：选择过程不是命令。
    await page.locator('input[name="coin-toss-winner"][value="A"]').check();
    await page.locator('input[name="coin-toss-category"][value="SERVICE"]').check();
    await page.locator('input[name="coin-toss-service"][value="SERVE"]').check();
    expect((await readAuthoritativeState(request, matchCode)).phase).toBe("AWAITING_COIN_TOSS");
    await expect(page.getByRole("button", { name: "确认并记录抛币" })).toBeDisabled();

    // 取消重选不提交，也不保留半成品。
    await page.getByRole("button", { name: "取消重选" }).click();
    await expect(page.locator('input[name="coin-toss-winner"][value="A"]')).not.toBeChecked();
    expect((await readAuthoritativeState(request, matchCode)).phase).toBe("AWAITING_COIN_TOSS");

    await page.locator('input[name="coin-toss-winner"][value="A"]').check();
    await page.locator('input[name="coin-toss-category"][value="SERVICE"]').check();
    await page.locator('input[name="coin-toss-service"][value="RECEIVE"]').check();
    // 旧版本把负方固定成 END_2；这里选 END_1 才能证明负方选择真的可用。
    await page.locator('input[name="coin-toss-end"][value="END_1"]').check();
    await expect(page.getByTestId("coin-toss-summary")).toContainText("场地端 1");
    await page.getByRole("button", { name: "确认并记录抛币" }).click();

    await expect(page.getByRole("button", { name: "确认首局设置并开赛" })).toBeVisible();
    const state = await readAuthoritativeState(request, matchCode);
    expect(state.servingSide).toBe("B");
    expect(state.physicalEnds).toEqual({ A: "END_2", B: "END_1" });
    expect(state.coinToss).toEqual({
      winnerSide: "A",
      winnerChoice: { kind: "SERVICE", decision: "RECEIVE" },
      loserChoice: { kind: "END", end: "END_1" },
    });
  });

  test("RV3-002 B 方胜并选场地端后，A 方可以自行选择先发或先接", async ({ page }) => {
    const matchCode = "MS-DEMO-001";
    const request = page.context().request;
    await openWithControl(page, matchCode);

    await page.locator('input[name="coin-toss-winner"][value="B"]').check();
    await page.locator('input[name="coin-toss-category"][value="END"]').check();
    await page.locator('input[name="coin-toss-end"][value="END_1"]').check();
    await page.locator('input[name="coin-toss-service"][value="SERVE"]').check();
    await page.getByRole("button", { name: "确认并记录抛币" }).click();

    await expect(page.getByRole("button", { name: "确认首局设置并开赛" })).toBeVisible();
    const state = await readAuthoritativeState(request, matchCode);
    expect(state.servingSide).toBe("A");
    expect(state.physicalEnds).toEqual({ A: "END_2", B: "END_1" });
    expect(state.coinToss).toEqual({
      winnerSide: "B",
      winnerChoice: { kind: "END", end: "END_1" },
      loserChoice: { kind: "SERVICE", decision: "SERVE" },
    });
    // 场地端来自抛币，画面左半场必须是真的 END_1 一方。
    await expect(page.locator('[data-testid="badminton-court"] [data-physical-end="END_1"]')).toHaveAttribute("data-side", "B");
  });

  test("RV3-004 局末误点可以在结束待提交状态直接撤销", async ({ page }) => {
    const matchCode = "MS-DEMO-001";
    const request = page.context().request;
    await openWithControl(page, matchCode);
    await page.locator('input[name="coin-toss-winner"][value="A"]').check();
    await page.locator('input[name="coin-toss-category"][value="SERVICE"]').check();
    await page.locator('input[name="coin-toss-service"][value="SERVE"]').check();
    await page.locator('input[name="coin-toss-end"][value="END_2"]').check();
    await page.getByRole("button", { name: "确认并记录抛币" }).click();
    await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("0");

    // 用服务端命令把比分推到 20:19，浏览器只负责最后那一分与撤销。
    const control = await readBrowserControl(page, matchCode);
    let state = await readAuthoritativeState(request, matchCode);
    const servingSide = state.servingSide!;
    const receivingSide = servingSide === "A" ? "B" : "A";
    state = await sendCommand(request, matchCode, control, state, "CORRECT_SCORE_STATE", {
      reason: "构造局末误点场景",
      replacement: {
        score: { A: 20, B: 19 }, gamesWon: state.gamesWon, completedGames: state.completedGames,
        servingSide, serverPlayerId: state.players[servingSide][0], receiverPlayerId: state.players[receivingSide][0],
        logicalCourts: state.logicalCourts, pendingObligations: [], phase: "IN_PROGRESS",
      },
    });
    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("20");

    await page.getByRole("button", { name: "模拟选手 01 赢得一分" }).click();
    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("21");
    expect((await readAuthoritativeState(request, matchCode)).phase).toBe("GAME_COMPLETE");

    // 修复前这里的减分按钮被 activePlay 挡住，页面上没有任何撤销入口。
    const undoButton = page.getByRole("button", { name: "撤销 模拟选手 01 刚才结束本局或本场的得分" });
    await expect(undoButton).toBeEnabled();
    // 只放开真正得到结束分的一方；另一方的“−1”仍然禁用。
    await expect(page.getByRole("button", { name: "更正 模拟选手 02 的最近得分" })).toBeDisabled();
    await expect(page.getByTestId("ending-undo-entry")).toBeVisible();

    await page.getByTestId("ending-undo-entry").click();
    const dialog = page.getByRole("dialog", { name: "更正 A 方最近得分" });
    await dialog.getByLabel("必填原因").fill("局末误点，实际未得分");
    await dialog.getByRole("button", { name: "生成服务器预览" }).click();
    await expect(dialog.getByText("服务器预览")).toBeVisible();
    await dialog.getByRole("button", { name: "确认执行预览结果" }).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("20");
    const after = await readAuthoritativeState(request, matchCode);
    expect(after.phase).toBe("IN_PROGRESS");
    expect(after.score).toEqual({ A: 20, B: 19 });
    // 撤销留痕，不是删除历史。
    const undoEvents = await prisma.matchEvent.count({
      where: { match: { code: matchCode }, type: "UNDO_LAST_REVERSIBLE" },
    });
    expect(undoEvents).toBe(1);
  });
});

/**
 * 第 7 步的局部视觉收敛：只看本轮改动的两块界面（抛币表单、局末撤销入口）。
 * 输出目录是本轮独有的，不覆盖任何既有截图证据。浏览器设备模拟不等于真机验收。
 */
const SHOT_ROOT = path.join(process.cwd(), "artifacts", "review-70fff5e", "shots");
const SHOT_VIEWPORTS = [
  { key: "phone-390x844", width: 390, height: 844 },
  { key: "narrow-320x720", width: 320, height: 720 },
  { key: "tablet-820x1180", width: 820, height: 1180 },
  { key: "tablet-landscape-1180x820", width: 1180, height: 820 },
  { key: "desktop-1440x1000", width: 1440, height: 1000 },
];

test.describe.serial("RV3-002 / RV3-004 界面截图", () => {
  test.beforeEach(resetMatches);
  test.afterAll(async () => { await prisma.$disconnect(); });

  test("抛币分步表单：五个视口", async ({ page }) => {
    mkdirSync(SHOT_ROOT, { recursive: true });
    const matchCode = "MD-DEMO-002";
    await openWithControl(page, matchCode);
    await page.locator('input[name="coin-toss-winner"][value="A"]').check();
    await page.locator('input[name="coin-toss-category"][value="END"]').check();
    await page.locator('input[name="coin-toss-end"][value="END_1"]').check();
    await page.locator('input[name="coin-toss-service"][value="RECEIVE"]').check();
    await expect(page.getByTestId("coin-toss-summary")).toBeVisible();
    for (const viewport of SHOT_VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.getByTestId("coin-toss-summary")).toBeVisible();
      await page.screenshot({ fullPage: true, path: path.join(SHOT_ROOT, `coin-toss-${viewport.key}.png`) });
      // 手机与窄屏不得出现根级横向溢出。
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${viewport.key} 出现横向溢出`).toBeLessThanOrEqual(1);
    }
  });

  test("局末撤销入口：五个视口", async ({ page }) => {
    mkdirSync(SHOT_ROOT, { recursive: true });
    const matchCode = "MS-DEMO-001";
    const request = page.context().request;
    await openWithControl(page, matchCode);
    await page.locator('input[name="coin-toss-winner"][value="A"]').check();
    await page.locator('input[name="coin-toss-category"][value="SERVICE"]').check();
    await page.locator('input[name="coin-toss-service"][value="SERVE"]').check();
    await page.locator('input[name="coin-toss-end"][value="END_2"]').check();
    await page.getByRole("button", { name: "确认并记录抛币" }).click();
    await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("0");

    const control = await readBrowserControl(page, matchCode);
    let state = await readAuthoritativeState(request, matchCode);
    const servingSide = state.servingSide!;
    const receivingSide = servingSide === "A" ? "B" : "A";
    state = await sendCommand(request, matchCode, control, state, "CORRECT_SCORE_STATE", {
      reason: "截图：局末场景",
      replacement: {
        score: { A: 20, B: 19 }, gamesWon: state.gamesWon, completedGames: state.completedGames,
        servingSide, serverPlayerId: state.players[servingSide][0], receiverPlayerId: state.players[receivingSide][0],
        logicalCourts: state.logicalCourts, pendingObligations: [], phase: "IN_PROGRESS",
      },
    });
    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("20");
    await page.getByRole("button", { name: "模拟选手 01 赢得一分" }).click();
    await expect(page.locator('[data-scoreboard-side="A"] .court-score-number')).toHaveText("21");
    await expect(page.getByTestId("ending-undo-entry")).toBeVisible();

    for (const viewport of SHOT_VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.getByTestId("ending-undo-entry")).toBeVisible();
      await page.screenshot({ fullPage: true, path: path.join(SHOT_ROOT, `ending-undo-${viewport.key}.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${viewport.key} 出现横向溢出`).toBeLessThanOrEqual(1);
    }
  });
});

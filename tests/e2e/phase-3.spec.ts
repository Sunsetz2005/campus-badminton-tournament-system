import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import type { MatchState } from "../../src/domain/rules/match-engine";

type ScoringControl = {
  controlToken: string;
  sessionId: string;
  takeoverGeneration: number;
};

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

async function readAuthoritativeState(request: APIRequestContext, matchCode: string) {
  const response = await request.get(`/api/matches/${matchCode}/state`);
  expect(response.status()).toBe(200);
  return (await response.json()).state as MatchState;
}

async function readBrowserControl(page: Page, matchCode: string) {
  const raw = await page.evaluate(
    (code) => sessionStorage.getItem(`badminton-control:${code}`),
    matchCode,
  );
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as ScoringControl;
}

async function sendCommand(
  request: APIRequestContext,
  matchCode: string,
  control: ScoringControl,
  state: MatchState,
  type: string,
  payload: unknown,
) {
  const response = await request.post(`/api/matches/${matchCode}/commands`, {
    headers: { Authorization: `Bearer ${control.controlToken}` },
    data: {
      commandId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      expectedVersion: state.version,
      scoringSessionId: control.sessionId,
      takeoverGeneration: control.takeoverGeneration,
      type,
      payload,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).state as MatchState;
}

function courtHalf(page: Page, physicalEnd: "END_1" | "END_2") {
  return page.locator(`[data-testid="badminton-court"] [data-physical-end="${physicalEnd}"]`);
}

function courtCell(page: Page, physicalEnd: "END_1" | "END_2", row: "TOP" | "BOTTOM") {
  return courtHalf(page, physicalEnd).locator(`[data-screen-row="${row}"]`);
}

async function runFullMatch(request: APIRequestContext, matchCode: string, deviceSessionId: string) {
  let view = await (await request.get(`/api/matches/${matchCode}/state`)).json();
  const controlResponse = await request.post(`/api/matches/${matchCode}/control`, { data: { deviceSessionId } });
  expect(controlResponse.status()).toBe(201);
  const control = await controlResponse.json();
  let state = view.state as MatchState;
  const send = async (type: string, payload: unknown) => {
    const response = await request.post(`/api/matches/${matchCode}/commands`, {
      headers: { Authorization: `Bearer ${control.controlToken}` },
      data: {
        commandId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        expectedVersion: state.version,
        scoringSessionId: control.sessionId,
        takeoverGeneration: control.takeoverGeneration,
        type,
        payload,
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = await response.json();
    state = body.state;
    return body;
  };

  await send("RECORD_COIN_TOSS", {
    valid: true,
    winnerSide: "A",
    winnerChoice: { kind: "SERVICE", decision: "SERVE" },
    loserChoice: { kind: "END", end: "END_2" },
  });
  const courts = state.format === "DOUBLES" ? {
    A: { R: state.players.A[0], L: state.players.A[1] },
    B: { R: state.players.B[0], L: state.players.B[1] },
  } : null;
  await send("CONFIRM_OPENING_SETUP", {
    serverPlayerId: state.players.A[0], receiverPlayerId: state.players.B[0], logicalCourts: courts,
  });

  for (let game = 1; game <= 2; game += 1) {
    const servingSide = state.servingSide!;
    const receivingSide = servingSide === "A" ? "B" : "A";
    await send("CORRECT_SCORE_STATE", {
      reason: `HTTP 全场验收第 ${game} 局赛点`,
      replacement: {
        score: { A: 20, B: 0 },
        gamesWon: state.gamesWon,
        completedGames: state.completedGames,
        servingSide,
        serverPlayerId: state.format === "DOUBLES" ? state.logicalCourts![servingSide].R : state.players[servingSide][0],
        receiverPlayerId: state.format === "DOUBLES" ? state.logicalCourts![receivingSide].R : state.players[receivingSide][0],
        logicalCourts: state.logicalCourts,
        pendingObligations: [],
        phase: "IN_PROGRESS",
      },
    });
    await send("RALLY_WON", { side: "A" });
    if (game === 1) {
      while (state.pendingObligations.length) {
        const obligation = state.pendingObligations[0];
        await send(obligation.type === "INTERVAL" ? "ACKNOWLEDGE_INTERVAL" : "CONFIRM_CHANGE_ENDS", { obligationId: obligation.id });
      }
      await send("CONFIRM_NEXT_GAME_SETUP", {
        serverPlayerId: state.players.A[0], receiverPlayerId: state.players.B[0], logicalCourts: courts,
      });
    }
  }
  expect(state.phase).toBe("MATCH_COMPLETE_PENDING_SUBMISSION");
  await send("SUBMIT_RESULT", { reason: "HTTP 全场验收提交" });
  expect(state.phase).toBe("SUBMITTED");
  view = await (await request.get(`/api/matches/${matchCode}/state`)).json();
  expect(view.state).toMatchObject({ phase: "SUBMITTED", gamesWon: { A: 2, B: 0 } });
}

test.describe.serial("阶段 3 真实 HTTP 与裁判工作台", () => {
  test.beforeEach(resetMatches);
  test.afterEach(resetMatches);

  test("单打和双打均通过真实 HTTP 完成并刷新一致", async ({ page }) => {
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await runFullMatch(page.context().request, "MS-DEMO-001", "41111111-1111-4111-8111-111111111111");
    await runFullMatch(page.context().request, "MD-DEMO-002", "42222222-2222-4222-8222-222222222222");
  });

  test("裁判工作台区分初次失败、权限拒绝和有旧数据时的过期状态", async ({ page }) => {
    const matchCode = "MS-DEMO-001";
    const statePattern = `**/api/matches/${matchCode}/state*`;
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);

    await page.route(statePattern, async (route) => {
      await route.fulfill({
        body: JSON.stringify({ error: { code: "simulated_failure", message: "模拟服务器读取失败。" } }),
        contentType: "application/json",
        status: 500,
      });
    });
    await page.goto(`/officiating/${matchCode}`);
    await expect(page.getByRole("heading", { name: "暂时无法读取权威状态" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新读取" })).toBeVisible();
    await expect(page.getByText("正在读取比赛状态")).toBeHidden();

    await page.unroute(statePattern);
    await page.getByRole("button", { name: "重新读取" }).click();
    await expect(page.getByTestId("badminton-court")).toBeVisible();

    await page.route(statePattern, async (route) => {
      await route.fulfill({
        body: JSON.stringify({ error: { code: "simulated_refresh_failure", message: "模拟后台刷新失败。" } }),
        contentType: "application/json",
        status: 500,
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
    await expect(page.locator('.scoring-alert[role="alert"]')).toContainText("模拟后台刷新失败");
    await expect(page.getByTestId("badminton-court")).toBeVisible();
    await expect(page.locator(".status-facts")).toContainText("数据可能过期");

    await page.unroute(statePattern);
    await page.route(statePattern, async (route) => {
      await route.fulfill({
        body: JSON.stringify({ error: { code: "forbidden", message: "当前账号不能读取该场比赛。" } }),
        contentType: "application/json",
        status: 403,
      });
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "无法进入该场执裁" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新读取" })).toHaveCount(0);
  });

  test("工作台响应超时后锁定最后确认状态并用原 commandId 恢复", async ({ page }) => {
    const matchCode = "MS-DEMO-001";
    const request = page.context().request;
    const pendingKey = `badminton-pending:${matchCode}`;
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await page.goto(`/officiating/${matchCode}`);
    await page.getByRole("button", { name: "取得本机控制权" }).click();
    await page.getByRole("button", { name: "A 方胜并选先发" }).click();
    await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("0");

    const stableSnapshot = await (await request.get(`/api/matches/${matchCode}/state`)).json();
    let holdUnknownState = true;
    await page.route(`**/api/matches/${matchCode}/state*`, async (route) => {
      if (!holdUnknownState) return route.continue();
      await route.fulfill({
        body: JSON.stringify(stableSnapshot),
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        status: 200,
      });
    });
    await page.route(`**/api/matches/${matchCode}/commands/*`, async (route) => {
      if (!holdUnknownState) return route.continue();
      await route.fulfill({
        body: JSON.stringify({ error: { code: "command_not_found", message: "故障注入期间暂不返回命令结果。" } }),
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        status: 404,
      });
    });
    await page.route(`**/api/matches/${matchCode}/commands`, async (route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          "x-test-response-delay-ms": "6500",
        },
      });
    });

    const addPoint = page.getByRole("button", { name: "模拟选手 01 赢得一分" });
    await addPoint.click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), pendingKey)).not.toBeNull();
    const pendingEnvelope = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      pendingKey,
    ) as { commandId: string; type: string; payload: unknown };
    expect(pendingEnvelope.type).toBe("RALLY_WON");
    expect(pendingEnvelope.payload).toEqual({ side: "A" });
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("0");
    await expect(addPoint).toBeDisabled();

    const recovery = page.locator(".pending-recovery");
    await expect(recovery).toBeVisible({ timeout: 8_000 });
    await expect(recovery).toContainText("比分、站位和发接发保持最后一次已确认状态");
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("0");
    await expect(page.locator(".score-adjust.plus").first()).toBeDisabled();
    await expect(page.locator(".score-adjust.plus").last()).toBeDisabled();
    await expect(page.evaluate((key) => localStorage.getItem(key), pendingKey)).resolves.not.toBeNull();
    await expect.poll(() => prisma.matchEvent.count({
      where: { match: { code: matchCode }, commandId: pendingEnvelope.commandId },
    })).toBe(1);

    holdUnknownState = false;
    await recovery.getByRole("button", { name: "查询原命令结果" }).click();
    await expect(recovery).toBeHidden();
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("1");
    await expect(page.evaluate((key) => localStorage.getItem(key), pendingKey)).resolves.toBeNull();
    await expect.poll(() => prisma.matchEvent.count({
      where: { match: { code: matchCode }, commandId: pendingEnvelope.commandId },
    })).toBe(1);
  });

  test("单打四格、减分预览与本机翻转均遵守权威状态边界", async ({ page }) => {
    const matchCode = "MS-DEMO-001";
    const request = page.context().request;
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await page.goto(`/officiating/${matchCode}`);
    await page.getByRole("button", { name: "取得本机控制权" }).click();
    await page.getByRole("button", { name: "A 方胜并选先发" }).click();
    await expect(page.getByRole("button", { name: "确认首局设置并开赛" })).toBeVisible();

    const setupState = await readAuthoritativeState(request, matchCode);
    const playerA = setupState.players.A[0];
    const playerB = setupState.players.B[0];
    const court = page.getByTestId("badminton-court");
    await expect(court.locator("[data-screen-row]")).toHaveCount(4);
    await expect(court).toHaveAttribute("data-flipped", "false");
    await expect(courtHalf(page, "END_1")).toHaveAttribute("data-side", "A");
    await expect(courtHalf(page, "END_2")).toHaveAttribute("data-side", "B");
    await expect(courtCell(page, "END_1", "TOP")).toHaveAttribute("data-logical-court", "L");
    await expect(courtCell(page, "END_1", "TOP")).toHaveAttribute("data-player-id", "");
    await expect(courtCell(page, "END_1", "BOTTOM")).toHaveAttribute("data-logical-court", "R");
    await expect(courtCell(page, "END_1", "BOTTOM")).toHaveAttribute("data-player-id", playerA);
    await expect(courtCell(page, "END_1", "BOTTOM")).toHaveAttribute("data-role", "");
    await expect(courtCell(page, "END_1", "BOTTOM")).toContainText("拟首发");
    await expect(courtCell(page, "END_2", "TOP")).toHaveAttribute("data-logical-court", "R");
    await expect(courtCell(page, "END_2", "TOP")).toHaveAttribute("data-player-id", playerB);
    await expect(courtCell(page, "END_2", "TOP")).toHaveAttribute("data-role", "");
    await expect(courtCell(page, "END_2", "TOP")).toContainText("拟首接");
    await expect(courtCell(page, "END_2", "BOTTOM")).toHaveAttribute("data-logical-court", "L");
    await expect(courtCell(page, "END_2", "BOTTOM")).toHaveAttribute("data-player-id", "");
    await expect(court.locator('[data-role="SERVER"]')).toHaveCount(0);
    await expect(court.locator('[data-role="RECEIVER"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "模拟选手 01 赢得一分" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "核对单打站位" }).first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "核对单打站位" }).last()).toBeDisabled();
    await expect(page.getByRole("button", { name: "更正场地端" })).toBeDisabled();

    await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    const addPoint = page.getByRole("button", { name: "模拟选手 01 赢得一分" });
    await expect(addPoint).toBeEnabled();
    await expect(court.locator('[data-role="SERVER"]')).toHaveCount(1);
    await expect(court.locator('[data-role="RECEIVER"]')).toHaveCount(1);
    await addPoint.click();
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("1");
    await expect(courtCell(page, "END_1", "TOP")).toHaveAttribute("data-player-id", playerA);
    await expect(courtCell(page, "END_1", "TOP")).toHaveAttribute("data-role", "SERVER");
    await expect(courtCell(page, "END_1", "BOTTOM")).toHaveAttribute("data-player-id", "");
    await expect(courtCell(page, "END_2", "TOP")).toHaveAttribute("data-player-id", "");
    await expect(courtCell(page, "END_2", "BOTTOM")).toHaveAttribute("data-player-id", playerB);
    await expect(courtCell(page, "END_2", "BOTTOM")).toHaveAttribute("data-role", "RECEIVER");
    await expect(court.locator('[data-role="SERVER"]')).toHaveCount(1);
    await expect(court.locator('[data-role="RECEIVER"]')).toHaveCount(1);

    const match = await prisma.match.findUniqueOrThrow({ where: { code: matchCode }, select: { id: true } });
    const versionBeforePreview = (await readAuthoritativeState(request, matchCode)).version;
    const eventsBeforePreview = await prisma.matchEvent.count({ where: { matchId: match.id } });
    await page.getByRole("button", { name: "更正 模拟选手 01 的最近得分" }).click();
    const undoDialog = page.getByRole("dialog", { name: "更正 A 方最近得分" });
    await expect(undoDialog).toContainText("不会直接改分");
    await undoDialog.getByLabel("必填原因").fill("误触减分安全探针");
    await undoDialog.getByRole("button", { name: "生成服务器预览" }).click();
    await expect(undoDialog.getByText("服务器预览")).toBeVisible();
    expect((await readAuthoritativeState(request, matchCode)).version).toBe(versionBeforePreview);
    await expect(prisma.matchEvent.count({ where: { matchId: match.id } })).resolves.toBe(eventsBeforePreview);
    await undoDialog.getByRole("button", { name: "取消" }).click();
    await expect(undoDialog).toBeHidden();
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("1");
    expect((await readAuthoritativeState(request, matchCode)).version).toBe(versionBeforePreview);

    await page.getByRole("button", { name: "翻转本机视角" }).click();
    await expect(court).toHaveAttribute("data-flipped", "true");
    await expect(court.locator(".court-visual-half").first()).toHaveAttribute("data-physical-end", "END_2");
    await expect(court.locator(".court-visual-half").last()).toHaveAttribute("data-physical-end", "END_1");
    expect((await readAuthoritativeState(request, matchCode)).version).toBe(versionBeforePreview);
  });

  test("双打可选择非名单第一人并由权威状态自动换位和换边", async ({ page }) => {
    const matchCode = "MD-DEMO-002";
    const request = page.context().request;
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await page.goto(`/officiating/${matchCode}`);
    await page.getByRole("button", { name: "取得本机控制权" }).click();
    await page.getByRole("button", { name: "A 方胜并选先发" }).click();
    await expect(page.getByRole("button", { name: "确认首局设置并开赛" })).toBeVisible();

    const setupState = await readAuthoritativeState(request, matchCode);
    const [firstA, selectedServer] = setupState.players.A;
    const [firstB, selectedReceiver] = setupState.players.B;
    await page.getByLabel("首发球员（A 方）").selectOption(selectedServer);
    await page.getByLabel("首接球员（B 方）").selectOption(selectedReceiver);
    await expect(page.locator(`[data-player-id="${selectedServer}"]`)).toHaveAttribute("data-role", "");
    await expect(page.locator(`[data-player-id="${selectedServer}"]`)).toContainText("拟首发");
    await expect(page.locator(`[data-player-id="${selectedReceiver}"]`)).toHaveAttribute("data-role", "");
    await expect(page.locator(`[data-player-id="${selectedReceiver}"]`)).toContainText("拟首接");
    await expect(page.getByTestId("badminton-court").locator('[data-role="SERVER"]')).toHaveCount(0);
    await expect(page.getByTestId("badminton-court").locator('[data-role="RECEIVER"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "模拟组合 03/04 赢得一分" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "更正 A 方换位" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "更正 B 方换位" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "更正场地端" })).toBeDisabled();
    await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    await expect(page.getByRole("button", { name: "模拟组合 03/04 赢得一分" })).toBeEnabled();
    await expect(page.getByTestId("badminton-court").locator('[data-role="SERVER"]')).toHaveCount(1);
    await expect(page.getByTestId("badminton-court").locator('[data-role="RECEIVER"]')).toHaveCount(1);

    await page.reload();
    await expect(page.getByRole("button", { name: "模拟组合 03/04 赢得一分" })).toBeEnabled();
    let state = await readAuthoritativeState(request, matchCode);
    expect(state.serverPlayerId).toBe(selectedServer);
    expect(state.receiverPlayerId).toBe(selectedReceiver);
    expect(state.logicalCourts).toEqual({
      A: { R: selectedServer, L: firstA },
      B: { R: selectedReceiver, L: firstB },
    });
    await expect(page.locator(`[data-player-id="${selectedServer}"]`)).toHaveAttribute("data-logical-court", "R");
    await expect(page.locator(`[data-player-id="${selectedServer}"]`)).toHaveAttribute("data-role", "SERVER");
    await expect(page.locator(`[data-player-id="${selectedReceiver}"]`)).toHaveAttribute("data-logical-court", "R");
    await expect(page.locator(`[data-player-id="${selectedReceiver}"]`)).toHaveAttribute("data-role", "RECEIVER");

    await page.getByRole("button", { name: "模拟组合 03/04 赢得一分" }).click();
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("1");
    state = await readAuthoritativeState(request, matchCode);
    expect(state.logicalCourts).toEqual({
      A: { R: firstA, L: selectedServer },
      B: { R: selectedReceiver, L: firstB },
    });
    expect(state.serverPlayerId).toBe(selectedServer);
    expect(state.receiverPlayerId).toBe(firstB);
    await expect(page.locator(`[data-player-id="${selectedServer}"]`)).toHaveAttribute("data-logical-court", "L");
    await expect(page.locator(`[data-player-id="${selectedServer}"]`)).toHaveAttribute("data-role", "SERVER");
    await expect(page.locator(`[data-player-id="${firstB}"]`)).toHaveAttribute("data-logical-court", "L");
    await expect(page.locator(`[data-player-id="${firstB}"]`)).toHaveAttribute("data-role", "RECEIVER");
    await expect(page.getByTestId("badminton-court").locator('[data-role="SERVER"]')).toHaveCount(1);
    await expect(page.getByTestId("badminton-court").locator('[data-role="RECEIVER"]')).toHaveCount(1);

    const control = await readBrowserControl(page, matchCode);
    state = await sendCommand(request, matchCode, control, state, "CORRECT_SCORE_STATE", {
      reason: "换边比分面板探针",
      replacement: {
        score: { A: 20, B: 0 },
        gamesWon: state.gamesWon,
        completedGames: state.completedGames,
        servingSide: "A",
        serverPlayerId: state.logicalCourts!.A.R,
        receiverPlayerId: state.logicalCourts!.B.R,
        logicalCourts: state.logicalCourts,
        pendingObligations: [],
        phase: "IN_PROGRESS",
      },
    });
    state = await sendCommand(request, matchCode, control, state, "RALLY_WON", { side: "A" });
    expect(state.pendingObligations.some((item) => item.type === "CHANGE_ENDS")).toBe(true);
    expect(state.score).toEqual({ A: 21, B: 0 });
    await page.reload();
    await expect(page.locator("[data-score-side]").first()).toHaveAttribute("data-score-side", "A");
    await expect(page.locator("[data-score-side]").first().locator(".court-score-number")).toHaveText("21");

    await page.getByRole("button", { name: "确认 / 核对换边" }).click();
    const endsDialog = page.getByRole("dialog", { name: "核对并更正物理场地端" });
    await endsDialog.getByRole("button", { name: "生成服务器预览" }).click();
    await expect(endsDialog.getByText("物理端 A END_1 → END_2")).toBeVisible();
    await endsDialog.getByRole("button", { name: "确认执行预览结果" }).click();
    await expect(endsDialog).toBeHidden();

    state = await readAuthoritativeState(request, matchCode);
    expect(state.physicalEnds).toEqual({ A: "END_2", B: "END_1" });
    expect(state.score).toEqual({ A: 21, B: 0 });
    await expect(page.locator("[data-score-side]").first()).toHaveAttribute("data-score-side", "B");
    await expect(page.locator("[data-score-side]").first().locator(".court-score-number")).toHaveText("0");
    await expect(page.locator("[data-score-side]").last()).toHaveAttribute("data-score-side", "A");
    await expect(page.locator("[data-score-side]").last().locator(".court-score-number")).toHaveText("21");
  });

  test("Chromium 浏览器设备模拟：单打与双打的平板控制端和手机只读端展示同一权威状态", async ({ page }, testInfo) => {
    testInfo.annotations.push({
      type: "acceptance-boundary",
      description: "本用例生成的四张截图均为 Chromium 浏览器设备模拟，不是真机验收证据。",
    });
    const artifactDir = path.join(process.cwd(), "artifacts", "phase3-browser-simulated");
    mkdirSync(artifactDir, { recursive: true });

    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await page.goto("/officiating/MS-DEMO-001");
    await page.getByRole("button", { name: "取得本机控制权" }).click();
    await page.getByRole("button", { name: "A 方胜并选先发" }).click();
    await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    await page.getByRole("button", { name: "模拟选手 01 赢得一分" }).click();
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("1");

    await page.getByRole("button", { name: "更正 模拟选手 01 的最近得分" }).click();
    const screenshotDialog = page.getByRole("dialog", { name: "更正 A 方最近得分" });
    await expect(screenshotDialog).toBeVisible();
    await page.getByLabel("关闭").click();
    await expect(screenshotDialog).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.screenshot({
      path: path.join(artifactDir, "singles-tablet-landscape-1024x768-chromium.png"),
    });
    await page.screenshot({
      path: path.join(artifactDir, "tablet-1024x768.png"),
    });

    const singlesPhone = await page.context().newPage();
    await singlesPhone.setViewportSize({ width: 390, height: 844 });
    await singlesPhone.goto("/officiating/MS-DEMO-001");
    await expect(singlesPhone.locator('[data-score-side="A"] .court-score-number')).toHaveText("1");
    await expect(singlesPhone.getByRole("button", { name: "模拟选手 01 赢得一分" })).toBeDisabled();
    await singlesPhone.screenshot({
      path: path.join(artifactDir, "singles-phone-portrait-390x844-chromium.png"),
    });
    await singlesPhone.screenshot({
      path: path.join(artifactDir, "mobile-390x844.png"),
    });

    const versionBeforeOffline = (await (await page.context().request.get("/api/matches/MS-DEMO-001/state")).json()).version;
    await page.context().setOffline(true);
    await expect(page.getByRole("button", { name: "模拟选手 01 赢得一分" })).toBeDisabled();
    await page.context().setOffline(false);
    await page.setViewportSize({ width: 768, height: 1024 });
    const versionAfterRotation = (await (await page.context().request.get("/api/matches/MS-DEMO-001/state")).json()).version;
    expect(versionAfterRotation).toBe(versionBeforeOffline);
    await singlesPhone.close();

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/officiating/MD-DEMO-002");
    await page.getByRole("button", { name: "取得本机控制权" }).click();
    await page.getByRole("button", { name: "A 方胜并选先发" }).click();
    await page.getByLabel("首发球员（A 方）").selectOption({ index: 1 });
    await page.getByLabel("首接球员（B 方）").selectOption({ index: 1 });
    await page.getByRole("button", { name: "确认首局设置并开赛" }).click();
    await page.getByRole("button", { name: "模拟组合 03/04 赢得一分" }).click();
    await expect(page.locator('[data-score-side="A"] .court-score-number')).toHaveText("1");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(artifactDir, "doubles-tablet-landscape-1024x768-chromium.png"),
    });

    const doublesPhone = await page.context().newPage();
    await doublesPhone.setViewportSize({ width: 390, height: 844 });
    await doublesPhone.goto("/officiating/MD-DEMO-002");
    await expect(doublesPhone.locator('[data-score-side="A"] .court-score-number')).toHaveText("1");
    await expect(doublesPhone.getByRole("button", { name: "模拟组合 03/04 赢得一分" })).toBeDisabled();
    await doublesPhone.screenshot({
      path: path.join(artifactDir, "doubles-phone-portrait-390x844-chromium.png"),
    });
    await doublesPhone.close();
  });
});

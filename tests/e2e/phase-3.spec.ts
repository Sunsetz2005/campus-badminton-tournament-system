import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import type { MatchState } from "../../src/domain/rules/match-engine";

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

  test("响应超时后使用原 commandId 查回已提交结果", async ({ page }) => {
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    const request = page.context().request;
    const state = await (await request.get("/api/matches/MS-DEMO-001/state")).json();
    const control = await (await request.post("/api/matches/MS-DEMO-001/control", {
      data: { deviceSessionId: "43333333-3333-4333-8333-333333333333" },
    })).json();
    const commandId = crypto.randomUUID();
    const outcome = await page.evaluate(async ({ control, commandId, version }) => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 100);
      try {
        await fetch("/api/matches/MS-DEMO-001/commands", {
          method: "POST",
          signal: abort.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${control.controlToken}`,
            "X-Test-Response-Delay-Ms": "800",
          },
          body: JSON.stringify({
            commandId,
            occurredAt: new Date().toISOString(),
            expectedVersion: version,
            scoringSessionId: control.sessionId,
            takeoverGeneration: control.takeoverGeneration,
            type: "RECORD_COIN_TOSS",
            payload: { valid: false, reason: "故障注入测试" },
          }),
        });
        return "responded";
      } catch {
        return "unknown";
      }
    }, { control, commandId, version: state.version });
    expect(outcome).toBe("unknown");
    await page.waitForTimeout(900);
    const recovered = await request.get(`/api/matches/MS-DEMO-001/commands/${commandId}`);
    expect(recovered.status()).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({ status: "accepted", version: 1 });
    await expect(prisma.matchEvent.count({ where: { match: { code: "MS-DEMO-001" }, commandId } })).resolves.toBe(1);
  });

  test("平板控制端与手机只读端展示同一权威比分", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await page.goto("/officiating/MS-DEMO-001");
    await page.getByRole("button", { name: "取得本机控制权" }).click();
    await page.getByRole("button", { name: "A 方胜并选先发" }).click();
    await page.getByRole("button", { name: "确认首局发接发并开赛" }).click();
    await page.getByRole("button", { name: /模拟选手 01 \+1/ }).click();
    await expect(page.locator(".side-a .score-number")).toHaveText("1");

    await page.getByRole("button", { name: "撤销 / 更正" }).click();
    await expect(page.getByRole("dialog", { name: "撤销与更正" })).toBeVisible();
    await page.getByLabel("关闭").click();

    const artifactDir = path.join(process.cwd(), "artifacts", "phase3-browser-simulated");
    mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, "tablet-1024x768.png"), fullPage: true });

    const phone = await page.context().newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto("/officiating/MS-DEMO-001");
    await expect(phone.locator(".side-a .score-number")).toHaveText("1");
    await expect(phone.getByRole("button", { name: /模拟选手 01 \+1/ })).toBeDisabled();
    await phone.screenshot({ path: path.join(artifactDir, "mobile-390x844.png"), fullPage: true });

    const versionBeforeOffline = (await (await page.context().request.get("/api/matches/MS-DEMO-001/state")).json()).version;
    await page.context().setOffline(true);
    await expect(page.getByRole("button", { name: /模拟选手 01 \+1/ })).toBeDisabled();
    await page.context().setOffline(false);
    await page.setViewportSize({ width: 768, height: 1024 });
    const versionAfterRotation = (await (await page.context().request.get("/api/matches/MS-DEMO-001/state")).json()).version;
    expect(versionAfterRotation).toBe(versionBeforeOffline);
  });
});

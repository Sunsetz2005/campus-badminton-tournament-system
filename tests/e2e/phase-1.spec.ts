import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/client";

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("登录邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

test.describe.serial("阶段 1 浏览器权限链", () => {
  async function clearControlArtifacts() {
    const match = await prisma.match.findUniqueOrThrow({ where: { code: "MS-DEMO-001" }, select: { id: true } });
    const demoEmails = [process.env.DEMO_ADMIN_EMAIL, process.env.DEMO_REFEREE_EMAIL].filter(
      (email): email is string => Boolean(email),
    );
    await prisma.scoringSession.deleteMany({ where: { matchId: match.id } });
    await prisma.auditLog.deleteMany({
      where: { action: { in: ["SCORING_SESSION_ACQUIRE", "SCORING_SESSION_ACQUIRED"] } },
    });
    await prisma.session.deleteMany({ where: { user: { email: { in: demoEmails } } } });
    await prisma.match.update({ where: { id: match.id }, data: { controlGeneration: 1 } });
  }

  test.beforeEach(clearControlArtifacts);
  test.afterEach(clearControlArtifacts);

  test("健康检查返回真实 UTC 服务端时间", async ({ request }) => {
    const before = Date.now();
    const response = await request.get("/api/health");
    const after = Date.now();
    expect(response.status()).toBe(200);
    const body = await response.json();
    const serverTime = Date.parse(body.serverTime);
    expect(Number.isNaN(serverTime)).toBe(false);
    expect(serverTime).toBeGreaterThanOrEqual(before - 5_000);
    expect(serverTime).toBeLessThanOrEqual(after + 5_000);
  });

  test("公开页和公开 API 只包含白名单字段", async ({ page, request }) => {
    await page.goto("/public");
    await expect(page.getByRole("heading", { name: "阶段 1 匿名模拟赛" })).toBeVisible();
    await expect(page.getByText("模拟选手 01")).toBeVisible();
    await page.reload();
    await expect(page.getByText("模拟选手 01")).toBeVisible();
    const response = await request.get("/api/public/tournaments/phase-1-demo");
    expect(response.ok()).toBeTruthy();
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("email");
    expect(body).not.toContain("userId");
    expect(body).not.toContain("auditLogs");
  });

  test("没有已发布赛事时公开页返回明确的 404", async ({ page }) => {
    const tournament = await prisma.tournament.findUniqueOrThrow({
      where: { slug: "phase-1-demo" },
      select: { id: true, status: true },
    });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { status: "DRAFT" } });
    try {
      const response = await page.goto("/public");
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "暂无已发布赛事" })).toBeVisible();
    } finally {
      await prisma.tournament.update({ where: { id: tournament.id }, data: { status: tournament.status } });
    }
  });

  test("未登录请求写入会话返回中文未登录错误", async ({ request }) => {
    const response = await request.post("/api/matches/MS-DEMO-001/control", {
      data: { deviceSessionId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unauthenticated", message: "请先登录后再操作。" },
    });
  });

  test("运行中的网页不开放公众注册", async ({ request }) => {
    const email = "blocked@example.test";
    await prisma.user.deleteMany({ where: { email } });
    try {
      const response = await request.post("/api/auth/sign-up/email", {
        data: { name: "禁止注册", email, password: "BlockedSignup!2026" },
      });
      expect(response.ok()).toBeFalsy();
      expect([400, 403]).toContain(response.status());
    } finally {
      await prisma.user.deleteMany({ where: { email } });
    }
  });

  test("裁判访问赛事管理返回明确的 403", async ({ page }) => {
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    const response = await page.goto("/management");
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "没有赛事管理权限" })).toBeVisible();
  });

  test("管理员登录后仍不能替代主裁判取得比赛控制权", async ({ page }) => {
    await login(page, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await expect(page.getByText("本地赛事管理员")).toBeVisible();
    const before = await prisma.scoringSession.count();
    const response = await page.context().request.post("/api/matches/MS-DEMO-001/control", {
      data: { deviceSessionId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(response.status()).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden" } });
    await expect(prisma.scoringSession.count()).resolves.toBe(before);
  });

  test("裁判只能取得本人指派单打比赛的控制权", async ({ page }) => {
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await page.goto("/officiating");
    await expect(page.getByText("MS-DEMO-001")).toBeVisible();
    await expect(page.getByText("MD-DEMO-001")).not.toBeVisible();

    const before = await prisma.scoringSession.count();
    const wrongMatch = await page.context().request.post("/api/matches/MD-DEMO-001/control", {
      data: { deviceSessionId: "55555555-5555-4555-8555-555555555555" },
    });
    expect(wrongMatch.status()).toBe(403);
    await expect(wrongMatch.json()).resolves.toMatchObject({ error: { code: "not_assigned" } });
    await expect(prisma.scoringSession.count()).resolves.toBe(before);

    const assignedMatch = await page.context().request.post("/api/matches/MS-DEMO-001/control", {
      data: { deviceSessionId: "66666666-6666-4666-8666-666666666666" },
    });
    expect(assignedMatch.status()).toBe(201);
    await expect(assignedMatch.json()).resolves.toMatchObject({ status: "acquired", takeoverGeneration: 1 });
  });
});

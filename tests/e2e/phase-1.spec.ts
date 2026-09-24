import { expect, test } from "@playwright/test";

import { prisma } from "../../src/db/client";

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("登录邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

const publicNotFoundHeading = "赛事或比赛不存在，或尚未公开";

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

  test("公开赛程页和公开 API 只包含白名单字段", async ({ page, request }) => {
    await page.goto("/public/phase-1-demo/schedule?date=2026-09-21");
    await expect(page.getByRole("heading", { name: "每日赛程" })).toBeVisible();
    await expect(page.getByText("模拟选手 01").first()).toBeVisible();
    await page.reload();
    await expect(page.getByText("模拟选手 01").first()).toBeVisible();

    for (const path of [
      "/api/public/tournaments",
      "/api/public/tournaments/phase-1-demo",
      "/api/public/tournaments/phase-1-demo/schedule",
      "/api/public/tournaments/phase-1-demo/matches/MS-DONE-001",
    ]) {
      const response = await request.get(path);
      expect(response.ok(), path).toBeTruthy();
      const body = JSON.stringify(await response.json());
      for (const forbidden of ["email", "userId", "auditLogs", "namePolicy", "tokenHash", "serverPlayerId", "reason"]) {
        expect(body, `${path} 泄露了 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("旧的公开查询入口重定向到赛事列表首页", async ({ page }) => {
    await page.goto("/public");
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { level: 1, name: "羽赛台" })).toBeVisible();
  });

  test("首页按生命周期分组列出已发布赛事", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "进行中", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /阶段 1 匿名模拟赛/ })).toBeVisible();
    // 未登录访客看不到管理与执裁入口；服务端门禁另有断言，隐藏链接本身不是授权。
    const nav = page.getByRole("navigation", { name: "主导航" });
    await expect(nav.getByRole("link", { name: "赛事管理" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "我的执裁" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "设置" })).toHaveCount(0);
  });

  test("比赛看板展示人工直采的四类状态和已完成局分", async ({ page }) => {
    await page.goto("/public/phase-1-demo/board");
    await expect(page.getByRole("heading", { name: "现场看板" })).toBeVisible();

    const upcoming = page.locator('[data-board-group="UPCOMING"]');
    await expect(upcoming.getByText("MS-FRESH-001")).toBeVisible();
    await expect(upcoming.getByText("MD-FRESH-001")).toBeVisible();
    await expect(upcoming.getByText("全新 0:0").first()).toBeVisible();

    const action = page.locator('[data-board-group="ACTION"]');
    await expect(action.getByText("MS-REVIEW-001")).toBeVisible();
    await expect(action.getByText("MD-END-001")).toBeVisible();
    await expect(action.getByText("待复核")).toBeVisible();
    await expect(action.getByText("待提交")).toBeVisible();

    const done = page.locator('[data-board-group="DONE"]');
    await expect(done.getByText("MS-DONE-001")).toBeVisible();
    await expect(done.getByLabel("MS-DONE-001 局分")).toHaveText("21:14 · 21:17");
    await expect(done.getByText("MD-DONE-002")).toBeVisible();
    await expect(done.getByLabel("MD-DONE-002 局分")).toHaveText("RET");
  });

  test("草稿赛事和未知比赛一律返回公开 404", async ({ page }) => {
    // 未知赛事、未知比赛和草稿赛事必须收敛到同一个公开 404 文案，
    // 区分文案会泄露「内容存在但不可见」。
    expect((await page.goto("/public/no-such-tournament/schedule"))?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: publicNotFoundHeading })).toBeVisible();
    expect((await page.goto("/public/phase-1-demo/matches/NO-SUCH-MATCH"))?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: publicNotFoundHeading })).toBeVisible();

    const tournament = await prisma.tournament.findUniqueOrThrow({
      where: { slug: "phase-1-demo" },
      select: { id: true, status: true },
    });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { status: "DRAFT" } });
    try {
      // 赛事一旦退回草稿，它的赛程和比赛详情都必须立刻变成公开 404。
      expect((await page.goto("/public/phase-1-demo/schedule"))?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: publicNotFoundHeading })).toBeVisible();
      expect((await page.goto("/public/phase-1-demo/matches/MS-DONE-001"))?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: publicNotFoundHeading })).toBeVisible();

      await page.goto("/");
      await expect(page.getByRole("link", { name: /阶段 1 匿名模拟赛/ })).toHaveCount(0);
    } finally {
      await prisma.tournament.update({ where: { id: tournament.id }, data: { status: tournament.status } });
    }
  });

  test("未发布的比赛不进入公开赛程", async ({ page, request }) => {
    const match = await prisma.match.findUniqueOrThrow({
      where: { code: "MS-DONE-001" },
      select: { id: true, publishedAt: true },
    });
    await prisma.match.update({ where: { id: match.id }, data: { publishedAt: null } });
    try {
      expect((await page.goto("/public/phase-1-demo/matches/MS-DONE-001"))?.status()).toBe(404);
      const schedule = await request.get("/api/public/tournaments/phase-1-demo/schedule");
      expect(JSON.stringify(await schedule.json())).not.toContain("MS-DONE-001");
    } finally {
      await prisma.match.update({ where: { id: match.id }, data: { publishedAt: match.publishedAt } });
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

  test("未登录直连受保护页面仍被服务端拒绝，隐藏导航不是授权", async ({ page, request }) => {
    // 导航里看不到这些入口，但真正的门禁在服务端；直连必须仍然被拒。
    for (const path of ["/management", "/officiating", "/settings"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(new RegExp(`^.*/login\\?next=${path.replace("/", "\\/")}`));
    }
    const upload = await request.post("/api/admin/tournaments/phase-1-demo/poster", {
      multipart: { poster: { name: "x.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) } },
    });
    expect(upload.status()).toBe(401);
  });

  test("裁判访问赛事管理返回明确的 403", async ({ page }) => {
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);

    // 裁判的导航里没有「赛事管理」……
    const nav = page.getByRole("navigation", { name: "主导航" });
    await expect(nav.getByRole("link", { name: "我的执裁" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "赛事管理" })).toHaveCount(0);

    // ……但即使知道地址，服务端仍然拒绝。
    const response = await page.goto("/management");
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "没有赛事管理权限" })).toBeVisible();
  });

  test("裁判的全新 0:0 比赛优先展示且可进入执裁", async ({ page }) => {
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await page.goto("/officiating");
    const freshMatch = page.locator("article.card").filter({ hasText: "MS-FRESH-001" });
    await expect(freshMatch.getByText("全新 · 0:0")).toBeVisible();
    await expect(freshMatch.getByRole("link", { name: "进入执裁" })).toBeVisible();
    await expect(page.locator("article.card").first()).toContainText("MS-FRESH-001");
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

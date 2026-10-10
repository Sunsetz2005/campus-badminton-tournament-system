import { randomBytes } from "node:crypto";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

/**
 * 共用裁判账号：管理员在赛事概览开通裁判员账号，全体裁判用同一个用户名登录，
 * 「我的执裁」列出本赛事全部可开始的比赛，不需要逐场指派；同一场只能由一台设备控制。
 */
const RUN = randomBytes(3).toString("hex");
const slug = `e2e-shref-${RUN}`;
const api = `/api/admin/tournaments/${slug}`;
const refereeUsername = `court_${RUN}`;
// 仅用于本机隔离测试库的测试口令，每次运行随机生成。
const refereePassword = `T${randomBytes(9).toString("base64url")}`;

async function login(page: Page, account: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("账号", { exact: false }).fill(account);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function loggedIn(browser: Browser, account: string, password: string, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await login(page, account, password);
  return { context, page };
}

async function ok<T = unknown>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  if (!response.ok()) throw new Error(`${response.url()} → ${response.status()} ${await response.text()}`);
  return (await response.json()) as T;
}

test.describe.serial("共用裁判账号：开通、登录、任意一场开赛", () => {
  test.describe.configure({ timeout: 120_000 });
  test.beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  });

  test.afterAll(async () => {
    await prisma.session.deleteMany({ where: { user: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } } });
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) return;
    const matchWhere = { stage: { competition: { tournamentId: tournament.id } } };
    await prisma.matchEvent.deleteMany({ where: { match: matchWhere } });
    await prisma.resultRevision.deleteMany({ where: { match: matchWhere } });
    await prisma.scoringSession.deleteMany({ where: { match: matchWhere } });
    await prisma.match.deleteMany({ where: matchWhere });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.user.deleteMany({ where: { provisionedForTournamentId: tournament.id } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  });

  test("管理员开通共用裁判账号；裁判用用户名登录后看到全部比赛并直接开赛，第二台设备同场只读", async ({ browser }) => {
    const admin = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    const request = admin.page.request;
    await ok(
      await request.post("/api/admin/tournaments", {
        data: {
          slug,
          name: "共用裁判账号端到端",
          startDate: "2026-11-07",
          endDate: "2026-11-07",
          timezone: "Asia/Shanghai",
          namePolicy: "DISPLAY_NAMES",
          refereeMode: "SHARED_ACCOUNT",
          rulePreset: "traditional-21",
          competitions: [{ kind: "MS", code: "MS", name: "男子单打" }],
        },
      }),
    );
    await ok(await request.post(`${api}/phase`, { data: { to: "REGISTRATION_OPEN" } }));
    const competition = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug } }, select: { id: true } });
    for (const name of ["甲", "乙", "丙", "丁"]) {
      const created = await ok<{ referenceCode: string }>(await request.post(`${api}/registrations`, { data: { competitionId: competition.id, members: [{ displayName: `选手${name}` }] } }));
      const registration = await prisma.registration.findUniqueOrThrow({ where: { referenceCode: created.referenceCode } });
      await ok(await request.post(`${api}/registrations/${registration.id}/review`, { data: { action: "APPROVE", expectedVersion: registration.version } }));
    }
    const draft = await ok<{ drawId: string }>(await request.post(`${api}/competitions/MS/draws`, { data: { format: "ROUND_ROBIN" } }));
    await ok(await request.post(`${api}/phase`, { data: { to: "REGISTRATION_CLOSED" } }));
    await ok(await request.post(`${api}/competitions/MS/draws/${draft.drawId}/publish`, { data: { confirm: true } }));

    // 赛事概览：执裁方式已是共用账号，还没有裁判账号时明确提示。
    await admin.page.goto(`/management/${slug}`);
    const panel = admin.page.getByTestId("referee-accounts");
    await expect(panel.getByRole("radio", { name: /共用裁判账号/ })).toBeChecked();
    await expect(panel).toContainText("还没有可用的裁判员账号");
    await panel.getByLabel("登录用户名").fill(refereeUsername);
    await panel.getByLabel("口令（留空自动生成）").fill(refereePassword);
    await panel.getByRole("button", { name: "开通裁判账号" }).click();
    await expect(panel).toContainText("裁判账号已开通");
    await expect(panel).toContainText(`用户名 ${refereeUsername}`);
    await expect(panel).not.toContainText("还没有可用的裁判员账号");
    await admin.context.close();

    // 裁判用用户名登录：没有任何逐场指派，也能看到全部 6 场并进入。
    const phone = await loggedIn(browser, refereeUsername, refereePassword, { width: 390, height: 844 });
    await phone.page.goto("/officiating");
    const cards = phone.page.getByTestId("assignment-card");
    await expect(cards).toHaveCount(6);
    await expect(cards.first()).toContainText("共用裁判账号");
    const matchCode = (await cards.first().locator("h2").textContent())!.trim();
    await cards.first().getByRole("link", { name: "进入执裁" }).click();
    await expect(phone.page).toHaveURL(`/officiating/${matchCode}`);
    await phone.page.getByRole("button", { name: "取得本机控制权" }).click();
    await expect(phone.page.locator(".scoring-workbench, body")).toContainText("本机可写");

    // 同一账号的第二台设备打开同一场：不能抢控制，只能旁观。
    const tablet = await loggedIn(browser, refereeUsername, refereePassword);
    await tablet.page.goto(`/officiating/${matchCode}`);
    await expect(tablet.page.getByTestId("badminton-court")).toBeVisible();
    await tablet.page.getByRole("button", { name: "取得本机控制权" }).click();
    await expect(tablet.page.locator("body")).toContainText("另一台设备控制");
    await expect(tablet.page.locator("body")).not.toContainText("本机可写");
    await tablet.context.close();
    await phone.context.close();
  });
});

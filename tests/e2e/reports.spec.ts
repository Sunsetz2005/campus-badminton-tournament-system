import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

/**
 * 阶段 7：成绩册、导出与公开查询。在浏览器里走完「生成草稿/正式版 Excel 与 PDF → 更正后替代 → 公开下载」，
 * 并验证裁判长看不到、也下载不到内部报名名单。
 *
 * 截图默认写入未提交的 `local-run/`；固化证据时显式设 `PHASE7_SHOT_DIR=shots`。
 */
const shotDir = path.join(process.cwd(), "artifacts", "phase7-reports", process.env.PHASE7_SHOT_DIR ?? "local-run");
const RUN = randomBytes(3).toString("hex");
const slug = `e2e-7-${RUN}`;
const api = `/api/admin/tournaments/${slug}`;

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("账号", { exact: false }).fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function loggedIn(browser: Browser, email: string, password: string, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  await login(page, email, password);
  return { context, page };
}

async function shot(page: Page, name: string) {
  mkdirSync(shotDir, { recursive: true });
  await page.addStyleTag({ content: ".skip-link { display: none !important; }" });
  await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function ok<T = unknown>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  if (!response.ok()) throw new Error(`${response.url()} → ${response.status()} ${await response.text()}`);
  return (await response.json()) as T;
}

test.describe.serial("阶段 7 成绩册、导出与公开查询", () => {
  test.describe.configure({ timeout: 240_000 });
  test.beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  });

  test.afterAll(async () => {
    const demoEmails = [process.env.DEMO_ADMIN_EMAIL, process.env.DEMO_REFEREE_EMAIL].filter((email): email is string => Boolean(email));
    await prisma.session.deleteMany({ where: { user: { email: { in: demoEmails } } } });
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) return;
    const matchWhere = { stage: { competition: { tournamentId: tournament.id } } };
    await prisma.matchEvent.deleteMany({ where: { match: matchWhere } });
    await prisma.resultRevision.deleteMany({ where: { match: matchWhere } });
    await prisma.match.deleteMany({ where: matchWhere });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  });

  test("管理员生成草稿与正式版；更正后旧版标记已被替代；公开端只提供当前正式版；裁判长拿不到内部名单", async ({ browser }) => {
    const admin = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    const request = admin.page.request;
    await ok(
      await request.post("/api/admin/tournaments", {
        data: {
          slug,
          name: "成绩册端到端（模拟）",
          startDate: "2026-11-01",
          endDate: "2026-11-02",
          timezone: "Asia/Shanghai",
          namePolicy: "DISPLAY_NAMES",
          rulePreset: "traditional-21",
          competitions: [{ kind: "MS", code: "MS", name: "男子单打" }],
        },
      }),
    );
    await ok(await request.post(`${api}/phase`, { data: { to: "REGISTRATION_OPEN" } }));
    const competition = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug } }, select: { id: true } });
    const names = ["欧阳娜娜·阿卜杜热合曼·买买提提江", "选手乙", "选手丙", "选手丁"];
    for (const [index, displayName] of names.entries()) {
      const created = await ok<{ referenceCode: string }>(
        await request.post(`${api}/registrations`, {
          data: { competitionId: competition.id, members: [{ displayName, teamName: `模拟学院 ${index + 1}`, studentId: `20269900${index + 1}`, contact: `1380000000${index + 1}` }] },
        }),
      );
      const registration = await prisma.registration.findUniqueOrThrow({ where: { referenceCode: created.referenceCode } });
      await ok(await request.post(`${api}/registrations/${registration.id}/review`, { data: { action: "APPROVE", expectedVersion: registration.version } }));
    }
    const draft = await ok<{ drawId: string }>(await request.post(`${api}/competitions/MS/draws`, { data: { format: "ROUND_ROBIN" } }));
    await ok(await request.post(`${api}/phase`, { data: { to: "REGISTRATION_CLOSED" } }));
    await ok(await request.post(`${api}/competitions/MS/draws/${draft.drawId}/publish`, { data: { confirm: true } }));
    await ok(await request.post(`${api}/publish`));
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug } });
    const referee = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL! } });
    await prisma.roleAssignment.create({ data: { userId: referee.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" } });
    // 相当于赛程已发布：比赛进入逐场公开边界。
    const matches = await prisma.match.findMany({ where: { stage: { competition: { tournamentId: tournament.id } } }, orderBy: { code: "asc" } });
    for (const [index, match] of matches.entries()) {
      await prisma.match.update({ where: { id: match.id }, data: { publishedAt: new Date(), scheduledAt: new Date(Date.UTC(2026, 10, 1, 1 + index, 0)) } });
    }
    // 编号小者胜，五场由管理员补录，最后一场留待复核。
    const revisions: Record<string, number> = {};
    for (const match of matches) {
      const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: match.fixtureId! }, include: { sideAEntry: true, sideBEntry: true } });
      const aWins = (fixture.sideAEntry?.code ?? "") < (fixture.sideBEntry?.code ?? "");
      const games = aWins ? [{ a: 21, b: 15 }, { a: 21, b: 18 }] : [{ a: 16, b: 21 }, { a: 19, b: 21 }];
      revisions[match.code] = (await ok<{ revision: number }>(await request.post(`${api}/matches/${match.code}/result-only`, { data: { outcome: "NORMAL", games, reason: "纸质记分表" } }))).revision;
    }

    const chief = await loggedIn(browser, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    for (const match of matches.slice(0, 5)) {
      await ok(await chief.page.request.post(`${api}/matches/${match.code}/result-only/review`, { data: { action: "CONFIRM", expectedRevision: revisions[match.code], reason: "核对无误" } }));
    }

    // 1. 管理员：生成赛事数据表草稿与正式版、内部报名名单，并实际下载。
    const { page } = admin;
    await page.goto(`/management/${slug}/reports`);
    await expect(page.getByRole("heading", { name: "成绩册与导出", level: 1 })).toBeVisible();
    const excel = page.getByRole("region", { name: "赛事数据表（Excel）" });
    await excel.getByRole("button", { name: "生成草稿" }).click();
    await expect(excel.getByRole("status").filter({ hasText: "已生成第 1 版" })).toBeVisible();
    await excel.getByRole("button", { name: "生成正式版" }).click();
    await expect(excel.getByRole("status").filter({ hasText: "已生成第 2 版" })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await excel.getByRole("status").filter({ hasText: "已生成第 2 版" }).getByRole("link").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const bytes = await (await download.createReadStream()).toArray();
    expect(Buffer.concat(bytes).subarray(0, 2).toString("latin1")).toBe("PK");

    await excel.getByRole("button", { name: "生成正式版" }).click();
    await expect(excel.getByRole("alert")).toContainText("没有变化");

    const internal = page.getByRole("region", { name: "内部报名名单（Excel）" });
    await internal.getByRole("button", { name: "生成内部报名名单" }).click();
    await expect(internal.getByRole("status")).toContainText("已生成第 1 版");

    const booklet = page.getByRole("region", { name: "成绩册（A4 打印网页与 PDF）" });
    await booklet.getByRole("button", { name: "生成 PDF 正式版" }).click();
    await expect(booklet.getByRole("status")).toContainText("已生成第 1 版", { timeout: 60_000 });
    await page.reload();
    await expect(page.getByRole("region", { name: "已生成的文件" }).getByRole("row")).toHaveCount(5);
    await shot(page, "01-admin-reports");

    // 打印网页：同一模板，禁止脚本；不存档。
    const printPage = await admin.context.newPage();
    const printResponse = await printPage.goto(`/management/${slug}/reports/booklet?edition=DRAFT`);
    expect(printResponse?.headers()["content-security-policy"]).toContain("default-src 'none'");
    await expect(printPage.getByText("草稿 · 非正式成绩")).toBeVisible();
    await expect(printPage.getByText("欧阳娜娜·阿卜杜热合曼·买买提提江").first()).toBeVisible();
    await expect(printPage.locator("script")).toHaveCount(0);
    await shot(printPage, "02-print-booklet-draft");
    await printPage.close();

    // 2. 公开端：对阵与名次只公布已确认结果；成绩册提供当前正式版。
    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const publicPage = await visitor.newPage();
    await publicPage.goto(`/public/${slug}/results`);
    const pendingCode = matches[5].code;
    const pendingRow = publicPage.getByRole("row").filter({ hasText: pendingCode });
    await expect(pendingRow).toContainText("暂定 · 待确认");
    await expect(pendingRow).not.toContainText(":");
    await noHorizontalOverflow(publicPage);
    await shot(publicPage, "03-public-results-mobile");
    await publicPage.goto(`/public/${slug}/downloads`);
    await expect(publicPage.getByRole("article")).toHaveCount(2);
    await expect(publicPage.getByRole("article", { name: "赛事数据表（Excel）" })).toContainText("第 2 版");
    await noHorizontalOverflow(publicPage);
    await shot(publicPage, "04-public-downloads-mobile");
    const publicData = await publicPage.request.get(`/api/public/tournaments/${slug}/reports/data`);
    expect(publicData.status()).toBe(200);
    const publicXlsx = await publicData.body();
    expect(publicXlsx.includes(Buffer.from("20269900"))).toBe(false);
    expect((await publicPage.request.get(`/api/public/tournaments/${slug}/reports/booklet`)).headers()["content-type"]).toBe("application/pdf");

    // 3. 第 6 场复核后重新生成正式版：旧版标记已被替代，公开端换成新版本。
    await ok(await chief.page.request.post(`${api}/matches/${pendingCode}/result-only/review`, { data: { action: "CONFIRM", expectedRevision: revisions[pendingCode], reason: "核对无误" } }));
    await page.reload();
    await expect(page.getByRole("region", { name: "已生成的文件" })).toContainText("数据已变化");
    await page.getByRole("region", { name: "赛事数据表（Excel）" }).getByRole("button", { name: "生成正式版" }).click();
    await expect(page.getByRole("region", { name: "赛事数据表（Excel）" }).getByText("第 2 版正式版已标记为「已被替代」")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "已生成的文件" })).toContainText("已被第 3 版替代");
    await shot(page, "05-admin-superseded");
    await publicPage.goto(`/public/${slug}/downloads`);
    await expect(publicPage.getByRole("article", { name: "赛事数据表（Excel）" })).toContainText("第 3 版");

    // 4. 裁判长：能看到并生成对外版本，看不到也下载不到内部报名名单。
    const internalRow = await prisma.reportExport.findFirstOrThrow({ where: { tournamentId: tournament.id, kind: "REGISTRATIONS_INTERNAL" } });
    await chief.page.goto(`/management/${slug}/reports`);
    await expect(chief.page.getByRole("region", { name: "内部报名名单（Excel）" })).toHaveCount(0);
    await expect(chief.page.getByRole("region", { name: "已生成的文件" })).not.toContainText("内部报名名单");
    expect((await chief.page.request.get(`${api}/reports/${internalRow.id}`)).status()).toBe(403);
    expect((await chief.page.request.post(`${api}/reports`, { data: { kind: "REGISTRATIONS_INTERNAL" } })).status()).toBe(403);
    expect((await publicPage.request.get(`${api}/reports/${internalRow.id}`)).status()).toBe(401);

    await visitor.close();
    await chief.context.close();
    await admin.context.close();
  });
});

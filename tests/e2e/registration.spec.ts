import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";
import { toCsv } from "../../src/domain/registration/csv";
import { IMPORT_HEADERS } from "../../src/domain/registration/import-plan";

/**
 * 阶段 4-A：赛事创建与报名，从浏览器走完整链路。
 *
 * 截图默认写入未提交的 `local-run/`，重新固化证据时显式设 `PHASE4A_SHOT_DIR=shots`，
 * 避免普通测试运行改写已记账的证据。
 */
const shotDir = path.join(process.cwd(), "artifacts", "phase4a-registration", process.env.PHASE4A_SHOT_DIR ?? "local-run");
const slug = `e2e-4a-${randomBytes(3).toString("hex")}`;
let inviteUrl = "";

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("登录邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function shot(page: Page, name: string) {
  mkdirSync(shotDir, { recursive: true });
  // fullPage 截图会把 position: fixed 的「跳到主要内容」重排进画面（未获焦点时实际在视口外），只在截图时隐藏。
  await page.addStyleTag({ content: ".skip-link { display: none !important; }" });
  await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true });
}

test.describe.serial("阶段 4-A 赛事创建与报名", () => {
  test.beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  });

  test.afterAll(async () => {
    const demoEmails = [process.env.DEMO_ADMIN_EMAIL, process.env.DEMO_REFEREE_EMAIL].filter((email): email is string => Boolean(email));
    await prisma.session.deleteMany({ where: { user: { email: { in: demoEmails } } } });
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) return;
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  });

  test("未登录直接调用管理接口被拒绝，无效邀请令牌统一提示", async ({ page, request }) => {
    const response = await request.post("/api/admin/tournaments", { data: { slug } });
    expect(response.status()).toBe(401);
    await page.goto("/register/not-a-real-token");
    await expect(page.getByRole("heading", { name: "报名链接无效或已失效" })).toBeVisible();
  });

  test("管理员通过四步向导新建赛事、开放报名并生成邀请链接", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await page.goto("/management");
    await page.getByRole("link", { name: "新建赛事" }).click();

    await page.getByLabel("赛事名称").fill("阶段 4-A 端到端测试杯");
    await page.getByLabel("访问路径").fill(slug);
    await page.getByLabel("开始日期").fill("2026-11-07");
    await page.getByLabel("结束日期").fill("2026-11-08");
    await page.getByLabel("比赛场馆").fill("综合体育馆");
    await shot(page, "01-wizard-basics");
    await page.getByRole("button", { name: "下一步" }).click();

    // 默认带男单、女单；再加一个男双。
    await page.getByRole("button", { name: "＋ 男子双打" }).click();
    await shot(page, "02-wizard-competitions");
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.getByText("内置规则都是演示配置")).toBeVisible();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.getByText(`/public/${slug}`)).toBeVisible();
    await shot(page, "03-wizard-confirm");
    await page.getByRole("button", { name: "创建赛事" }).click();

    await expect(page).toHaveURL(new RegExp(`/management/${slug}$`));
    await expect(page.getByRole("heading", { level: 1, name: "阶段 4-A 端到端测试杯" })).toBeVisible();
    await expect(page.getByText("草稿（未公开）")).toBeVisible();

    await page.getByRole("button", { name: "开放报名" }).click();
    await expect(page.getByRole("heading", { name: "赛事阶段：报名进行中" })).toBeVisible();

    await page.getByLabel("链接名称").fill("计算机学院");
    await page.getByRole("button", { name: "生成邀请链接" }).click();
    const link = page.getByTestId("invite-link");
    await expect(link).toBeVisible();
    inviteUrl = (await link.textContent()) ?? "";
    expect(inviteUrl).toMatch(/\/register\/[A-Za-z0-9_-]{43}$/);
    await shot(page, "04-overview-invite");

    // 数据库只保存摘要。
    const token = inviteUrl.split("/").pop()!;
    const stored = await prisma.registrationInvite.findFirstOrThrow({ where: { tournament: { slug } } });
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  test("匿名手机用户通过邀请链接提交报名，只得到待审核回执", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(inviteUrl);
    await expect(page.getByRole("heading", { name: "阶段 4-A 端到端测试杯" })).toBeVisible();
    await page.getByLabel("报名项目").selectOption({ label: "男子单打（单打，1 人）" });
    await page.getByRole("textbox", { name: /^姓名/ }).fill("王小明");
    await page.getByRole("textbox", { name: /^学号/ }).fill("20260001");
    await page.getByRole("textbox", { name: /^代表队 \/ 学院/ }).fill("计算机学院");
    await page.getByRole("textbox", { name: /^联系方式/ }).fill("13800000001");
    await shot(page, "05-invite-form-mobile");
    const submit = page.getByRole("button", { name: "提交报名" });
    await expect(submit).toBeDisabled();
    await page.getByRole("checkbox", { name: /^我已知悉/ }).check();
    await submit.click();
    await expect(page.getByTestId("receipt-code")).toHaveText(/^R-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    await expect(page.getByText("等待组织方审核")).toBeVisible();
    await shot(page, "06-invite-receipt-mobile");

    const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noHorizontalOverflow).toBe(true);
    await context.close();
  });

  test("审核：同名无学号必须人工确认，确认后才生成报名单位", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await page.goto(`/management/${slug}/registrations`);

    // 先通过邀请来的报名。
    const invited = page.getByTestId("registration-row").filter({ hasText: "王小明" });
    await expect(invited.getByText("邀请链接「计算机学院」")).toBeVisible();
    await invited.getByRole("button", { name: "通过" }).click();
    await expect(page.getByTestId("registration-row").filter({ hasText: "王小明" })).toHaveCount(0);

    // 后台录入两个同名、都没有学号的选手。
    for (const team of ["体育学院", "外国语学院"]) {
      await page.getByLabel("比赛项目").selectOption({ label: "MS 男子单打（单打）" });
      await page.getByRole("textbox", { name: /^姓名/ }).fill("李华");
      await page.getByRole("textbox", { name: /^代表队 \/ 学院/ }).fill(team);
      await page.getByRole("button", { name: "录入报名" }).click();
      await expect(page.getByText(/已录入，回执编号 R-/)).toBeVisible();
    }
    const first = page.getByTestId("registration-row").filter({ hasText: "体育学院" });
    await first.getByRole("button", { name: "通过" }).click();
    // 剩下唯一一份待审核是外国语学院那份；它的身份候选里会出现刚通过的「P002 · 李华 · 体育学院」。
    await expect(page.getByTestId("registration-row")).toHaveCount(1);

    const second = page.getByTestId("registration-row").filter({ hasText: "外国语学院" });
    await expect(second.getByText("需要确认身份")).toBeVisible();
    await expect(second.getByRole("button", { name: "通过" })).toBeDisabled();
    await shot(page, "07-review-identity-ambiguous");
    await second.getByLabel("不是同一人：新建为另一名选手（同名不同人）").check();
    await second.getByRole("button", { name: "通过" }).click();
    await expect(page.getByTestId("registration-row").filter({ hasText: "外国语学院" })).toHaveCount(0);

    await page.getByRole("link", { name: /已通过 3/ }).click();
    await expect(page.getByTestId("registration-row")).toHaveCount(3);
    const people = page.getByRole("table").last();
    await expect(people.getByRole("cell", { name: "李华" })).toHaveCount(2);
    await shot(page, "08-review-approved");

    const entries = await prisma.entry.findMany({
      where: { competition: { tournament: { slug } } },
      select: { code: true },
      orderBy: { code: "asc" },
    });
    expect(entries.map((entry) => entry.code)).toEqual(["MS-001", "MS-002", "MS-003"]);
  });

  test("CSV 导入：有错误行时整份不导入；修正后预览再确认", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await page.goto(`/management/${slug}/registrations`);
    const header = [...IMPORT_HEADERS];
    const row = (...cells: string[]) => [...cells, ...Array(header.length - cells.length).fill("")];
    mkdirSync(shotDir, { recursive: true });
    const bad = path.join(shotDir, "import-bad.csv");
    const good = path.join(shotDir, "import-good.csv");
    writeFileSync(bad, toCsv([header, row("MD", "赵一", "S1", "", "", "钱二", "S2"), row("MS", "=HYPERLINK(1)"), row("XX", "孙三")]));
    writeFileSync(good, toCsv([header, row("MD", "赵一", "S1", "", "", "钱二", "S2"), row("WS", "周四", "S4")]));

    await page.getByLabel("选择 CSV 文件").setInputFiles(bad);
    await page.getByRole("button", { name: "预览" }).click();
    await expect(page.getByText("共 3 行：新增 1，重复 0，错误 2。")).toBeVisible();
    await expect(page.getByRole("cell", { name: "第 3 行" })).toBeVisible();
    await expect(page.getByText("疑似表格公式")).toBeVisible();
    await expect(page.getByRole("button", { name: "确认导入 1 份" })).toBeDisabled();
    await shot(page, "09-import-errors");

    await page.getByLabel("选择 CSV 文件").setInputFiles(good);
    await page.getByRole("button", { name: "预览" }).click();
    await expect(page.getByText("共 2 行：新增 2，重复 0，错误 0。")).toBeVisible();
    await page.getByRole("button", { name: "确认导入 2 份" }).click();
    await expect(page.getByText("已导入 2 份待审核报名，跳过重复 0 行。")).toBeVisible();
    await expect(page.getByTestId("registration-row").filter({ hasText: "批量导入" })).toHaveCount(2);
    await shot(page, "10-import-committed");
  });

  test("裁判没有赛事管理角色：页面 403，接口 403", async ({ page }) => {
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    const response = await page.goto(`/management/${slug}/registrations`);
    expect(response?.status()).toBe(403);
    const api = await page.request.post(`/api/admin/tournaments/${slug}/invites`, {
      data: { label: "越权", expiresAt: "2026-11-01T09:00", maxSubmissions: 5 },
    });
    expect(api.status()).toBe(403);
  });
});

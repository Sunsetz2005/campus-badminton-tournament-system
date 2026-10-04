import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

/**
 * 阶段 6：成绩、名次与晋级。在浏览器里走完「补录结果 → 独立复核 → 并列待裁定 → 确认名次 → 发布榜单 → 更正预览与重开」。
 *
 * 截图默认写入未提交的 `local-run/`；固化证据时显式设 `PHASE6_SHOT_DIR=shots`。
 */
const shotDir = path.join(process.cwd(), "artifacts", "phase6-results", process.env.PHASE6_SHOT_DIR ?? "local-run");
const RUN = randomBytes(3).toString("hex");
const slug = `e2e-6-${RUN}`;
const api = `/api/admin/tournaments/${slug}`;

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("账号", { exact: false }).fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function loggedIn(browser: Browser, email: string, password: string, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
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

async function groupFixtures() {
  return prisma.fixture.findMany({
    where: { competition: { tournament: { slug } }, kind: "GROUP" },
    orderBy: [{ round: "asc" }, { sequence: "asc" }],
    include: { matches: true, sideAEntry: true, sideBEntry: true },
  });
}

test.describe.serial("阶段 6 成绩、名次与晋级", () => {
  test.describe.configure({ timeout: 180_000 });
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

  test("管理员补录仅结果记录，另一位裁判长复核；完全同分须抽签确认；发布榜单后更正先看影响", async ({ browser }) => {
    const admin = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    const request = admin.page.request;
    await ok(
      await request.post("/api/admin/tournaments", {
        data: {
          slug,
          name: "成绩名次端到端",
          startDate: "2026-11-01",
          endDate: "2026-11-02",
          timezone: "Asia/Shanghai",
          namePolicy: "CODES_ONLY",
          rulePreset: "traditional-21",
          competitions: [{ kind: "MS", code: "MS", name: "男子单打" }],
        },
      }),
    );
    await ok(await request.post(`${api}/phase`, { data: { to: "REGISTRATION_OPEN" } }));
    const competition = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug } }, select: { id: true } });
    for (const name of ["甲", "乙", "丙"]) {
      const created = await ok<{ referenceCode: string }>(await request.post(`${api}/registrations`, { data: { competitionId: competition.id, members: [{ displayName: `选手${name}` }] } }));
      const registration = await prisma.registration.findUniqueOrThrow({ where: { referenceCode: created.referenceCode } });
      await ok(await request.post(`${api}/registrations/${registration.id}/review`, { data: { action: "APPROVE", expectedVersion: registration.version } }));
    }
    const draft = await ok<{ drawId: string }>(await request.post(`${api}/competitions/MS/draws`, { data: { format: "ROUND_ROBIN" } }));
    await ok(await request.post(`${api}/phase`, { data: { to: "REGISTRATION_CLOSED" } }));
    await ok(await request.post(`${api}/competitions/MS/draws/${draft.drawId}/publish`, { data: { confirm: true } }));
    // 管理员负责补录；演示裁判员账号在本赛事兼任裁判长，负责独立复核与名次确认。
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug } });
    const referee = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL! } });
    await prisma.roleAssignment.create({ data: { userId: referee.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" } });

    const fixtures = await groupFixtures();
    expect(fixtures).toHaveLength(3);
    const [first, ...rest] = fixtures;

    // 1. 管理员在页面上补录第一场：先填一个不可能的比分，服务端逐条说明原因。
    const { page } = admin;
    await page.goto(`/management/${slug}/results`);
    await expect(page.getByRole("heading", { name: "成绩名次", level: 1 })).toBeVisible();
    await page.getByRole("link", { name: "成绩与名次" }).click();
    await expect(page.getByTestId("ranking-profile")).toContainText("校园演示排名方案");
    await expect(page.getByTestId("ranking-profile")).toContainText("须组织者确认");
    const row = page.getByTestId(`match-${first.code}`);
    await row.getByRole("button", { name: "补录结果" }).click();
    await row.getByLabel("第 1 局 A 方比分").fill("25");
    await row.getByLabel("第 1 局 B 方比分").fill("20");
    await row.getByLabel("第 2 局 A 方比分").fill("21");
    await row.getByLabel("第 2 局 B 方比分").fill("10");
    await row.getByLabel("补录依据（必填，记入审计）").fill("纸质记分表 01 号");
    await row.getByRole("button", { name: "提交待复核" }).click();
    await expect(row.getByRole("alert")).toContainText("第 1 局比分 25:20 不是按本场规则");
    await row.getByLabel("第 1 局 A 方比分").fill("21");
    await row.getByLabel("第 1 局 B 方比分").fill("10");
    await row.getByRole("button", { name: "提交待复核" }).click();
    await expect(row).toContainText("待复核");
    await expect(row).toContainText("仅结果");
    await expect(page.getByTestId("group-A")).toContainText("暂定");
    await shot(page, "01-result-only-recorded");
    await expect(prisma.matchEvent.count({ where: { matchId: first.matches[0].id } })).resolves.toBe(0);

    // 其余两场用接口补录，构成三方循环且比分完全相同。
    const winner = first.sideAEntryId as string;
    const loser = first.sideBEntryId as string;
    const revisions: Record<string, number> = {};
    for (const item of rest) {
      const sides = [item.sideAEntryId, item.sideBEntryId];
      const aWins = sides.includes(loser) ? item.sideAEntryId === loser : item.sideAEntryId !== winner;
      const games = aWins ? [{ a: 21, b: 10 }, { a: 21, b: 10 }] : [{ a: 10, b: 21 }, { a: 10, b: 21 }];
      const recorded = await ok<{ revision: number }>(
        await request.post(`${api}/matches/${item.matches[0].code}/result-only`, { data: { outcome: "NORMAL", games, reason: "纸质记分表" } }),
      );
      revisions[item.matches[0].code] = recorded.revision;
    }
    // 补录人不能自己复核（管理员没有裁判长角色时同样被拒绝）。
    const selfReview = await request.post(`${api}/matches/${first.matches[0].code}/result-only/review`, { data: { action: "CONFIRM", expectedRevision: 1, reason: "自己复核" } });
    expect(selfReview.status()).toBe(403);
    await admin.context.close();

    // 2. 裁判长：后台只看得到「成绩名次」与「成绩册与导出」，其他管理页面服务端拒绝。
    const chief = await loggedIn(browser, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    const chiefPage = chief.page;
    await chiefPage.goto(`/management/${slug}/registrations`);
    await expect(chiefPage.getByRole("heading", { name: "没有赛事管理权限" })).toBeVisible();
    await chiefPage.goto(`/management/${slug}/results/MS`);
    await expect(chiefPage.getByRole("navigation", { name: "赛事后台导航" }).getByRole("link")).toHaveText(["← 全部赛事", "成绩名次", "成绩册与导出"]);
    const chiefRow = chiefPage.getByTestId(`match-${first.code}`);
    await chiefRow.getByLabel("复核意见（必填）").fill("核对记分表无误");
    await chiefRow.getByRole("button", { name: "复核锁定" }).click();
    await expect(chiefRow).toContainText("正式确认");
    for (const item of rest) {
      await ok(
        await chiefPage.request.post(`${api}/matches/${item.matches[0].code}/result-only/review`, {
          data: { action: "CONFIRM", expectedRevision: revisions[item.matches[0].code], reason: "核对无误" },
        }),
      );
    }

    // 3. 三方完全同分：并列待裁定，展示每人的比较过程；须按抽签顺序并写明依据才能确认。
    await chiefPage.reload();
    const group = chiefPage.getByTestId("group-A");
    await expect(group).toContainText("并列待裁定");
    await group.getByText("为什么排在这里").first().click();
    await expect(group).toContainText("各项完全相同，并列待裁定");
    await shot(chiefPage, "02-needs-decision");
    await group.getByRole("button", { name: "确认循环赛名次" }).click();
    await expect(group.getByRole("alert")).toContainText("写明");
    await group.getByRole("button", { name: /^下移 / }).first().click();
    await group.getByLabel("抽签情况（必填，记入审计）").fill("11 月 2 日 10:00 裁判长主持抽签，三方领队见证");
    await group.getByRole("button", { name: "确认循环赛名次" }).click();
    await expect(group).toContainText("名次已由裁判长确认");
    await expect(chiefPage.getByTestId("placements")).toContainText("第 3 名");

    // 4. 发布榜单第 1 版。
    await chiefPage.getByLabel("发布说明（选填）").fill("循环赛名次");
    await chiefPage.getByRole("button", { name: "发布榜单新版本" }).click();
    await expect(chiefPage.getByText("已发布第 1 版榜单。")).toBeVisible();
    await shot(chiefPage, "03-ranking-confirmed-published");

    // 5. 更正：先看影响（撤回已确认名次、榜单需重发），再重开；旧版本保留。
    await chiefRow.getByRole("button", { name: "更正前查看影响" }).click();
    const impact = chiefPage.getByTestId(`impact-${first.matches[0].code}`);
    await expect(impact).toContainText("撤回 A 组已确认的名次");
    await expect(impact).toContainText("需重新发布");
    await shot(chiefPage, "04-correction-impact");
    await impact.getByLabel("更正原因（必填，旧结果保留为被替代版本）").fill("记分表胜方抄错");
    await impact.getByRole("button", { name: "确认重开更正" }).click();
    await expect(chiefRow).toContainText("未开始");
    await expect(group).toContainText("暂定");
    await expect(chiefPage.getByText("成绩已变化，榜单需重新发布")).toBeVisible();
    await expect(
      prisma.resultRevision.findMany({ where: { matchId: first.matches[0].id }, orderBy: { revision: "asc" }, select: { status: true } }),
    ).resolves.toEqual([{ status: "SUPERSEDED" }]);

    // 6. 手机宽度：页面本身不横向溢出（宽表在表格容器内横向滚动）。
    await chiefPage.setViewportSize({ width: 390, height: 844 });
    await chiefPage.reload();
    await noHorizontalOverflow(chiefPage);
    await shot(chiefPage, "05-results-mobile");
    await chief.context.close();
  });
});

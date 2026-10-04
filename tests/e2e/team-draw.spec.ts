import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

/**
 * 阶段 4-B：团体赛从建赛、学院负责人提交名单、审核，到抽签草稿、调签与正式发布，在浏览器里走完整链路。
 *
 * 截图默认写入未提交的 `local-run/`；固化证据时显式设 `PHASE4B_SHOT_DIR=shots`。
 */
const shotDir = path.join(process.cwd(), "artifacts", "phase4b-team-draw", process.env.PHASE4B_SHOT_DIR ?? "local-run");
const RUN = randomBytes(3).toString("hex");
const slug = `e2e-4b-${RUN}`;
const managerEmail = `e2e-mgr-${RUN}@example.invalid`;
const managerPassword = `Team-${RUN}-Strong-Pass!`;
let initialPassword = "";
let studentSeq = 0;

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("账号", { exact: false }).fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function shot(page: Page, name: string) {
  mkdirSync(shotDir, { recursive: true });
  await page.addStyleTag({ content: ".skip-link { display: none !important; }" });
  // 一次性口令即使是测试账号也不进入截图证据。
  await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true, mask: [page.getByTestId("initial-password")] });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

function rosterRows(short: string) {
  return [
    // 4-D 起报项必填：男队员报男单/男双/混双，女队员报女单/女双/混双。
    ...[1, 2, 3].map((n) => ({
      displayName: `${short}男${n}`,
      studentId: `E${RUN}${String(++studentSeq).padStart(3, "0")}`.toUpperCase(),
      gender: "MALE",
      rubberKinds: ["MS", "MD", "XD"],
    })),
    ...[1, 2, 3].map((n) => ({
      displayName: `${short}女${n}`,
      studentId: `E${RUN}${String(++studentSeq).padStart(3, "0")}`.toUpperCase(),
      gender: "FEMALE",
      rubberKinds: ["WS", "WD", "XD"],
    })),
  ];
}

test.describe.serial("阶段 4-B 团体赛抽签编排", () => {
  test.beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  });

  test.afterAll(async () => {
    const demoEmails = [process.env.DEMO_ADMIN_EMAIL, process.env.DEMO_REFEREE_EMAIL].filter((email): email is string => Boolean(email));
    await prisma.session.deleteMany({ where: { user: { email: { in: demoEmails } } } });
    await prisma.user.deleteMany({ where: { email: managerEmail } });
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) return;
    await prisma.match.deleteMany({ where: { stage: { competition: { tournamentId: tournament.id } } } });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  });

  test("管理员用向导建团体赛：可调整小场顺序与名单人数", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await page.goto("/management/new");
    await page.getByLabel("赛事名称").fill("阳光体育羽毛球联赛 端到端");
    await page.getByLabel("访问路径").fill(slug);
    await page.getByLabel("开始日期").fill("2026-10-17");
    await page.getByLabel("结束日期").fill("2026-10-25");
    await page.getByRole("button", { name: "下一步" }).click();

    // 去掉默认的男单、女单，只保留一个团体赛项目。
    await page.getByRole("button", { name: "删除第 1 个项目" }).click();
    await page.getByRole("button", { name: "删除第 1 个项目" }).click();
    await page.getByRole("button", { name: "＋ 团体赛" }).click();
    await expect(page.getByRole("group", { name: "团体赛设置" })).toBeVisible();
    await expect(page.getByLabel("第 5 个小场", { exact: true })).toHaveValue("XD");
    await page.getByLabel("名单最多人数").fill("10");
    await shot(page, "01-wizard-team-format");
    await page.getByRole("button", { name: "下一步" }).click();
    await page.getByRole("button", { name: "下一步" }).click();
    await expect(page.getByText("男单、女单、男双、女双、混双")).toBeVisible();
    await page.getByRole("button", { name: "创建赛事" }).click();
    await expect(page).toHaveURL(`/management/${slug}`);
    await page.getByRole("button", { name: "开放报名" }).click();
    await expect(page.getByText("已开放报名。")).toBeVisible();
    const competition = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug } } });
    expect(competition).toMatchObject({ kind: "TEAM", teamRosterMax: 10, teamRubbers: ["MS", "WS", "MD", "WD", "XD"] });
  });

  test("建学院并开通负责人账号：初始口令只显示一次", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await page.goto(`/management/${slug}/teams`);
    await page.getByLabel("学院 / 队伍名称").fill("数学科学学院");
    await page.getByRole("button", { name: "新建队伍" }).click();
    await expect(page.getByText("已新建队伍「数学科学学院」。")).toBeVisible();
    await page.getByLabel("负责人姓名").fill("数学院领队");
    await page.getByLabel("登录邮箱").fill(managerEmail);
    await page.getByRole("button", { name: "开通负责人账号" }).click();
    const secret = page.getByTestId("initial-password");
    await expect(secret).toBeVisible();
    initialPassword = (await secret.textContent())?.trim() ?? "";
    expect(initialPassword).toMatch(/^[2-9a-zA-Z]{16}$/);
    await shot(page, "02-team-manager-created");
    // 刷新后口令不再显示，库里只有哈希。
    await page.reload();
    await expect(page.getByTestId("initial-password")).toHaveCount(0);
    await expect(page.getByText("待首次改口令")).toBeVisible();
  });

  test("负责人首次登录被要求改口令，然后在手机上提交本院名单；不能进入赛事管理", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await login(page, managerEmail, initialPassword);
    await expect(page.getByRole("link", { name: "修改初始口令" })).toBeVisible();
    await page.goto(`/team/${slug}`);
    await expect(page).toHaveURL(new RegExp(`/account/password\\?next=`));
    await shot(page, "03-force-password-mobile");
    await page.getByLabel("当前口令（初始口令）").fill(initialPassword);
    await page.getByLabel(/^新口令/).fill(managerPassword);
    await page.getByLabel("再次输入新口令").fill(managerPassword);
    await page.getByRole("button", { name: "修改口令" }).click();
    await expect(page).toHaveURL(`/team/${slug}`);
    await expect(page.getByRole("heading", { name: "数学科学学院" })).toBeVisible();

    // 只填 1 男 3 女：服务端逐条列出问题，不假装成功。
    const members = rosterRows("数学");
    const fill = async (index: number, member: { displayName: string; studentId: string; gender: string }) => {
      await page.getByLabel(`第 ${index + 1} 名队员姓名`).fill(member.displayName);
      await page.getByLabel(`第 ${index + 1} 名队员学号`).fill(member.studentId);
      await page.getByLabel(`第 ${index + 1} 名队员性别`).selectOption(member.gender);
      const kinds = page.getByRole("group", { name: `第 ${index + 1} 名队员报项` });
      for (const label of member.gender === "MALE" ? ["男单", "男双", "混双"] : ["女单", "女双", "混双"]) await kinds.getByLabel(label).check();
    };
    for (const [index, member] of [members[0], members[3], members[4], members[5]].entries()) await fill(index, member);
    await page.getByRole("button", { name: "提交名单" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "名单未提交" })).toContainText("至少需要 2 名男队员");
    await page.getByRole("button", { name: "＋ 添加队员" }).click();
    await page.getByRole("button", { name: "＋ 添加队员" }).click();
    await fill(4, members[1]);
    await fill(5, members[2]);
    await expect(page.getByTestId("roster-count")).toContainText("已填 6 人（男 3、女 3）");
    await page.getByRole("button", { name: "提交名单" }).click();
    await expect(page.getByRole("status").filter({ hasText: "回执编号" })).toContainText("名单已提交");
    await noHorizontalOverflow(page);
    await shot(page, "04-roster-submitted-mobile");

    // 负责人没有管理权限：直接访问后台页面被拒，直接调用别的队伍接口也被拒。
    const response = await page.goto(`/management/${slug}`);
    expect(response?.status()).toBe(403);
    const other = await prisma.team.findFirst({ where: { tournament: { slug }, NOT: { name: "数学科学学院" } } });
    expect(other).toBeNull();
    const api = await page.request.post(`/api/admin/tournaments/${slug}/teams`, { data: { name: "越权学院" } });
    expect(api.status()).toBe(403);
    await context.close();
  });

  test("管理员审核团体名单，生成以学院命名的报名单位", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await page.goto(`/management/${slug}/registrations`);
    const row = page.getByTestId("registration-row").filter({ hasText: "数学科学学院" });
    await expect(row).toContainText("队伍「数学科学学院」· 6 人");
    await expect(row).toContainText("女");
    await shot(page, "05-review-team-roster");
    await row.getByRole("button", { name: "通过" }).click();
    await expect.poll(async () => prisma.entry.count({ where: { competition: { tournament: { slug } }, entryType: "TEAM" } })).toBe(1);
  });

  test("8 支学院：生成草稿（分 2 组）、手动调签、截止后正式发布", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    // 其余 7 个学院通过真实接口由管理员代录名单并审核，只为凑齐抽签规模。
    const competition = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug } } });
    const api = `/api/admin/tournaments/${slug}`;
    for (const [name, short] of [
      ["物理学院", "物理"], ["化学学院", "化学"], ["生命科学学院", "生科"], ["计算机学院", "计算机"],
      ["外国语学院", "外语"], ["体育科学学院", "体育"], ["经济与管理学院", "经管"],
    ]) {
      const team = await (await page.request.post(`${api}/teams`, { data: { name } })).json();
      const roster = await page.request.post(`${api}/teams/${team.id}/roster`, {
        data: { competitionId: competition.id, members: rosterRows(short) },
      });
      expect(roster.status()).toBe(200);
      const { registrationId } = await roster.json();
      const review = await page.request.post(`${api}/registrations/${registrationId}/review`, { data: { action: "APPROVE", expectedVersion: 0 } });
      expect(review.status()).toBe(200);
    }

    await page.goto(`/management/${slug}/draw`);
    await expect(page.getByTestId("draw-competition-row")).toContainText("小组循环＋淘汰 · 2 组");
    await page.getByRole("link", { name: "进入" }).click();
    await expect(page.getByLabel(/小组循环＋淘汰/)).toBeChecked();
    await page.getByRole("button", { name: "生成抽签草稿" }).click();
    await expect(page.getByTestId("draw-group")).toHaveCount(2);
    await expect(page.getByText("每场对抗含 5 个小场：男单、女单、男双、女双、混双")).toBeVisible();
    await expect(page.getByText("半决赛 1：A 组第 1 名 对 B 组第 2 名")).toBeVisible();
    await shot(page, "06-draw-draft");

    // 手动交换两个学院并留痕：把数学科学学院与另一组的第一支队伍对调。
    const draft = await prisma.draw.findFirstOrThrow({ where: { competitionId: competition.id, status: "DRAFT" } });
    const math = await prisma.entry.findFirstOrThrow({ where: { competitionId: competition.id, displayName: "数学科学学院" } });
    const groups = (draft.result as { layout: { groups: { entryIds: string[] }[] } }).layout.groups;
    const otherGroup = groups.find((group) => !group.entryIds.includes(math.id));
    await page.locator("summary", { hasText: "手动调签" }).click();
    await page.getByLabel("报名单位甲").selectOption(math.id);
    await page.getByLabel("报名单位乙").selectOption(otherGroup?.entryIds[0] as string);
    await page.getByLabel("调签原因（留痕，必填）").fill("组委会要求：同校区学院分开");
    await page.getByRole("button", { name: "应用调签" }).click();
    await expect(page.getByRole("heading", { name: /草稿预览 · 第 2 版/ })).toBeVisible();

    // 报名尚未截止：发布按钮不可用并说明原因。
    await expect(page.getByText(/赛事阶段须为「报名截止」/)).toBeVisible();
    await page.goto(`/management/${slug}`);
    await page.getByRole("button", { name: "截止报名" }).click();
    await expect(page.getByText("已截止报名。")).toBeVisible();
    await page.goto(`/management/${slug}/draw/TEAM`);
    await page.getByLabel(/我已核对分组与冲突/).check();
    await page.getByRole("button", { name: "正式发布抽签" }).click();
    await expect(page.getByRole("heading", { name: "已发布的抽签" })).toBeVisible();
    await expect(page.getByText(/已生成 16 场对阵、\s*80 场比赛/)).toBeVisible();
    await shot(page, "07-draw-published");
    const draw = await prisma.draw.findFirstOrThrow({ where: { competitionId: competition.id, status: "PUBLISHED" } });
    expect(draw.adjustments).toHaveLength(1);
    await expect.poll(async () => prisma.entry.count({ where: { competitionId: competition.id, frozenAt: null } })).toBe(0);

    // 名单已冻结：负责人页面显示锁定。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await noHorizontalOverflow(page);
    await shot(page, "08-draw-published-mobile");
  });

  test("发布后负责人看到名单已锁定", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await login(page, managerEmail, managerPassword);
    await page.goto(`/team/${slug}`);
    await expect(page.getByText("已抽签，名单锁定")).toBeVisible();
    await expect(page.getByText(/名单已审核通过，报名单位编号 TEAM-001/)).toBeVisible();
    await expect(page.getByRole("button", { name: /提交名单|保存名单修改/ })).toHaveCount(0);
    await shot(page, "09-manager-locked-mobile");
    await context.close();
  });
});

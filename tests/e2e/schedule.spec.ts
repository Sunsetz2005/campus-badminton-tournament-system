import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

/**
 * 阶段 4-C：用模拟赛事演示从对阵表到赛程、再到裁判端开赛。
 * 建赛与抽签走管理接口（4-A/4-B 已有浏览器用例），赛程设置、建议、手工调整、发布、裁判列表与现场看板走浏览器。
 *
 * 截图默认写入未提交的 `local-run/`；固化证据时显式设 `PHASE4C_SHOT_DIR=shots`。
 */
const shotDir = path.join(process.cwd(), "artifacts", "phase4c-schedule", process.env.PHASE4C_SHOT_DIR ?? "local-run");
const RUN = randomBytes(3).toString("hex");
const slug = `e2e-4c-${RUN}`;
const api = `/api/admin/tournaments/${slug}`;
let studentSeq = 0;

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("登录邮箱").fill(email);
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

function rosterRows(short: string) {
  const id = () => `S${RUN}${String(++studentSeq).padStart(3, "0")}`.toUpperCase();
  return [
    { displayName: `${short}男1`, studentId: id(), gender: "MALE", rubberKinds: ["MS", "MD"] },
    { displayName: `${short}男2`, studentId: id(), gender: "MALE", rubberKinds: ["MD", "XD"] },
    { displayName: `${short}男3`, studentId: id(), gender: "MALE", rubberKinds: ["MS", "XD"] },
    { displayName: `${short}女1`, studentId: id(), gender: "FEMALE", rubberKinds: ["WS", "WD"] },
    { displayName: `${short}女2`, studentId: id(), gender: "FEMALE", rubberKinds: ["WD", "XD"] },
    { displayName: `${short}女3`, studentId: id(), gender: "FEMALE", rubberKinds: ["WS", "XD"] },
  ];
}

/** 管理员代交一方名单：每个小场取最先报了该项的队员。 */
async function proxyLineup(request: APIRequestContext, fixtureId: string, side: "A" | "B") {
  const fixture = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId }, include: { matches: { orderBy: { rubberOrder: "asc" } } } });
  const entryId = (side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId) as string;
  const members = await prisma.entryMember.findMany({ where: { entryId }, orderBy: { slot: "asc" }, include: { participant: true } });
  const pick = (kind: string, gender?: string) =>
    members.filter((member) => member.rubberKinds.includes(kind as never) && (!gender || member.participant.gender === gender)).map((member) => member.participantId);
  const rubbers = fixture.matches.map((match) => {
    const kind = match.rubberKind as string;
    const ids = kind === "XD" ? [pick("XD", "MALE")[0], pick("XD", "FEMALE")[0]] : pick(kind).slice(0, kind.endsWith("S") ? 1 : 2);
    return { order: match.rubberOrder, participantIds: ids };
  });
  await ok(await request.post(`${api}/fixtures/${fixtureId}/lineup`, { data: { side, rubbers } }));
}

test.describe.serial("阶段 4-C 赛程与裁判排班：从对阵表到赛程再到裁判端", () => {
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
    await prisma.scoringSession.deleteMany({ where: { match: matchWhere } });
    await prisma.match.deleteMany({ where: matchWhere });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  });

  test("准备对阵：4 个学院单循环抽签已发布", async ({ browser }) => {
    const { context, page } = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await ok(
      await page.request.post("/api/admin/tournaments", {
        data: {
          slug,
          name: "阳光体育羽毛球联赛 赛程端到端",
          startDate: "2026-10-17",
          endDate: "2026-10-18",
          timezone: "Asia/Shanghai",
          namePolicy: "DISPLAY_NAMES",
          rulePreset: "traditional-21",
          competitions: [{ kind: "TEAM", code: "TEAM", name: "学院团体赛" }],
        },
      }),
    );
    await ok(await page.request.post(`${api}/phase`, { data: { to: "REGISTRATION_OPEN" } }));
    const competition = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug } } });
    for (const [name, short] of [["数学科学学院", "数学"], ["物理学院", "物理"], ["化学学院", "化学"], ["外国语学院", "外语"]]) {
      const team = await ok<{ id: string }>(await page.request.post(`${api}/teams`, { data: { name } }));
      const roster = await ok<{ registrationId: string }>(await page.request.post(`${api}/teams/${team.id}/roster`, { data: { competitionId: competition.id, members: rosterRows(short) } }));
      await ok(await page.request.post(`${api}/registrations/${roster.registrationId}/review`, { data: { action: "APPROVE", expectedVersion: 0 } }));
    }
    await ok(await page.request.post(`${api}/phase`, { data: { to: "REGISTRATION_CLOSED" } }));
    const draft = await ok<{ drawId: string }>(await page.request.post(`${api}/competitions/TEAM/draws`, { data: { format: "ROUND_ROBIN" } }));
    await ok(await page.request.post(`${api}/competitions/TEAM/draws/${draft.drawId}/publish`, { data: { confirm: true } }));
    // 本赛事的裁判员与裁判长角色（角色授予界面不属于本阶段）。
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug } });
    const referee = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL! } });
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL! } });
    await prisma.roleAssignment.createMany({
      data: [
        { userId: referee.id, tournamentId: tournament.id, role: "REFEREE" },
        { userId: admin.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
      ],
    });
    await expect(prisma.match.count({ where: { fixture: { competitionId: competition.id } } })).resolves.toBe(30);
    await context.close();
  });

  test("设置场地与比赛日，生成排程建议，逐场调整后立即复检", async ({ browser }) => {
    const { context, page } = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await page.goto(`/management/${slug}/schedule?view=settings`);
    await expect(page.getByRole("heading", { name: "赛程与裁判排班" })).toBeVisible();
    await page.getByLabel("追加场地数量").fill("2");
    await page.getByRole("button", { name: "追加场地" }).click();
    await expect(page.getByTestId("court-list").getByRole("listitem")).toHaveCount(2);
    const days = page.getByTestId("schedule-days-form");
    await days.getByLabel("比赛日").first().fill("2026-10-17");
    await days.getByLabel("开始").first().fill("09:00");
    await days.getByLabel("结束").first().fill("18:00");
    await days.getByRole("button", { name: "保存比赛日" }).click();
    await expect(page.getByRole("status").filter({ hasText: "比赛日已保存" })).toBeVisible();
    await shot(page, "01-settings");

    await page.goto(`/management/${slug}/schedule`);
    await page.getByTestId("suggest-form").getByRole("button", { name: "生成排程建议" }).click();
    await expect(page.getByRole("status").filter({ hasText: "已为 30 场比赛生成草稿" })).toContainText("排入 30 场");
    await expect(page.getByTestId("schedule-summary")).toContainText("30草稿已排");
    const rows = page.getByTestId("schedule-row");
    await expect(rows).toHaveCount(30);
    // 两块场地都用上：第一轮两场对抗同时 09:00 开打。
    await expect(rows.filter({ hasText: "09:00" })).toHaveCount(2);
    await expect(page.getByTestId("draft-issues")).not.toContainText("硬冲突");
    await shot(page, "02-draft-suggested");

    // 手机上用表单调整：把一场挪到另一场的场地与时间，立即看到硬冲突；再放弃改动。
    await page.setViewportSize({ width: 390, height: 844 });
    const second = rows.nth(1);
    const firstCode = await rows.nth(0).getAttribute("data-code");
    const firstSlot = await prisma.scheduleSlot.findFirstOrThrow({ where: { match: { code: firstCode! } }, include: { court: true } });
    const ownSlot = await prisma.scheduleSlot.findFirstOrThrow({ where: { match: { code: (await second.getAttribute("data-code"))! } }, include: { court: true } });
    await second.getByText("调整").click();
    const editor = second.locator("form");
    await editor.getByLabel("场地").selectOption({ label: firstSlot.court!.name });
    await editor.getByRole("button", { name: "保存并检查" }).click();
    await expect(editor.getByRole("alert")).toContainText("同一场地时间重叠");
    await expect(page.getByTestId("schedule-summary")).not.toContainText("0硬冲突");
    await noHorizontalOverflow(page);
    await shot(page, "03-manual-conflict-mobile");
    // 改回原场地后复检通过（「放弃这场的草稿改动」会退回已发布版本；这里还没发布过，所以改回而不是放弃）。
    const edited = page.locator(`[data-code="${ownSlot.matchId ? (await prisma.match.findUniqueOrThrow({ where: { id: ownSlot.matchId } })).code : ""}"]`).locator("form");
    await edited.getByLabel("场地").selectOption({ label: ownSlot.court!.name });
    await edited.getByRole("button", { name: "保存并检查" }).click();
    await expect(edited.getByRole("status")).toContainText("已保存到草稿");
    await expect(edited.getByRole("status")).not.toContainText("硬冲突");
    await expect(page.getByTestId("schedule-summary")).toContainText("0硬冲突");
    await context.close();
  });

  test("发布：确认警告后发布，裁判的「我的执裁」出现带时间与场地的比赛，并能进入执裁台", async ({ browser }) => {
    const admin = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await admin.page.goto(`/management/${slug}/schedule`);
    const panel = admin.page.getByTestId("publish-panel");
    const acknowledge = panel.getByRole("checkbox");
    if (await acknowledge.count()) await acknowledge.check();
    await panel.getByRole("button", { name: "发布赛程" }).click();
    await expect(panel.getByRole("status")).toContainText("赛程已发布");
    await admin.page.goto(`/management/${slug}/schedule?view=history`);
    await expect(admin.page.getByTestId("publication-list")).toContainText("第 1 版");

    const referee = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL! } });
    const assignment = await prisma.officialAssignment.findFirstOrThrow({
      where: { userId: referee.id, active: true, match: { fixture: { competition: { tournament: { slug } } } } },
      include: { match: true },
      orderBy: { match: { scheduledAt: "asc" } },
    });
    // 开赛前双方出场名单要交齐（由管理员代交）。
    await proxyLineup(admin.page.request, assignment.match.fixtureId!, "A");
    await proxyLineup(admin.page.request, assignment.match.fixtureId!, "B");
    await admin.context.close();

    const { context, page } = await loggedIn(browser, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!, { width: 390, height: 844 });
    await page.goto("/officiating");
    const card = page.getByTestId("assignment-card").filter({ hasText: assignment.match.code });
    await expect(card).toContainText("10-17");
    await expect(card).toContainText("场地");
    await noHorizontalOverflow(page);
    await shot(page, "04-my-assignments-mobile");
    await card.getByRole("link", { name: "进入执裁" }).click();
    await expect(page).toHaveURL(`/officiating/${assignment.match.code}`);
    await expect(page.getByText(assignment.match.code).first()).toBeVisible();
    await shot(page, "05-workbench-from-schedule-mobile");
    await context.close();
  });

  test("裁判长现场看板与公开赛程", async ({ browser }) => {
    const { context, page } = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await page.goto(`/officiating/board/${slug}`);
    await expect(page.getByRole("heading", { name: /现场看板/ })).toBeVisible();
    await expect(page.getByTestId("schedule-rows-published").getByTestId("schedule-row")).toHaveCount(30);
    await expect(page.getByTestId("schedule-rows-published")).toContainText("待开赛");
    await shot(page, "06-chief-board");

    await ok(await page.request.post(`${api}/publish`));
    await page.goto(`/public/${slug}/schedule?date=2026-10-17`);
    await expect(page.getByText("数学科学学院").first()).toBeVisible();
    await expect(page.getByText("预计").first()).toBeVisible();
    await shot(page, "07-public-schedule");
    await context.close();
  });
});

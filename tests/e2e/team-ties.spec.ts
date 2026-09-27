import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

/**
 * 阶段 4-D：团体赛报项、出场名单盲交、对抗胜负、积分榜与名次确认，在浏览器里走完整链路。
 *
 * 截图默认写入未提交的 `local-run/`；固化证据时显式设 `PHASE4D_SHOT_DIR=shots`。
 */
const shotDir = path.join(process.cwd(), "artifacts", "phase4d-team-ties", process.env.PHASE4D_SHOT_DIR ?? "local-run");
const RUN = randomBytes(3).toString("hex");
const slug = `e2e-4d-${RUN}`;
const managerEmail = `e2e-4d-mgr-${RUN}@example.invalid`;
const managerPassword = `Ties-${RUN}-Strong-Pass!`;
const api = `/api/admin/tournaments/${slug}`;
let studentSeq = 0;
let commandSeq = 0;
let mathTeamId = "";

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
  await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true, mask: [page.getByTestId("initial-password")] });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

function rosterRows(short: string) {
  const id = () => `F${RUN}${String(++studentSeq).padStart(3, "0")}`.toUpperCase();
  return [
    { displayName: `${short}男1`, studentId: id(), gender: "MALE", rubberKinds: ["MS", "MD"] },
    { displayName: `${short}男2`, studentId: id(), gender: "MALE", rubberKinds: ["MD", "XD"] },
    { displayName: `${short}男3`, studentId: id(), gender: "MALE", rubberKinds: ["MS", "XD"] },
    { displayName: `${short}女1`, studentId: id(), gender: "FEMALE", rubberKinds: ["WS", "WD"] },
    { displayName: `${short}女2`, studentId: id(), gender: "FEMALE", rubberKinds: ["WD", "XD"] },
    { displayName: `${short}女3`, studentId: id(), gender: "FEMALE", rubberKinds: ["WS", "XD"] },
  ];
}

async function ok<T = unknown>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  if (!response.ok()) throw new Error(`${response.url()} → ${response.status()} ${await response.text()}`);
  return (await response.json()) as T;
}

interface ControlGrant {
  sessionId: string;
  takeoverGeneration: number;
  controlToken: string;
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

function envelope(control: { sessionId: string; takeoverGeneration: number }, expectedVersion: number, type: string, payload: unknown) {
  commandSeq += 1;
  return {
    commandId: randomUUID(),
    occurredAt: new Date(Date.UTC(2026, 9, 18, 1, 0, commandSeq)).toISOString(),
    expectedVersion,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type,
    payload,
  };
}

/** 通过真实计分接口以弃权结果走完一个小场：主裁判记录并提交，裁判长接管复核锁定。 */
async function finishRubber(referee: APIRequestContext, chief: APIRequestContext, matchCode: string, winnerSide: "A" | "B") {
  const control = await ok<ControlGrant>(await referee.post(`/api/matches/${matchCode}/control`, { data: { deviceSessionId: randomUUID() } }));
  const send = async (request: APIRequestContext, session: ControlGrant, version: number, type: string, payload: unknown) =>
    ok<{ version: number }>(
      await request.post(`/api/matches/${matchCode}/commands`, {
        data: envelope(session, version, type, payload),
        headers: { authorization: `Bearer ${session.controlToken}` },
      }),
    );
  let result = await send(referee, control, 0, "RECORD_SPECIAL_OUTCOME", { type: "WO", winnerSide, reason: "对方未到" });
  result = await send(referee, control, result.version, "SUBMIT_RESULT", { reason: "提交弃权结果" });
  const takeover = await ok<ControlGrant>(await chief.post(`/api/matches/${matchCode}/control/takeover`, { data: { deviceSessionId: randomUUID(), reason: "复核结果" } }));
  await send(chief, takeover, result.version, "CONFIRM_RESULT", { reason: "复核通过" });
}

test.describe.serial("阶段 4-D 团体对抗：出场名单与对抗胜负", () => {
  // 整条链路含开发服务器首次编译新页面，以及 30 个小场经真实计分接口锁定，默认 30 秒不够。
  test.describe.configure({ timeout: 180_000 });
  test.beforeAll(() => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  });

  test.afterAll(async () => {
    const demoEmails = [process.env.DEMO_ADMIN_EMAIL, process.env.DEMO_REFEREE_EMAIL].filter((email): email is string => Boolean(email));
    await prisma.session.deleteMany({ where: { user: { email: { in: demoEmails } } } });
    await prisma.user.deleteMany({ where: { email: managerEmail } });
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

  test("负责人在手机上提交名单：每名队员勾选报项，报项人数不够时逐条报错", async ({ browser }) => {
    const admin = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    await ok(
      await admin.page.request.post("/api/admin/tournaments", {
        data: {
          slug,
          name: "阳光体育羽毛球联赛 对抗端到端",
          startDate: "2026-10-17",
          endDate: "2026-10-25",
          timezone: "Asia/Shanghai",
          namePolicy: "CODES_ONLY",
          rulePreset: "traditional-21",
          competitions: [{ kind: "TEAM", code: "TEAM", name: "学院团体赛" }],
        },
      }),
    );
    await ok(await admin.page.request.post(`${api}/phase`, { data: { to: "REGISTRATION_OPEN" } }));
    const team = await ok<{ id: string }>(await admin.page.request.post(`${api}/teams`, { data: { name: "数学科学学院" } }));
    mathTeamId = team.id;
    const provisioned = await ok<{ initialPassword: string }>(await admin.page.request.post(`${api}/teams/${team.id}/managers`, { data: { email: managerEmail, name: "数学院领队" } }));
    await admin.context.close();

    const manager = await loggedIn(browser, managerEmail, provisioned.initialPassword, { width: 390, height: 844 });
    await ok(await manager.page.request.post("/api/account/password", { data: { currentPassword: provisioned.initialPassword, newPassword: managerPassword } }));
    const { page } = manager;
    await page.goto(`/team/${slug}`);
    await expect(page.getByRole("heading", { name: "数学科学学院" })).toBeVisible();

    const members = rosterRows("数学");
    for (const [index, member] of members.entries()) {
      if (index >= 4) await page.getByRole("button", { name: "＋ 添加队员" }).click();
      await page.getByLabel(`第 ${index + 1} 名队员姓名`).fill(member.displayName);
      await page.getByLabel(`第 ${index + 1} 名队员学号`).fill(member.studentId);
      await page.getByLabel(`第 ${index + 1} 名队员性别`).selectOption(member.gender);
    }
    // 男队员只能勾男单/男双/混双；只给前两名男队员报男单，男双报项人数不够。
    const kinds = (index: number) => page.getByRole("group", { name: `第 ${index + 1} 名队员报项` });
    await expect(kinds(0).getByRole("checkbox")).toHaveCount(3);
    await expect(kinds(0).getByLabel("女单")).toHaveCount(0);
    await kinds(0).getByLabel("男单").check();
    await kinds(1).getByLabel("男单").check();
    await kinds(1).getByLabel("混双").check();
    await kinds(2).getByLabel("男双").check();
    for (const index of [3, 4, 5]) {
      for (const label of members[index].rubberKinds.map((kind) => ({ WS: "女单", WD: "女双", XD: "混双" })[kind] as string)) {
        await kinds(index).getByLabel(label).check();
      }
    }
    await page.getByRole("button", { name: "提交名单" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "名单未提交" })).toContainText("报「男双」的队员至少 2 人，当前 1 人");
    await kinds(0).getByLabel("男双").check();
    await expect(page.getByTestId("roster-count")).toContainText("男双 2");
    await page.getByRole("button", { name: "提交名单" }).click();
    await expect(page.getByRole("status").filter({ hasText: "回执编号" })).toContainText("名单已提交");
    await noHorizontalOverflow(page);
    await shot(page, "01-roster-events-mobile");
    const stored = await prisma.registrationMember.findMany({ where: { registration: { teamId: mathTeamId } }, orderBy: { slot: "asc" } });
    expect(stored.map((member) => member.rubberKinds)).toEqual([["MS", "MD"], ["MS", "XD"], ["MD"], ["WS", "WD"], ["WD", "XD"], ["WS", "XD"]]);
    await manager.context.close();
  });

  test("管理员审核、再代录 3 个学院，截止报名并发布单循环抽签", async ({ browser }) => {
    const { context, page } = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    const competition = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug } } });
    const math = await prisma.registration.findFirstOrThrow({ where: { teamId: mathTeamId } });
    await ok(await page.request.post(`${api}/registrations/${math.id}/review`, { data: { action: "APPROVE", expectedVersion: math.version } }));
    for (const [name, short] of [["物理学院", "物理"], ["化学学院", "化学"], ["外国语学院", "外语"]]) {
      const team = await ok<{ id: string }>(await page.request.post(`${api}/teams`, { data: { name } }));
      const roster = await ok<{ registrationId: string }>(await page.request.post(`${api}/teams/${team.id}/roster`, { data: { competitionId: competition.id, members: rosterRows(short) } }));
      await ok(await page.request.post(`${api}/registrations/${roster.registrationId}/review`, { data: { action: "APPROVE", expectedVersion: 0 } }));
    }
    await ok(await page.request.post(`${api}/phase`, { data: { to: "REGISTRATION_CLOSED" } }));
    const draft = await ok<{ drawId: string }>(await page.request.post(`${api}/competitions/TEAM/draws`, { data: { format: "ROUND_ROBIN" } }));
    await ok(await page.request.post(`${api}/competitions/TEAM/draws/${draft.drawId}/publish`, { data: { confirm: true } }));
    // 裁判排班属于 4-C，这里直接写入本赛事的裁判员与裁判长角色。
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug } });
    const referee = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL! } });
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL! } });
    await prisma.roleAssignment.createMany({
      data: [
        { userId: referee.id, tournamentId: tournament.id, role: "REFEREE" },
        { userId: admin.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
      ],
    });
    await expect(prisma.fixture.count({ where: { competitionId: competition.id } })).resolves.toBe(6);
    await context.close();
  });

  test("负责人盲交出场名单：只能选报了该项的队员，提交后看不到对方名单", async ({ browser }) => {
    const { context, page } = await loggedIn(browser, managerEmail, managerPassword, { width: 390, height: 844 });
    await page.goto(`/team/${slug}`);
    const ties = page.getByTestId("manager-ties").getByRole("listitem");
    await expect(ties).toHaveCount(3);
    await expect(ties.first()).toContainText("本队尚未提交出场名单");
    await noHorizontalOverflow(page);
    await shot(page, "02-manager-ties-mobile");

    await ties.first().getByRole("link", { name: "排出场名单" }).click();
    await expect(page.getByTestId("lineup-editor")).toBeVisible();
    // 男单只列出报了男单的两名男队员。
    const ms = page.getByLabel("第 1 场男单队员");
    await expect(ms.locator("option")).toHaveText(["请选择", "数学男1", "数学男2"]);
    await ms.selectOption({ label: "数学男1" });
    await page.getByLabel("第 2 场女单队员").selectOption({ label: "数学女1" });
    await page.getByLabel("第 3 场男双队员 1").selectOption({ label: "数学男1" });
    await page.getByLabel("第 3 场男双队员 2").selectOption({ label: "数学男3" });
    await page.getByLabel("第 4 场女双队员 1").selectOption({ label: "数学女1" });
    await page.getByLabel("第 4 场女双队员 2").selectOption({ label: "数学女2" });
    await page.getByLabel("第 5 场混双男").selectOption({ label: "数学男2" });
    await page.getByLabel("第 5 场混双女").selectOption({ label: "数学女3" });
    await expect(page.getByTestId("lineup-multi")).toContainText("数学男1 2 场");
    await page.getByRole("button", { name: "提交出场名单" }).click();
    await expect(page.getByRole("status").filter({ hasText: "出场名单已提交" })).toContainText("对方提交前，双方互相看不到名单");
    await expect(page.getByTestId("lineup-progress")).toContainText("已提交（第 1 版）");
    const table = page.getByTestId("rubber-table");
    await expect(table).toContainText("数学男1");
    // 对方尚未提交：只显示状态，没有任何对方队员姓名。
    await expect(table).toContainText("未提交");
    await noHorizontalOverflow(page);
    await shot(page, "03-lineup-submitted-mobile");
    await context.close();
  });

  test("后台交齐前只看提交状态；管理员代交另一方后双方名单同时公开并锁定", async ({ browser }) => {
    const { context, page } = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    const fixture = await prisma.fixture.findFirstOrThrow({
      where: { competition: { tournament: { slug } }, lineups: { some: {} } },
      include: { sideAEntry: true, sideBEntry: true },
    });
    const otherSide = fixture.sideAEntry?.teamId === mathTeamId ? "B" : "A";
    const other = otherSide === "A" ? fixture.sideAEntry : fixture.sideBEntry;
    await page.goto(`/management/${slug}/ties`);
    await expect(page.getByTestId("tie-competition-row")).toContainText("6");
    await page.getByRole("link", { name: "进入" }).click();
    await page.getByTestId("ties-GROUP").getByRole("listitem").filter({ hasText: fixture.code }).getByRole("link", { name: "详情" }).click();
    await expect(page.getByTestId("lineup-progress")).toContainText("已提交（第 1 版）");
    const table = page.getByTestId("rubber-table");
    await expect(table).toContainText("已提交，未公开");
    await expect(table).not.toContainText("数学男1");
    await shot(page, "04-admin-blind-status");

    // 代交另一方（用界面逐项选择）。
    const proxy = page.locator("details").filter({ has: page.locator("summary", { hasText: `代 ${other?.displayName} 提交` }) });
    await proxy.locator("summary").click();
    // 名单队员名前缀与建队时一致（外国语学院用「外语」）；抽签随机决定对手，不能靠去掉「学院」推算。
    const short = ({ 物理学院: "物理", 化学学院: "化学", 外国语学院: "外语" } as Record<string, string>)[other?.displayName ?? ""] ?? "";
    await proxy.getByLabel("第 1 场男单队员").selectOption({ label: `${short}男1` });
    await proxy.getByLabel("第 2 场女单队员").selectOption({ label: `${short}女3` });
    await proxy.getByLabel("第 3 场男双队员 1").selectOption({ label: `${short}男1` });
    await proxy.getByLabel("第 3 场男双队员 2").selectOption({ label: `${short}男2` });
    await proxy.getByLabel("第 4 场女双队员 1").selectOption({ label: `${short}女1` });
    await proxy.getByLabel("第 4 场女双队员 2").selectOption({ label: `${short}女2` });
    await proxy.getByLabel("第 5 场混双男").selectOption({ label: `${short}男3` });
    await proxy.getByLabel("第 5 场混双女").selectOption({ label: `${short}女2` });
    await proxy.getByRole("button", { name: `代 ${other?.displayName} 提交` }).click();
    await expect(page.getByTestId("lineup-progress")).toContainText("双方名单已公开并锁定");
    await expect(table).toContainText("数学男1");
    await expect(table).toContainText(`${short}男1 / ${short}男2`);
    await shot(page, "05-lineups-revealed");

    // 裁判长从小场编号进入执裁台：显示第几场什么小场与上场队员。
    const rubber = await prisma.match.findFirstOrThrow({ where: { fixtureId: fixture.id, rubberOrder: 5 } });
    await table.getByRole("link", { name: rubber.code }).click();
    await expect(page).toHaveURL(`/officiating/${rubber.code}`);
    await expect(page.getByText("第 5 场混双").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "权威比赛场地与比分" })).toContainText("数学科学学院");
    await page.getByText("查看全名、代表队与发球区说明").click();
    await expect(page.getByText("数学男2 / 数学女3").filter({ visible: true }).first()).toBeVisible();
    await shot(page, "06-officiating-rubber");
    await context.close();
  });

  test("小场结果锁定后计入对抗胜负；全部结束后积分榜须抽签，由裁判长确认名次", async ({ browser }) => {
    const admin = await loggedIn(browser, process.env.DEMO_ADMIN_EMAIL!, process.env.DEMO_ADMIN_PASSWORD!);
    const referee = await loggedIn(browser, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    const refereeUser = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL! } });
    const fixtures = await prisma.fixture.findMany({
      where: { competition: { tournament: { slug } } },
      orderBy: [{ round: "asc" }, { sequence: "asc" }],
      include: { matches: { orderBy: { rubberOrder: "asc" } }, sideAEntry: true, sideBEntry: true },
    });
    // 数学、物理、化学循环相克（各 3:2），三队都赢外国语学院 → 三队各项相同，须抽签。
    const rank = ["数学科学学院", "物理学院", "化学学院"];
    const beats = (winner: string, loser: string) =>
      loser === "外国语学院" || (rank.includes(winner) && rank.includes(loser) && (rank.indexOf(winner) + 1) % 3 === rank.indexOf(loser));
    for (const fixture of fixtures) {
      const lineups = await prisma.fixtureLineup.findMany({ where: { fixtureId: fixture.id } });
      for (const side of ["A", "B"] as const) {
        if (!lineups.some((lineup) => lineup.side === side)) await proxyLineup(admin.page.request, fixture.id, side);
      }
      await prisma.officialAssignment.createMany({ data: fixture.matches.map((match) => ({ matchId: match.id, userId: refereeUser.id })) });
      const winner = beats(fixture.sideAEntry?.displayName as string, fixture.sideBEntry?.displayName as string) ? "A" : "B";
      const loser = winner === "A" ? "B" : "A";
      const pattern = [winner, winner, loser, winner, loser] as const;
      for (const [index, match] of fixture.matches.entries()) {
        await finishRubber(referee.page.request, admin.page.request, match.code, pattern[index]);
      }
    }
    await referee.context.close();

    const { page } = admin;
    await page.goto(`/management/${slug}/ties/TEAM`);
    const standings = page.getByTestId("standings");
    await expect(standings).toContainText("本组对抗全部结束，待裁判长确认名次");
    // 每场都是 3:2：外国语学院三战全负，小场 6-9；其余三队各 8-7。
    await expect(standings.getByRole("row").filter({ hasText: "外国语学院" })).toContainText("6-9");
    await expect(standings).toContainText("须抽签");
    await expect(page.getByText("有名次无法由成绩区分，须抽签决定")).toBeVisible();
    await shot(page, "07-standings-lots");

    // 按抽签结果把第 1 位下移一位，写明抽签情况后确认。
    const firstRow = page.locator("ol").filter({ hasText: "1. " }).getByRole("listitem").first();
    const firstName = (await firstRow.textContent())?.replace(/^1\.\s*/, "").replace(/上移|下移/g, "").trim() ?? "";
    await page.getByRole("button", { name: `下移 ${firstName}` }).click();
    await page.getByRole("button", { name: "确认循环赛名次" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "抽签" })).toContainText("写明抽签");
    await page.getByLabel("抽签情况（必填，记入审计）").fill("三队各项相同，裁判长 10 月 25 日赛后当场抽签，三队领队见证");
    await page.getByRole("button", { name: "确认循环赛名次" }).click();
    await expect(standings).toContainText("名次已由裁判长确认");
    await expect(standings.getByRole("row").nth(2)).toContainText(firstName);
    await expect(standings.getByRole("row").nth(4)).toContainText("外国语学院");
    await shot(page, "08-standings-confirmed");
    const group = await prisma.group.findFirstOrThrow({ where: { stage: { competition: { tournament: { slug } } } } });
    expect(group.rankingConfirmedAt).not.toBeNull();

    // 手机端：负责人查看已结束的对抗。
    await admin.context.close();
    const manager = await loggedIn(browser, managerEmail, managerPassword, { width: 390, height: 844 });
    await manager.page.goto(`/team/${slug}`);
    await manager.page.getByTestId("manager-ties").getByRole("link", { name: "查看" }).first().click();
    await expect(manager.page.getByTestId("tie-header")).toContainText("已结束");
    await expect(manager.page.getByTestId("rubber-table")).toContainText("弃权");
    await noHorizontalOverflow(manager.page);
    await shot(manager.page, "09-manager-tie-result-mobile");
    await manager.context.close();
  });
});

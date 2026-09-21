import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import type { MatchState } from "../../src/domain/rules/match-engine";

/**
 * 裁判工作台场地化改造的前后截图证据。
 *
 * 同一份脚本用 REFEREE_SHOT_DIR 切换输出目录：改造前跑 `before`，改造后跑 `after`，
 * 以保证两组截图的视口、比赛状态和数据完全一致。
 * 浏览器设备模拟不等于真机测试。
 */
const SHOT_DIR = process.env.REFEREE_SHOT_DIR ?? "after";
const OUT_ROOT = path.join(process.cwd(), "artifacts", "referee-court-v2", SHOT_DIR);

const VIEWPORTS = [
  { key: "phone-390x844", width: 390, height: 844 },
  { key: "tablet-820x1180", width: 820, height: 1180 },
  { key: "tablet-landscape-1180x820", width: 1180, height: 820 },
  { key: "desktop-1440x1000", width: 1440, height: 1000 },
  { key: "narrow-320x720", width: 320, height: 720 },
] as const;

const LONG_NAMES = {
  entryA: "计算机科学与技术学院男子双打代表队甲组",
  entryB: "光电科学与工程学院男子双打代表队乙组",
  players: [
    "欧阳明宇轩",
    "司马长卿文远",
    "诸葛云飞扬",
    "上官婉清照",
  ],
} as const;

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("登录邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL("/");
}

async function resetMatches() {
  const matches = await prisma.match.findMany({
    where: { code: { in: ["MS-DEMO-001", "MD-DEMO-002"] } },
    select: { id: true },
  });
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

async function readState(request: APIRequestContext, matchCode: string) {
  const response = await request.get(`/api/matches/${matchCode}/state`);
  expect(response.status()).toBe(200);
  return (await response.json()).state as MatchState;
}

async function readBrowserControl(page: Page, matchCode: string) {
  // 取得控制权是异步写入；轮询到 sessionStorage 落盘为止，不靠按钮文案判断。
  await expect
    .poll(
      () => page.evaluate((code) => sessionStorage.getItem(`badminton-control:${code}`), matchCode),
      { message: "浏览器必须已取得写入控制", timeout: 15_000 },
    )
    .not.toBeNull();
  const raw = await page.evaluate((code) => sessionStorage.getItem(`badminton-control:${code}`), matchCode);
  return JSON.parse(raw!) as { controlToken: string; sessionId: string; takeoverGeneration: number };
}

/** 通过真实 HTTP 把比赛推进到指定状态，避免截图停留在开局草稿。 */
async function driveMatch(
  request: APIRequestContext,
  matchCode: string,
  control: { controlToken: string; sessionId: string; takeoverGeneration: number },
  rallies: readonly ("A" | "B")[],
) {
  let state = await readState(request, matchCode);
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
    state = (await response.json()).state as MatchState;
    return state;
  };

  if (state.phase === "AWAITING_COIN_TOSS") {
    await send("RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: "A",
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    });
  }
  if (state.phase === "AWAITING_OPENING_SETUP") {
    const courts = state.format === "DOUBLES"
      ? { A: { R: state.players.A[0], L: state.players.A[1] }, B: { R: state.players.B[0], L: state.players.B[1] } }
      : null;
    await send("CONFIRM_OPENING_SETUP", {
      serverPlayerId: state.players.A[0],
      receiverPlayerId: state.players.B[0],
      logicalCourts: courts,
    });
  }
  for (const winner of rallies) {
    await send("RALLY_WON", { side: winner });
  }
  return state;
}

async function shoot(page: Page, scenario: string, viewportKeys: readonly string[]) {
  mkdirSync(OUT_ROOT, { recursive: true });
  // 仅用于截图：Playwright 的 fullPage 捕获会把 position:fixed 的「跳到主要内容」
  // 跳转链接重新按整页高度排版，从而画进截图。实测该链接本身位于 y=-55、未获焦点，
  // 属于捕获方式造成的假象而不是页面缺陷，因此只在取证时隐藏，不改动产品样式。
  await page.addStyleTag({ content: ".skip-link { display: none !important; }" });
  for (const key of viewportKeys) {
    const viewport = VIEWPORTS.find((item) => item.key === key);
    if (!viewport) throw new Error(`未知视口 ${key}`);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // 让响应式断点与字体换行稳定下来，避免截到布局中间态。
    await expect(page.getByTestId("badminton-court")).toBeVisible();
    // 截图只记录布局，不记录焦点态；否则「跳到主要内容」等焦点样式会盖住场地。
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.waitForTimeout(350);
    await page.screenshot({
      path: path.join(OUT_ROOT, `${scenario}-${viewport.key}.png`),
      fullPage: true,
    });
  }
}

async function openWorkbenchWithControl(page: Page, matchCode: string) {
  await page.goto(`/officiating/${matchCode}`);
  const acquire = page.getByRole("button", { name: "取得本机控制权" });
  await expect(acquire).toBeEnabled();
  await acquire.click();
  await expect(page.getByTestId("badminton-court")).toBeVisible();
  return readBrowserControl(page, matchCode);
}

test.describe.serial(`裁判工作台改造截图证据（${SHOT_DIR}）`, () => {
  test.beforeEach(resetMatches);
  test.afterEach(resetMatches);

  test("双打进行中：五个视口", async ({ page }) => {
    const matchCode = "MD-DEMO-002";
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    const control = await openWorkbenchWithControl(page, matchCode);
    await driveMatch(page.context().request, matchCode, control, ["A", "A", "B", "B", "A"]);
    await expect(page.locator(".court-score-number").first()).toHaveText("3");
    await expect(page.getByTestId("badminton-court").locator('[data-role="SERVER"]')).toHaveCount(1);
    await shoot(page, "doubles-inprogress", VIEWPORTS.map((item) => item.key));
  });

  test("单打进行中：手机与桌面", async ({ page }) => {
    const matchCode = "MS-DEMO-001";
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    const control = await openWorkbenchWithControl(page, matchCode);
    await driveMatch(page.context().request, matchCode, control, ["A", "A", "A", "A", "B", "B", "B"]);
    await expect(page.locator(".court-score-number").first()).toHaveText("4");
    await shoot(page, "singles-inprogress", ["phone-390x844", "desktop-1440x1000"]);
  });

  test("双打长姓名与长代表队名：手机与桌面", async ({ page }) => {
    const matchCode = "MD-DEMO-002";
    const match = await prisma.match.findUniqueOrThrow({
      where: { code: matchCode },
      select: {
        sideAEntryId: true,
        sideBEntryId: true,
        sideAEntry: { select: { displayName: true, members: { orderBy: { slot: "asc" }, select: { participantId: true } } } },
        sideBEntry: { select: { displayName: true, members: { orderBy: { slot: "asc" }, select: { participantId: true } } } },
      },
    });
    const participantIds = [...match.sideAEntry!.members, ...match.sideBEntry!.members].map((item) => item.participantId);
    const original = await prisma.participant.findMany({
      where: { id: { in: participantIds } },
      select: { id: true, displayName: true },
    });
    const originalEntryNames = {
      a: match.sideAEntry!.displayName,
      b: match.sideBEntry!.displayName,
    };

    try {
      await prisma.entry.update({ where: { id: match.sideAEntryId! }, data: { displayName: LONG_NAMES.entryA } });
      await prisma.entry.update({ where: { id: match.sideBEntryId! }, data: { displayName: LONG_NAMES.entryB } });
      for (const [index, participantId] of participantIds.entries()) {
        await prisma.participant.update({
          where: { id: participantId },
          data: { displayName: LONG_NAMES.players[index] ?? LONG_NAMES.players[0] },
        });
      }

      await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
      const control = await openWorkbenchWithControl(page, matchCode);
      await driveMatch(page.context().request, matchCode, control, ["A", "B"]);
      await expect(page.getByTestId("badminton-court")).toContainText(LONG_NAMES.players[0]);
      await shoot(page, "doubles-longnames", ["phone-390x844", "desktop-1440x1000"]);
    } finally {
      // 夹具只在 _test 库内临时改名，跑完逐字复原，不改动 prisma/seed.ts。
      await prisma.entry.update({ where: { id: match.sideAEntryId! }, data: { displayName: originalEntryNames.a } });
      await prisma.entry.update({ where: { id: match.sideBEntryId! }, data: { displayName: originalEntryNames.b } });
      for (const participant of original) {
        await prisma.participant.update({ where: { id: participant.id }, data: { displayName: participant.displayName } });
      }
    }
  });

  test("双打待首发确认草稿态：手机", async ({ page }) => {
    const matchCode = "MD-DEMO-002";
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await openWorkbenchWithControl(page, matchCode);
    await page.getByRole("button", { name: "A 方胜并选先发" }).click();
    await expect(page.getByRole("button", { name: "确认首局设置并开赛" })).toBeVisible();
    await shoot(page, "doubles-draft-setup", ["phone-390x844", "desktop-1440x1000"]);
  });

  test("双打只读（未取得控制权）：手机", async ({ page }) => {
    const matchCode = "MD-DEMO-002";
    await login(page, process.env.DEMO_REFEREE_EMAIL!, process.env.DEMO_REFEREE_PASSWORD!);
    await page.goto(`/officiating/${matchCode}`);
    await expect(page.getByTestId("badminton-court")).toBeVisible();
    await expect(page.getByRole("button", { name: "取得本机控制权" })).toBeVisible();
    await shoot(page, "doubles-readonly", ["phone-390x844", "desktop-1440x1000"]);
  });
});

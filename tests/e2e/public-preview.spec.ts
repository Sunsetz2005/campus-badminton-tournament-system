import { expect, test } from "@playwright/test";

const schedulePath = "/public/preview/autumn-campus-2026/schedule";

test.describe("UI-01-B 公开赛程与比赛详情隔离预览", () => {
  test("筛选写入 URL、详情返回恢复，并且不请求认证或业务 API", async ({ page }) => {
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) apiRequests.push(url.pathname);
    });

    await page.goto(`${schedulePath}?date=2026-10-14`);
    await expect(page.getByText("模拟数据 · 界面预览", { exact: true }).first()).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    await page.getByLabel("项目").selectOption("MD");
    await expect(page).toHaveURL(/competition=MD/);
    await page.getByLabel("搜索允许公开的姓名、编号或代表队").fill("唐屿");
    await page.getByRole("button", { name: "搜索" }).click();
    await expect(page).toHaveURL(/q=%E5%94%90%E5%B1%BF/);
    await expect(page.getByText("共 1 场比赛")).toBeVisible();
    await expect(page.getByText("沈砚／唐屿").first()).toBeVisible();

    await page.getByRole("link", { name: "查看 MD-P201 比赛详情" }).click();
    await expect(page).toHaveURL(/matches\/MD-P201.*competition=MD.*q=/);
    await expect(page.getByRole("heading", { name: "逐局比分" })).toBeVisible();
    await expect(page.getByText("正式结果")).toBeVisible();
    await page.getByRole("link", { name: /返回每日赛程/ }).click();
    await expect(page).toHaveURL(/schedule.*competition=MD.*q=/);
    await expect(page.getByText("共 1 场比赛")).toBeVisible();

    expect(apiRequests).toEqual([]);
  });

  test("加载、空日程、无筛选结果、失败、过期和详情不存在均可区分", async ({ page }) => {
    await page.goto(`${schedulePath}?date=2026-10-14&scenario=loading`);
    await expect(page.getByLabel("正在加载赛程")).toBeVisible();

    await page.goto(`${schedulePath}?date=2026-10-14&scenario=error`);
    await expect(page.getByRole("heading", { name: "暂时无法读取赛程" })).toBeVisible();
    await expect(page.getByRole("link", { name: "重新读取模拟数据" })).toBeVisible();

    await page.goto(`${schedulePath}?date=2026-10-14&scenario=stale`);
    await expect(page.getByText("连接中断 · 数据可能过期", { exact: true })).toBeVisible();
    await expect(page.getByText("共 8 场比赛")).toBeVisible();

    await page.goto(`${schedulePath}?date=2026-10-14&scenario=empty`);
    await expect(page.getByRole("heading", { name: "这一天暂未安排比赛" })).toBeVisible();

    await page.goto(`${schedulePath}?date=2026-10-14&q=%E4%B8%8D%E5%AD%98%E5%9C%A8`);
    await expect(page.getByRole("heading", { name: "没有符合条件的比赛" })).toBeVisible();

    const missingResponse = await page.goto("/public/preview/autumn-campus-2026/matches/UNKNOWN");
    expect(missingResponse?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "找不到这场模拟比赛" })).toBeVisible();
  });

  test("非法日期不静默换日，未知筛选被规范化移除", async ({ page }) => {
    await page.goto(`${schedulePath}?date=2099-01-01&competition=UNKNOWN&lifecycle=SUSPENDED,IN_PROGRESS,SUSPENDED`);
    await expect(page.getByRole("heading", { name: "该日期不在赛事日程中" })).toBeVisible();
    await expect(page.getByText(/无效日期会要求重新选择/)).toBeVisible();
    await page.getByRole("link", { name: "选择赛事默认日期" }).click();
    await expect(page).toHaveURL(/date=2026-10-14/);
    await expect(page).not.toHaveURL(/competition=UNKNOWN/);
    await expect(page).toHaveURL(/lifecycle=IN_PROGRESS%2CSUSPENDED/);
  });

  test("连续快速修改筛选不会丢失先前条件", async ({ page }) => {
    await page.route("**/public/preview/**", async (route) => {
      if (route.request().headers().rsc === "1") await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    });
    await page.goto(`${schedulePath}?date=2026-10-14`);
    await page.getByLabel("项目").selectOption("MD");
    await page.getByLabel("比赛状态").selectOption("IN_PROGRESS");
    await expect(page).toHaveURL(/competition=MD/);
    await expect(page).toHaveURL(/lifecycle=IN_PROGRESS/);
  });

  test("特殊结果、目标验证态、长双打姓名和动态五局均可检查", async ({ page }) => {
    await page.goto(`${schedulePath}?date=2026-10-15`);
    await expect(page.getByText("共 5 场比赛")).toBeVisible();
    await expect(page.getByText("欧阳予安／司徒清嘉").first()).toBeVisible();
    await expect(page.getByRole("row", { name: /XD-P401/ }).getByText("弃权", { exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: /MS-P402/ }).getByText("取消资格", { exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: /WS-P403/ }).getByText("比赛中止", { exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: /WD-P404/ }).getByText("轮空", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "查看 XD-P405 比赛详情" }).click();
    await expect(page.locator("aside").getByText("已被新版本替代", { exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "第5局" })).toBeVisible();
  });

  test("手机卡片完整显示长双打姓名、逐局比分及分离的状态", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${schedulePath}?date=2026-10-15`);

    const longNameCard = page.getByRole("article", { name: /XD-P401/ });
    await expect(longNameCard.getByText("欧阳予安／司徒清嘉", { exact: true })).toBeVisible();
    await expect(longNameCard.getByText("上官知许／夏侯望舒", { exact: true })).toBeVisible();
    await expect(longNameCard.getByText(/晨曦联合代表队/)).toBeVisible();
    await expect(longNameCard.getByText(/远山联合代表队/)).toBeVisible();
    await expect(longNameCard.getByText("比赛进度", { exact: true })).toBeVisible();
    await expect(longNameCard.getByText("结果确认", { exact: true })).toBeVisible();

    const fiveGameCard = page.getByRole("article", { name: /XD-P405/ });
    await expect(fiveGameCard.locator("[data-game-status]")).toHaveCount(10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("桌面赛程保持等高扫描行、居中对阵和单行比分", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${schedulePath}?date=2026-10-14`);

    const table = page.getByRole("table", { name: /每日赛程/ });
    const rows = table.locator("tbody > tr");
    await expect(rows).toHaveCount(8);

    const heights = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    for (const height of heights) {
      expect(height).toBeGreaterThanOrEqual(70);
      expect(height).toBeLessThanOrEqual(84);
    }

    for (const row of await rows.all()) {
      await expect(row.locator("td").nth(5).locator(".status-badge")).toHaveCount(2);
      await expect(row.locator("td").nth(3).locator(":scope > div > div").first()).toHaveCSS("text-align", "right");
      await expect(row.locator("td").nth(3).locator(":scope > div > div").last()).toHaveCSS("text-align", /^(left|start)$/);
    }

    for (const code of ["XD-P301", "MS-P103", "MD-P205"]) {
      const scoreCell = page.getByRole("row", { name: new RegExp(code) }).locator("td").nth(4);
      await expect(scoreCell).toHaveText("未开始");
      await expect(scoreCell.locator("[data-game-status]")).toHaveCount(0);
    }
    await expect(page.getByRole("row", { name: /MS-P101/ }).locator("td").nth(4).locator("[data-game-status]")).toHaveCount(3);

    const titleSize = await page.getByRole("heading", { name: "每日赛程" }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(titleSize).toBeGreaterThanOrEqual(48);
    expect(titleSize).toBeLessThanOrEqual(56);
  });

  test("手机列表只保留一组进度和一组结果确认状态", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${schedulePath}?date=2026-10-14`);

    const cards = page.getByRole("article");
    await expect(cards).toHaveCount(8);
    for (const card of await cards.all()) {
      await expect(card.locator(".status-badge")).toHaveCount(2);
      await expect(card.getByText("比赛进度", { exact: true })).toBeVisible();
      await expect(card.getByText("结果确认", { exact: true })).toBeVisible();
    }
  });

  test("比赛详情用文字标出当前局，不依赖颜色推测", async ({ page }) => {
    await page.goto("/public/preview/autumn-campus-2026/matches/MS-P101?date=2026-10-14");
    await expect(page.getByRole("columnheader", { name: "第3局 当前局" })).toBeVisible();
  });

  test("特殊结果保留已发生比分，但停止局不会伪装成当前局", async ({ page }) => {
    await page.goto("/public/preview/autumn-campus-2026/matches/WS-P104?date=2026-10-14");
    await expect(page.getByRole("columnheader", { name: "第1局 本局停止" })).toBeVisible();
    await expect(page.getByText("当前局", { exact: true })).toHaveCount(0);
    await expect(page.getByText("12").first()).toBeVisible();
    await expect(page.getByText("17").first()).toBeVisible();
  });

  test("更多筛选支持 Escape 关闭并把焦点还给触发按钮", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${schedulePath}?date=2026-10-14`);
    const trigger = page.getByRole("button", { name: /更多筛选/ });
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.getByLabel("阶段").focus();
    await page.keyboard.press("Escape");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });

  test("公开预览导航恰有五项且四项未开放", async ({ page }) => {
    await page.goto(`${schedulePath}?date=2026-10-14`);

    const nav = page.getByRole("navigation", { name: "公开赛程导航" });
    const navItems = nav.locator(":scope > a, :scope > [aria-disabled='true']");
    await expect(navItems).toHaveCount(5);
    await expect(navItems).toHaveText([
      "每日赛程",
      "对阵与晋级 · 暂未开放",
      "小组排名 · 暂未开放",
      "最终名次 · 暂未开放",
      "成绩册 · 暂未开放",
    ]);
    await expect(nav.locator(":scope > a")).toHaveCount(1);
    await expect(nav.locator(":scope > span[aria-disabled='true']")).toHaveCount(4);
  });

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
  ]) {
    test(`公开预览导航在 ${viewport.width} 宽可触达且有横向滚动提示`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${schedulePath}?date=2026-10-14`);

      const focusableNavItems = page.locator(".topbar-preview a[href]");
      await expect(focusableNavItems).toHaveCount(2);
      for (const item of await focusableNavItems.all()) {
        expect((await item.boundingBox())?.height).toBeGreaterThanOrEqual(48);
      }

      const nav = page.getByRole("navigation", { name: "公开赛程导航" });
      const overflow = await nav.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
      expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
      await expect(page.getByText("导航可横向滚动", { exact: true })).toBeVisible();
    });
  }

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 820, height: 1180 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
    { width: 1440, height: 1000 },
  ]) {
    test(`赛程在 ${viewport.width}×${viewport.height} 无根级横向溢出`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(`${schedulePath}?date=2026-10-14`);
      await expect(page.getByText("共 8 场比赛")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ fullPage: true, path: testInfo.outputPath(`schedule-${viewport.width}x${viewport.height}.png`) });
    });
  }

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    test(`详情在 ${viewport.width}×${viewport.height} 保持动态局数且无根级横向溢出`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/public/preview/autumn-campus-2026/matches/MD-P205?date=2026-10-14");
      await expect(page.getByRole("columnheader", { name: "第5局" })).toBeVisible();
      await expect(page.getByText("未进行").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ fullPage: true, path: testInfo.outputPath(`detail-${viewport.width}x${viewport.height}.png`) });
    });
  }
});

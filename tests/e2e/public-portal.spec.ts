import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * 阶段 4-0 赛事门户：首页赛事列表 + 真实数据驱动的每日赛程与比赛详情。
 *
 * 与 `public-preview.spec.ts` 的分工：那一份用确定性虚构夹具覆盖加载 / 空 /
 * 失败 / 过期 / 五局 / 停止局等对着活数据库测不出来的边界态；
 * 这一份验证真实数据库投影、发布边界、导航收敛和响应式取证。
 */

const SLUG = "phase-1-demo";
const schedulePath = `/public/${SLUG}/schedule`;
const evidenceDir = path.join(process.cwd(), "artifacts", "phase4-portal");

test.describe.serial("阶段 4-0 赛事门户", () => {
  test("首页按生命周期分组列出赛事，并带海报与赛事信息", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "羽赛台" })).toBeVisible();

    for (const bucket of ["进行中", "即将开始", "已结束"]) {
      await expect(page.getByRole("heading", { level: 2, name: bucket, exact: true })).toBeVisible();
    }

    const row = page.getByRole("link", { name: /阶段 1 匿名模拟赛/ });
    await expect(row).toBeVisible();
    await expect(row.getByText("综合体育馆（模拟）")).toBeVisible();
    await expect(row.getByText(/2026年9月21日 — 2026年10月1日/)).toBeVisible();
    await expect(row.getByText(/\d+ 场已公开赛程/)).toBeVisible();
  });

  test("缺少海报时显示确定性占位卡，不加载外链资源", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith("http://127.0.0.1:3100")) external.push(request.url());
    });
    await page.goto("/");
    const fallback = page.locator(".tournament-poster-fallback").first();
    await expect(fallback).toBeVisible();
    // 占位卡完全由 CSS 渐变绘制；整页不得出现任何第三方请求。
    expect(external).toEqual([]);
  });

  test("从首页进入赛程再进入详情，返回时恢复原筛选", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /阶段 1 匿名模拟赛/ }).click();
    await expect(page).toHaveURL(new RegExp(`${schedulePath}$`));

    await page.goto(`${schedulePath}?date=2026-09-21&competition=MS`);
    await expect(page.getByText("共 7 场比赛")).toBeVisible();

    await page.getByRole("link", { name: "查看 MS-DONE-001 比赛详情" }).click();
    await expect(page).toHaveURL(/\/matches\/MS-DONE-001\?/);
    await expect(page.getByText("MS-DONE-001 · 男子单打 · 模拟小组赛 · A 组")).toBeVisible();

    await page.getByRole("link", { name: "← 返回每日赛程" }).click();
    await expect(page).toHaveURL(/date=2026-09-21/);
    await expect(page).toHaveURL(/competition=MS/);
    await expect(page.getByText("共 7 场比赛")).toBeVisible();
  });

  test("详情展示权威局分、真实起止时间和规则摘要，未进行局不补造比分", async ({ page }) => {
    await page.goto(`/public/${SLUG}/matches/MS-DONE-001`);
    await expect(page.getByText("2–0")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "第3局" })).toBeVisible();
    await expect(page.getByText("未进行").first()).toBeVisible();
    await expect(page.getByText("3 局 2 胜 · 每局 21 分 · 需净胜 2 分 · 封顶 30 分")).toBeVisible();
    await expect(page.getByText("正式结果")).toBeVisible();

    // 特殊结果保留真实比分，不补满目标分，也不伪装成常规完成。
    await page.goto(`/public/${SLUG}/matches/MD-DONE-002`);
    await expect(page.getByText("退赛").first()).toBeVisible();
  });

  test("未开放的公开入口显示暂未开放，不提供假链接", async ({ page }) => {
    await page.goto(schedulePath);
    const nav = page.getByRole("navigation", { name: "赛事公开导航" });
    for (const label of ["对阵与晋级", "小组排名", "最终名次", "成绩册"]) {
      await expect(nav.getByText(`${label} · 暂未开放`)).toBeVisible();
      await expect(nav.getByRole("link", { name: label })).toHaveCount(0);
    }
    await expect(nav.getByRole("link", { name: "每日赛程" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "现场看板" })).toBeVisible();
  });

  test("旧的 /board 地址重定向到进行中赛事的现场看板", async ({ page }) => {
    await page.goto("/board");
    await expect(page).toHaveURL(`/public/${SLUG}/board`);
    await expect(page.getByRole("heading", { name: "现场看板" })).toBeVisible();
  });

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 1000 },
  ]) {
    test(`首页与赛程在 ${viewport.width}×${viewport.height} 无根级横向溢出`, async ({ page }) => {
      const noOverflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

      await page.setViewportSize(viewport);

      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "羽赛台" })).toBeVisible();
      expect(await noOverflow(), `首页 ${viewport.width}`).toBe(true);
      await page.screenshot({ fullPage: true, path: path.join(evidenceDir, `home-${viewport.width}x${viewport.height}.png`) });

      await page.goto(`${schedulePath}?date=2026-09-21`);
      await expect(page.getByText(/共 \d+ 场比赛/)).toBeVisible();
      expect(await noOverflow(), `赛程 ${viewport.width}`).toBe(true);
      await page.screenshot({ fullPage: true, path: path.join(evidenceDir, `schedule-${viewport.width}x${viewport.height}.png`) });
    });
  }

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    test(`比赛详情在 ${viewport.width}×${viewport.height} 无根级横向溢出`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/public/${SLUG}/matches/MS-DONE-001`);
      await expect(page.getByText("逐局比分").first()).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
      await page.screenshot({ fullPage: true, path: path.join(evidenceDir, `detail-${viewport.width}x${viewport.height}.png`) });
    });
  }
});

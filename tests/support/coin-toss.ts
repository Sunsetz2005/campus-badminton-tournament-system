import { expect, type Page } from "@playwright/test";

import { prisma } from "../../src/db/client";
import { assertTestDatabaseUrl } from "../../src/db/database-safety";

/** 比赛复位到 0:0 时一并清掉系统抛币结果，否则旧结果会按版本 0 继续生效。 */
export const clearedCoinTossDraw = { coinTossDrawSide: null, coinTossDrawVersion: null, coinTossDrawnAt: null } as const;

/**
 * 系统抛币的胜方是服务端随机决定的。端到端用例需要确定的胜方，
 * 这里在隔离测试库里预置「本版本已抛出」的结果，再刷新工作台读取——与真实抛币后刷新页面的路径相同。
 */
export async function presetCoinTossWinner(page: Page, winner: "A" | "B") {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  const matchCode = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");
  // 刚点了「取得本机控制权」就刷新会打断请求，控制令牌没存进本机，刷新后只剩只读；先等令牌落地。
  await page.waitForFunction((code) => Boolean(window.sessionStorage.getItem(`badminton-control:${code}`)), matchCode);
  const match = await prisma.match.findUniqueOrThrow({ where: { code: matchCode }, select: { id: true, version: true } });
  await prisma.match.update({
    where: { id: match.id },
    data: { coinTossDrawSide: winner, coinTossDrawVersion: match.version, coinTossDrawnAt: new Date() },
  });
  await page.reload();
  await expect(page.getByTestId("coin-toss-winner")).toBeVisible();
  await expect(page.locator('input[name="coin-toss-category"]').first()).toBeEnabled();
}

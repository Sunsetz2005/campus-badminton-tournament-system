import type { Page } from "@playwright/test";

/** 示例裁判是平台共用裁判账号：取得控制前须登记本人姓名（O-2 / 方案 B2）。 */
export const E2E_OFFICIATING_NAME = "演示裁判";

/** 等「取得本机控制权」出现；需要姓名时先填写，再点击。具名账号没有姓名框，直接点击。 */
export async function acquireControl(page: Page, name = E2E_OFFICIATING_NAME) {
  const button = page.getByRole("button", { name: "取得本机控制权" });
  await button.waitFor();
  const field = page.getByLabel("执裁人姓名");
  if (await field.count()) await field.fill(name);
  await button.click();
}

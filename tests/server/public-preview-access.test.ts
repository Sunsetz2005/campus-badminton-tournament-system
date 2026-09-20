import { describe, expect, it } from "vitest";

import { isPublicUiPreviewEnabled } from "@/features/public-preview/access";

describe("公开端界面预览门禁", () => {
  it("只在非生产环境显式开启", () => {
    expect(isPublicUiPreviewEnabled({ NODE_ENV: "development", ENABLE_PUBLIC_UI_PREVIEW: "true" })).toBe(true);
    expect(isPublicUiPreviewEnabled({ NODE_ENV: "test", ENABLE_PUBLIC_UI_PREVIEW: "true" })).toBe(true);
    expect(isPublicUiPreviewEnabled({ NODE_ENV: "development", ENABLE_PUBLIC_UI_PREVIEW: "false" })).toBe(false);
    expect(isPublicUiPreviewEnabled({ NODE_ENV: "development" })).toBe(false);
  });

  it("生产环境即使设置开关也保持关闭", () => {
    expect(isPublicUiPreviewEnabled({ NODE_ENV: "production", ENABLE_PUBLIC_UI_PREVIEW: "true" })).toBe(false);
  });
});

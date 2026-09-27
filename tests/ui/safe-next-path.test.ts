import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/safe-next-path";

describe("登录后跳转地址", () => {
  it("保留站内相对路径", () => {
    expect(safeNextPath("/management")).toBe("/management");
    expect(safeNextPath("/public/demo/schedule?date=2026-10-14")).toBe("/public/demo/schedule?date=2026-10-14");
  });

  it("拒绝外站与协议相对地址，回到首页", () => {
    for (const value of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "", null, undefined]) {
      expect(safeNextPath(value)).toBe("/");
    }
  });
});

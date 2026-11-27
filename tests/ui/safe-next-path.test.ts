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

  it("拒绝靠控制字符或反斜杠绕过的外站地址", () => {
    // 浏览器解析时会丢弃制表符与换行：`/\t/evil.example` 等于 `//evil.example`。
    for (const value of ["/\t/evil.example", "/\n/evil.example", "/\r\n/evil.example", "/\t\\evil.example", "/a\\..\\..\\evil.example", "/\u0000/evil.example"]) {
      expect(safeNextPath(value)).toBe("/");
    }
  });
});

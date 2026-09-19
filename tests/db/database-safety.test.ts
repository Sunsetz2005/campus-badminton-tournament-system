import { describe, expect, it } from "vitest";

import { assertDemoSeedDatabase, assertTestDatabaseUrl, databaseNameFromUrl } from "@/db/database-safety";

describe("数据库隔离门禁", () => {
  it("只接受 *_test 自动化测试库", () => {
    expect(() => assertTestDatabaseUrl("postgresql://localhost/campus_test")).not.toThrow();
    expect(() => assertTestDatabaseUrl("postgresql://localhost/campus_prod")).toThrow("_test");
  });

  it("模拟种子只接受明确的开发库或测试库", () => {
    expect(() => assertDemoSeedDatabase("postgresql://localhost/badminton_tournament_dev")).not.toThrow();
    expect(() => assertDemoSeedDatabase("postgresql://localhost/badminton_tournament_test")).not.toThrow();
    expect(() => assertDemoSeedDatabase("postgresql://localhost/school_live")).toThrow("模拟种子");
  });

  it("准确解析数据库名", () => {
    expect(databaseNameFromUrl("postgresql://localhost/example_test?schema=public")).toBe("example_test");
  });

  it("缺少测试环境时给出可执行的中文指引", () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow("请先按 .env.test.example 创建 .env.test");
  });
});

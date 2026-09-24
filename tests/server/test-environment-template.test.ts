import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const templatePath = path.join(root, ".env.test.example");

function environmentKeys(source: string) {
  return new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((key): key is string => Boolean(key)),
  );
}

describe("测试环境模板", () => {
  it("提供可跟踪的 .env.test.example 与全部必需键", () => {
    expect(existsSync(templatePath), "缺少 .env.test.example").toBe(true);
    if (!existsSync(templatePath)) return;

    const source = readFileSync(templatePath, "utf8");
    const keys = environmentKeys(source);
    for (const key of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "APP_ENV",
      "ALLOW_DEMO_ACCOUNTS",
      "ENABLE_TEST_FAULT_INJECTION",
      "ENABLE_PUBLIC_UI_PREVIEW",
      "DEMO_ADMIN_EMAIL",
      "DEMO_ADMIN_PASSWORD",
      "DEMO_REFEREE_EMAIL",
      "DEMO_REFEREE_PASSWORD",
      "DEMO_PARTICIPANT_EMAIL",
      "DEMO_PARTICIPANT_PASSWORD",
    ]) {
      expect(keys.has(key), `缺少 ${key}`).toBe(true);
    }
    expect(source).toMatch(/DATABASE_URL=.*_test/);
    expect(source).toContain('BETTER_AUTH_URL="http://127.0.0.1:3100"');
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("!.env.test.example");
  });
});

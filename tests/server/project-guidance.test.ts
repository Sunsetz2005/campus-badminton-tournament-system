import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("项目指令与权限文档一致性", () => {
  it("不会把已经解除的认证耦合和缺失模板写成当前事实", () => {
    const guidance = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
    expect(guidance).not.toContain("目前没有 `.env.test.example`");
    expect(guidance).not.toContain("同时**控制「种子能否创建示例身份」和「是否开放公众注册」");
    expect(guidance).not.toMatch(/共 \d+ 份 Markdown/);
    expect(guidance).toContain("公众注册始终关闭");
  });

  it("明确记录裁判长接管尚未进入当前授权实现", () => {
    const permissions = fs.readFileSync(
      path.join(root, "docs/knowledge-base/02-架构设计/API与权限.md"),
      "utf8",
    );
    expect(permissions).toContain("CHIEF_REFEREE");
    expect(permissions).toMatch(/CHIEF_REFEREE[\s\S]{0,160}阶段 3/);
  });
});

import { describe, expect, it } from "vitest";

import { hashRuleConfig, traditional21Demo, validateRuleConfig } from "@/domain/rules/rule-profile";

describe("规则配置骨架", () => {
  it("接受传统 21 分演示配置并生成稳定哈希", () => {
    expect(validateRuleConfig(traditional21Demo)).toEqual(traditional21Demo);
    expect(hashRuleConfig(traditional21Demo)).toHaveLength(64);
    expect(hashRuleConfig(traditional21Demo)).toBe(hashRuleConfig({ ...traditional21Demo }));
  });

  it("拒绝低于目标分的封顶和越界间歇阈值", () => {
    expect(() => validateRuleConfig({ ...traditional21Demo, capPoints: 20 })).toThrow("封顶分");
    expect(() => validateRuleConfig({ ...traditional21Demo, intervalAt: 21 })).toThrow("间歇阈值");
  });
});

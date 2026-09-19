import { describe, expect, it } from "vitest";

import {
  alternative3x15Demo,
  hashRuleConfig,
  singleGame21Demo,
  traditional21Demo,
  validateRuleConfig,
} from "@/domain/rules/rule-profile";

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

  it("提供冻结参数的传统 21、替代 3×15 和单局 21 三个演示配置", () => {
    expect(validateRuleConfig(alternative3x15Demo)).toMatchObject({
      bestOf: 3,
      targetPoints: 15,
      capPoints: 21,
      intervalAt: 8,
      decidingGameChangeEndsAt: 8,
    });
    expect(validateRuleConfig(singleGame21Demo)).toMatchObject({
      bestOf: 1,
      targetPoints: 21,
      capPoints: 30,
      intervalAt: 11,
      decidingGameChangeEndsAt: 11,
    });
  });
});

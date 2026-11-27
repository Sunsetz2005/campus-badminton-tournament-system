import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createMatchAggregate, stableStringify } from "@/domain/rules/match-engine";
import { hashRuleConfig, traditional21Demo } from "@/domain/rules/rule-profile";

/**
 * 状态哈希由键的排序决定。这里把顺序与一份完整初始状态的哈希钉死：
 * 排序规则一旦随运行环境或代码改动而变化，已入库比赛的哈希校验会全部失败，必须先在这里发现。
 */
describe("stableStringify 的键顺序", () => {
  it("与对象的书写顺序无关", () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("大小写与前缀的顺序固定（英语排序规则：小写在同字母大写之前，短前缀在前）", () => {
    const keys = ["scoreB", "scoreA", "serverPlayerId", "serverCourt", "servingSide", "ruleConfigHash", "ruleConfig", "B", "A", "b", "a", "R", "L", "END_1"];
    const ordered = Object.keys(JSON.parse(stableStringify(Object.fromEntries(keys.map((key) => [key, 0])))));
    expect(ordered).toEqual(["a", "A", "b", "B", "END_1", "L", "R", "ruleConfig", "ruleConfigHash", "scoreA", "scoreB", "serverCourt", "serverPlayerId", "servingSide"]);
  });

  it("完整比赛初始状态的哈希保持不变", () => {
    const state = createMatchAggregate({
      matchId: "00000000-0000-4000-8000-000000000001",
      format: "DOUBLES",
      players: { A: ["a1", "a2"], B: ["b1", "b2"] },
      ruleConfig: traditional21Demo,
      ruleConfigHash: hashRuleConfig(traditional21Demo),
    }).state;
    expect(createHash("sha256").update(stableStringify(state)).digest("hex")).toMatchInlineSnapshot(`"de457d164d53936922fd1839392621815af768db861e691a243236967e92f5f6"`);
  });
});

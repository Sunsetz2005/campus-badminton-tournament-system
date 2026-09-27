import { describe, expect, it } from "vitest";

import {
  applyAdjustments,
  assertFixtureGraph,
  replayDraw,
  roundRobinRounds,
  runDraw,
  seedPositionOrder,
  type DrawEntryInput,
  type DrawInput,
  type DrawResult,
  type DrawSettings,
  type PlannedFixture,
} from "@/domain/draw/draw-engine";
import { balancedGroupSizes, suggestFormat, suggestGroupCount } from "@/domain/draw/format";
import { createDrawRandom } from "@/domain/draw/random";

function entries(count: number, units: (index: number) => string[] = () => []): DrawEntryInput[] {
  return Array.from({ length: count }, (_, index) => ({
    entryId: `e${String(index + 1).padStart(2, "0")}`,
    code: `MS-${String(index + 1).padStart(3, "0")}`,
    label: `选手 ${index + 1}`,
    units: units(index),
  }));
}

const base: DrawSettings = {
  format: "ROUND_ROBIN",
  groupCount: null,
  qualifiersPerGroup: 2,
  thirdPlaceMatch: true,
  avoidSameUnit: true,
  seeds: [],
};

type DrawCall = { randomSeed?: string; entries: DrawEntryInput[]; settings?: Partial<DrawSettings> };

function draw(input: DrawCall): DrawResult {
  const outcome = runDraw({ randomSeed: "seed-1", ...input, settings: { ...base, ...input.settings } });
  if (!outcome.ok) throw new Error(outcome.errors.join("；"));
  return outcome.result;
}

function errorsOf(input: DrawCall) {
  const outcome = runDraw({ randomSeed: "seed-1", ...input, settings: { ...base, ...input.settings } });
  return outcome.ok ? [] : outcome.errors;
}

function entryPairs(fixtures: PlannedFixture[]) {
  return fixtures.map((fixture) => {
    if (fixture.sideA.type !== "ENTRY" || fixture.sideB.type !== "ENTRY") throw new Error("非确定对阵");
    return [fixture.sideA.entryId, fixture.sideB.entryId].sort().join("|");
  });
}

describe("可复现随机数", () => {
  it("同一种子得到同一序列，不同种子不同", () => {
    const a = createDrawRandom("abc");
    const b = createDrawRandom("abc");
    const c = createDrawRandom("abd");
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
  });

  it("洗牌不修改入参且是一个排列", () => {
    const items = [1, 2, 3, 4, 5, 6];
    const shuffled = createDrawRandom("x").shuffle(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...shuffled].sort()).toEqual(items);
  });
});

describe("规模建议", () => {
  it("2—5 单循环，6 起分组，组间相差不超过 1", () => {
    expect(suggestFormat(0)).toBeNull();
    expect(suggestFormat(1)).toBeNull();
    for (const count of [2, 3, 4, 5]) expect(suggestFormat(count)?.format).toBe("ROUND_ROBIN");
    expect(suggestFormat(6)).toMatchObject({ format: "GROUPS_KNOCKOUT", groupCount: 2 });
    expect(suggestGroupCount(16)).toBe(4);
    expect(suggestGroupCount(12)).toBe(3);
    for (let count = 6; count <= 40; count += 1) {
      const groupCount = suggestGroupCount(count);
      expect(groupCount).not.toBeNull();
      const sizes = balancedGroupSizes(count, groupCount as number);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(count);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(3);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(5);
    }
  });
});

describe("0/1 个报名单位不能无条件编排", () => {
  it("0 个拒绝", () => {
    expect(errorsOf({ entries: [] })).toEqual(["没有已审核通过的报名单位，不能编排。"]);
  });
  it("1 个拒绝且说明不自动产生冠军", () => {
    for (const format of ["ROUND_ROBIN", "KNOCKOUT", "GROUPS_KNOCKOUT"] as const) {
      expect(errorsOf({ entries: entries(1), settings: { format } })[0]).toContain("不自动产生冠军");
    }
  });
});

describe("单循环", () => {
  it.each([3, 5, 7])("%i 个：每对恰好相遇一次，无自己对自己，奇数每轮一人轮空", (count) => {
    const result = draw({ entries: entries(count) });
    const pairs = entryPairs(result.fixtures);
    expect(pairs).toHaveLength((count * (count - 1)) / 2);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const pair of pairs) {
      const [a, b] = pair.split("|");
      expect(a).not.toBe(b);
    }
    const ids = entries(count).map((entry) => entry.entryId);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) expect(pairs).toContain([ids[i], ids[j]].sort().join("|"));
    }
    const rounds = count % 2 === 0 ? count - 1 : count;
    expect(Math.max(...result.fixtures.map((fixture) => fixture.round))).toBe(rounds);
    // 同一轮里每人最多出场一次。
    for (let round = 1; round <= rounds; round += 1) {
      const players = result.fixtures
        .filter((fixture) => fixture.round === round)
        .flatMap((fixture) => [fixture.sideA, fixture.sideB].map((side) => (side.type === "ENTRY" ? side.entryId : "")));
      expect(new Set(players).size).toBe(players.length);
    }
    if (count % 2 === 1) {
      expect(result.groupByes).toHaveLength(rounds);
      expect(new Set(result.groupByes.map((bye) => bye.entryId)).size).toBe(count);
    } else {
      expect(result.groupByes).toHaveLength(0);
    }
  });

  it("圆桌法对 2—12 人都不漏不重", () => {
    for (let count = 2; count <= 12; count += 1) {
      const ids = Array.from({ length: count }, (_, index) => `x${index}`);
      const pairs = roundRobinRounds(ids).flatMap((round) => round.pairs.map((pair) => [...pair].sort().join("|")));
      expect(pairs).toHaveLength((count * (count - 1)) / 2);
      expect(new Set(pairs).size).toBe(pairs.length);
    }
  });

  it("单循环不接受种子", () => {
    expect(errorsOf({ entries: entries(4), settings: { seeds: [{ entryId: "e01", seedNo: 1, basis: "上届冠军" }] } })).toContain(
      "单循环所有报名单位互相比赛，不使用种子。",
    );
  });
});

describe("单淘汰", () => {
  it("标准签位顺序：1 最上、2 最下、相邻两位种子位号之和为 size+1", () => {
    expect(seedPositionOrder(8)).toEqual([1, 8, 5, 4, 3, 6, 7, 2]);
    const order = seedPositionOrder(16);
    const rankAt = new Map(order.map((position, index) => [position, index + 1]));
    for (let position = 1; position <= 16; position += 2) {
      expect((rankAt.get(position) as number) + (rankAt.get(position + 1) as number)).toBe(17);
    }
  });

  it.each([
    [3, 4, 1],
    [6, 8, 2],
    [10, 16, 6],
  ])("%i 个：签表 %i 位、%i 个轮空，轮空不生成比赛", (count, size, byes) => {
    const seeds = count >= 6 ? [{ entryId: "e01", seedNo: 1, basis: "上届冠军" }, { entryId: "e02", seedNo: 2, basis: "上届亚军" }] : [];
    const result = draw({ entries: entries(count), settings: { format: "KNOCKOUT", seeds } });
    const bracket = result.layout.bracket;
    expect(bracket?.size).toBe(size);
    expect(bracket?.slots.filter((slot) => slot === null)).toHaveLength(byes);
    // 实际比赛 = 报名单位数 − 1（冠军以外每人恰好输一场），三四名赛另计。
    const knockout = result.fixtures.filter((fixture) => fixture.kind === "KNOCKOUT");
    expect(knockout).toHaveLength(count - 1);
    // 两个轮空不相邻。
    for (let position = 0; position < size; position += 2) {
      expect(bracket?.slots[position] === null && bracket?.slots[position + 1] === null).toBe(false);
    }
    // 每个报名单位只出现在签表一次。
    const placed = bracket?.slots.flatMap((slot) => (slot?.type === "ENTRY" ? [slot.entryId] : [])) ?? [];
    expect(new Set(placed).size).toBe(count);
    if (seeds.length) {
      expect(bracket?.slots[0]).toEqual({ type: "ENTRY", entryId: "e01" });
      expect(bracket?.slots[size - 1]).toEqual({ type: "ENTRY", entryId: "e02" });
      // 前两号种子首轮轮空。
      expect(bracket?.slots[1]).toBeNull();
      expect(bracket?.slots[size - 2]).toBeNull();
    }
    assertFixtureGraph(result.fixtures);
  });

  it("3 人签表只有一场半决赛：不安排三四名赛也不虚构第四名", () => {
    const result = draw({ entries: entries(3), settings: { format: "KNOCKOUT" } });
    expect(result.fixtures.some((fixture) => fixture.kind === "THIRD_PLACE")).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain("third_place_unavailable");
  });

  it("三四名赛是明确选项，引用两场半决赛负者", () => {
    const withBronze = draw({ entries: entries(8), settings: { format: "KNOCKOUT" } });
    expect(withBronze.fixtures.find((fixture) => fixture.kind === "THIRD_PLACE")).toMatchObject({
      sideA: { type: "FIXTURE_LOSER", fixtureCode: "SF1" },
      sideB: { type: "FIXTURE_LOSER", fixtureCode: "SF2" },
    });
    const without = draw({ entries: entries(8), settings: { format: "KNOCKOUT", thirdPlaceMatch: false } });
    expect(without.fixtures.some((fixture) => fixture.kind === "THIRD_PLACE")).toBe(false);
  });

  it("决赛引用半决赛胜者，不先虚构确定参赛者", () => {
    const result = draw({ entries: entries(8), settings: { format: "KNOCKOUT" } });
    expect(result.fixtures.find((fixture) => fixture.code === "F")).toMatchObject({
      sideA: { type: "FIXTURE_WINNER", fixtureCode: "SF1" },
      sideB: { type: "FIXTURE_WINNER", fixtureCode: "SF2" },
    });
  });

  it("种子超过签位一半拒绝", () => {
    const seeds = [1, 2, 3].map((seedNo) => ({ entryId: `e0${seedNo}`, seedNo, basis: "依据" }));
    expect(errorsOf({ entries: entries(4), settings: { format: "KNOCKOUT", seeds } })).toContain("4 签位的签表最多 2 个种子。");
  });
});

describe("小组循环＋淘汰", () => {
  it("两组固定 A1—B2、B1—A2，同组出线者分处不同半区", () => {
    const result = draw({ entries: entries(8), settings: { format: "GROUPS_KNOCKOUT" } });
    expect(result.layout.groups.map((group) => group.entryIds.length)).toEqual([4, 4]);
    const semis = result.fixtures.filter((fixture) => fixture.code.startsWith("SF"));
    expect(semis.map((fixture) => [fixture.sideA, fixture.sideB])).toEqual([
      [{ type: "GROUP_RANK", groupCode: "A", rank: 1 }, { type: "GROUP_RANK", groupCode: "B", rank: 2 }],
      [{ type: "GROUP_RANK", groupCode: "B", rank: 1 }, { type: "GROUP_RANK", groupCode: "A", rank: 2 }],
    ]);
  });

  it("四组固定 QF1=A1—B2、QF2=C1—D2、QF3=B1—A2、QF4=D1—C2", () => {
    const result = draw({ entries: entries(16), settings: { format: "GROUPS_KNOCKOUT", groupCount: 4 } });
    const describe = (fixture: PlannedFixture) =>
      [fixture.sideA, fixture.sideB].map((side) => (side.type === "GROUP_RANK" ? `${side.groupCode}${side.rank}` : "?")).join("-");
    expect(result.fixtures.filter((fixture) => fixture.code.startsWith("QF")).map(describe)).toEqual([
      "A1-B2",
      "C1-D2",
      "B1-A2",
      "D1-C2",
    ]);
  });

  it.each([3, 5, 6, 7])("%i 组：第 1 名优先轮空、同组第 2 名在另一半区、依赖无环", (groupCount) => {
    for (const seed of ["s1", "s2", "s3", "s4"]) {
      const result = draw({ randomSeed: seed, entries: entries(groupCount * 4), settings: { format: "GROUPS_KNOCKOUT", groupCount } });
      const bracket = result.layout.bracket;
      if (!bracket) throw new Error("缺少签表");
      const size = bracket.size;
      const byes = size - groupCount * 2;
      const positionOf = (groupCode: string, rank: number) =>
        bracket.slots.findIndex((slot) => slot?.type === "GROUP_RANK" && slot.groupCode === groupCode && slot.rank === rank) + 1;
      for (const group of result.layout.groups) {
        const first = positionOf(group.code, 1);
        const second = positionOf(group.code, 2);
        expect(first).toBeGreaterThan(0);
        expect(second).toBeGreaterThan(0);
        expect(first <= size / 2).not.toBe(second <= size / 2);
      }
      // 轮空的对手：先给全部小组第一，再按随机给第二名。
      const byeOpponents = bracket.slots
        .map((slot, index) => (slot === null ? bracket.slots[index % 2 === 0 ? index + 1 : index - 1] : undefined))
        .filter((slot) => slot !== undefined);
      expect(byeOpponents).toHaveLength(byes);
      const winnersWithBye = byeOpponents.filter((slot) => slot?.type === "GROUP_RANK" && slot.rank === 1).length;
      expect(winnersWithBye).toBe(Math.min(byes, groupCount));
      assertFixtureGraph(result.fixtures);
    }
  });

  it("种子按序号进入 A、B…，每组最多 1 个", () => {
    const seeds = [
      { entryId: "e05", seedNo: 1, basis: "上届冠军" },
      { entryId: "e09", seedNo: 2, basis: "上届亚军" },
    ];
    const result = draw({ entries: entries(10), settings: { format: "GROUPS_KNOCKOUT", seeds } });
    expect(result.layout.groups[0].entryIds[0]).toBe("e05");
    expect(result.layout.groups[1].entryIds[0]).toBe("e09");
    const tooMany = [1, 2, 3].map((seedNo) => ({ entryId: `e0${seedNo}`, seedNo, basis: "依据" }));
    expect(errorsOf({ entries: entries(8), settings: { format: "GROUPS_KNOCKOUT", seeds: tooMany } })).toContain(
      "小组赛每组最多 1 个种子，2 个小组最多 2 个种子。",
    );
  });

  it("种子必须有依据且序号连续", () => {
    const errors = errorsOf({
      entries: entries(8),
      settings: { format: "GROUPS_KNOCKOUT", seeds: [{ entryId: "e01", seedNo: 2, basis: " " }] },
    });
    expect(errors).toContain("种子序号必须从 1 开始连续编号。");
    expect(errors).toContain("种子 2 必须填写设种依据。");
  });

  it("组太小无法决出前 2 名时拒绝", () => {
    expect(errorsOf({ entries: entries(5), settings: { format: "GROUPS_KNOCKOUT", groupCount: 2 } })[0]).toContain("不足以决出前 2 名");
  });
});

describe("代表队软回避", () => {
  it("能回避时完全分开同单位", () => {
    // 8 人两组，4 个学院各 2 人。
    const units = ["数学", "数学", "物理", "物理", "化学", "化学", "生物", "生物"];
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const result = draw({ randomSeed: seed, entries: entries(8, (index) => [units[index]]), settings: { format: "GROUPS_KNOCKOUT" } });
      expect(result.conflicts).toEqual([]);
    }
  });

  it("单位人数多于组数时必然同组：列出冲突与原因，不悄悄忽略", () => {
    const units = ["数学", "数学", "数学", "物理", "化学", "生物", "历史", "地理"];
    const result = draw({ entries: entries(8, (index) => [units[index]]), settings: { format: "GROUPS_KNOCKOUT" } });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ kind: "SAME_UNIT_GROUP", unit: "数学" });
    expect(result.conflicts[0].entryIds).toHaveLength(2);
    expect(result.conflicts[0].reason).toContain("共有 3 个报名单位，只有 2 个小组");
  });

  it("种子与回避不可同时满足：种子分区优先并说明", () => {
    // 两个种子都来自数学学院，另有一名数学学院选手：无论放哪一组都会与一个种子同组。
    const units = ["数学", "数学", "数学", "物理", "化学", "生物"];
    const seeds = [
      { entryId: "e01", seedNo: 1, basis: "上届冠军" },
      { entryId: "e02", seedNo: 2, basis: "上届亚军" },
    ];
    const result = draw({ entries: entries(6, (index) => [units[index]]), settings: { format: "GROUPS_KNOCKOUT", seeds } });
    expect(result.layout.groups[0].entryIds).toContain("e01");
    expect(result.layout.groups[1].entryIds).toContain("e02");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].reason).toMatch(/必然有同单位同组|种子分区优先于回避/);
  });

  it("单淘汰首轮同单位相遇会被列出", () => {
    // 4 人全是同一学院：首轮必然相遇。
    const result = draw({ entries: entries(4, () => ["数学"]), settings: { format: "KNOCKOUT" } });
    expect(result.conflicts.filter((conflict) => conflict.kind === "SAME_UNIT_FIRST_ROUND")).toHaveLength(2);
  });

  it("单淘汰能避开时首轮不相遇", () => {
    const units = ["数学", "数学", "物理", "物理", "化学", "化学", "生物", "生物"];
    for (const seed of ["a", "b", "c"]) {
      const result = draw({ randomSeed: seed, entries: entries(8, (index) => [units[index]]), settings: { format: "KNOCKOUT" } });
      expect(result.conflicts).toEqual([]);
    }
  });

  it("关闭回避时不计算冲突", () => {
    const result = draw({ entries: entries(8, () => ["数学"]), settings: { format: "GROUPS_KNOCKOUT", avoidSameUnit: false } });
    expect(result.conflicts).toEqual([]);
  });

  it("单位名称按全半角与空白规范化比较", () => {
    const units = ["数学 学院", "数学学院", "ＡＢ", "ab"];
    const result = draw({ entries: entries(4, (index) => [units[index]]), settings: { format: "KNOCKOUT" } });
    expect(result.conflicts).toEqual([]);
    const pairs = [0, 2].map((index) => [result.layout.bracket?.slots[index], result.layout.bracket?.slots[index + 1]]);
    for (const [a, b] of pairs) {
      const left = a?.type === "ENTRY" ? Number(a.entryId.slice(1)) : 0;
      const right = b?.type === "ENTRY" ? Number(b.entryId.slice(1)) : 0;
      // 1/2 同单位，3/4 同单位，首轮必须拆开。
      expect(Math.ceil(left / 2)).not.toBe(Math.ceil(right / 2));
    }
  });
});

describe("可复现与手动调签", () => {
  it("同种子同输入结果完全相同；输入顺序不影响结果；换种子通常不同", () => {
    const list = entries(12, (index) => [`学院${index % 4}`]);
    const settings = { format: "GROUPS_KNOCKOUT" as const };
    const first = draw({ randomSeed: "fixed", entries: list, settings });
    const again = draw({ randomSeed: "fixed", entries: [...list].reverse(), settings });
    expect(again).toEqual(first);
    const other = draw({ randomSeed: "another", entries: list, settings });
    expect(other.layout).not.toEqual(first.layout);
  });

  it("交换两组选手后重新推导对阵与冲突，并可按记录重放", () => {
    const list = entries(8, (index) => [["数学", "数学", "物理", "物理", "化学", "化学", "生物", "生物"][index]]);
    const input: DrawInput = { randomSeed: "swap", entries: list, settings: { ...base, format: "GROUPS_KNOCKOUT" } };
    const first = runDraw(input);
    if (!first.ok) throw new Error("抽签失败");
    const [groupA, groupB] = first.result.layout.groups;
    const adjustments = [{ type: "SWAP" as const, entryA: groupA.entryIds[1], entryB: groupB.entryIds[1], reason: "组委会调整" }];
    const adjusted = applyAdjustments(input, first.result.layout, adjustments);
    if (!adjusted.ok) throw new Error(adjusted.errors.join());
    expect(adjusted.result.layout.groups[0].entryIds).toContain(groupB.entryIds[1]);
    expect(adjusted.result.fixtures.filter((fixture) => fixture.groupCode === "A")).toHaveLength(6);
    const replayed = replayDraw(input, adjustments);
    expect(replayed).toEqual(adjusted);
  });

  it("调签不能让一组出现两个种子、不能让人数相差超过 1、必须写原因", () => {
    const seeds = [
      { entryId: "e01", seedNo: 1, basis: "依据" },
      { entryId: "e02", seedNo: 2, basis: "依据" },
    ];
    const input: DrawInput = { randomSeed: "rule", entries: entries(8), settings: { ...base, format: "GROUPS_KNOCKOUT", seeds } };
    const first = runDraw(input);
    if (!first.ok) throw new Error("抽签失败");
    const layout = first.result.layout;
    const other = layout.groups[1].entryIds.find((id) => id !== "e02") as string;
    const moveSeed = applyAdjustments(input, layout, [{ type: "MOVE", entryId: "e01", toGroup: "B", reason: "测试" }]);
    expect(moveSeed.ok ? [] : moveSeed.errors[0]).toMatch(/相差超过 1|2 个种子/);
    const swapSeeds = applyAdjustments(input, layout, [{ type: "SWAP", entryA: "e01", entryB: other, reason: "测试" }]);
    expect(swapSeeds.ok ? [] : swapSeeds.errors[0]).toContain("每组最多 1 个");
    const noReason = applyAdjustments(input, layout, [{ type: "SWAP", entryA: "e03", entryB: other, reason: " " }]);
    expect(noReason.ok ? [] : noReason.errors[0]).toContain("必须填写原因");
  });

  it("单淘汰不能手动调换种子签位", () => {
    const input: DrawInput = {
      randomSeed: "ko",
      entries: entries(8),
      settings: { ...base, format: "KNOCKOUT", seeds: [{ entryId: "e01", seedNo: 1, basis: "依据" }] },
    };
    const first = runDraw(input);
    if (!first.ok) throw new Error("抽签失败");
    const outcome = applyAdjustments(input, first.result.layout, [{ type: "SWAP", entryA: "e01", entryB: "e05", reason: "测试" }]);
    expect(outcome.ok ? "" : outcome.errors[0]).toContain("种子签位由规则决定");
  });
});

describe("晋级来源无环", () => {
  it("引用同轮或更晚轮次的对阵会被拒绝", () => {
    const fixtures: PlannedFixture[] = [
      { code: "SF1", kind: "KNOCKOUT", groupCode: null, round: 1, sequence: 1, label: "", sideA: { type: "ENTRY", entryId: "a" }, sideB: { type: "FIXTURE_WINNER", fixtureCode: "F" } },
      { code: "F", kind: "KNOCKOUT", groupCode: null, round: 2, sequence: 1, label: "", sideA: { type: "FIXTURE_WINNER", fixtureCode: "SF1" }, sideB: { type: "ENTRY", entryId: "b" } },
    ];
    expect(() => assertFixtureGraph(fixtures)).toThrow(/依赖成环/);
  });

  it("同一胜者被引用两次会被拒绝", () => {
    const fixtures: PlannedFixture[] = [
      { code: "SF1", kind: "KNOCKOUT", groupCode: null, round: 1, sequence: 1, label: "", sideA: { type: "ENTRY", entryId: "a" }, sideB: { type: "ENTRY", entryId: "b" } },
      { code: "F", kind: "KNOCKOUT", groupCode: null, round: 2, sequence: 1, label: "", sideA: { type: "FIXTURE_WINNER", fixtureCode: "SF1" }, sideB: { type: "ENTRY", entryId: "c" } },
      { code: "X", kind: "KNOCKOUT", groupCode: null, round: 2, sequence: 2, label: "", sideA: { type: "FIXTURE_WINNER", fixtureCode: "SF1" }, sideB: { type: "ENTRY", entryId: "d" } },
    ];
    expect(() => assertFixtureGraph(fixtures)).toThrow(/被引用了两次/);
  });
});

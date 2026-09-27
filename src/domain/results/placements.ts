/**
 * 项目最终名次的纯规则。无 IO、无框架。
 *
 * 只输出赛制真正决出的名次，不编造完整的第 1 到末名：
 * - 单循环：确认后的小组名次就是最终名次；
 * - 淘汰赛：决赛决出第 1、2 名；有三四名赛时决出第 3、4 名，没有时两名半决赛负者并列第 3；
 *   更早轮次的负者只记「并列第 5（八强）」「并列第 9（十六强）」等，不跨场比较净胜分硬排；
 * - 小组赛＋淘汰赛：未出线者只记「小组未出线」，不跨组排名次。
 * 名次只由已正式确认（裁判长复核锁定）的结果或已确认的小组名次产生。
 */

export interface PlacementGroupFact {
  code: string;
  /** 已确认的名次顺序（不含被排除者）；未确认为 null。 */
  confirmedOrder: string[] | null;
  entryIds: string[];
  excludedEntryIds: string[];
}

export interface PlacementFixtureFact {
  code: string;
  kind: "KNOCKOUT" | "THIRD_PLACE";
  round: number;
  sideA: string | null;
  sideB: string | null;
  /** 仅当结果已正式确认时给出胜方。 */
  winner: string | null;
}

export interface PlacementInput {
  format: "ROUND_ROBIN" | "GROUPS_KNOCKOUT" | "KNOCKOUT";
  groups: PlacementGroupFact[];
  qualifiersPerGroup: number;
  knockout: PlacementFixtureFact[];
}

export interface Placement {
  entryId: string;
  /** 数字名次；「小组未出线」「排除」等没有数字名次。 */
  place: number | null;
  tied: boolean;
  label: string;
}

const ROUND_NAMES: Record<number, string> = { 4: "四强", 8: "八强", 16: "十六强", 32: "三十二强", 64: "六十四强" };

function loserOf(fixture: PlacementFixtureFact) {
  if (!fixture.winner) return null;
  return fixture.winner === fixture.sideA ? fixture.sideB : fixture.sideA;
}

export function computePlacements(input: PlacementInput): { placements: Placement[]; complete: boolean } {
  const placements = new Map<string, Placement>();
  const set = (entryId: string | null, place: number | null, tied: boolean, label: string) => {
    if (entryId && !placements.has(entryId)) placements.set(entryId, { entryId, place, tied, label });
  };
  const everyone = new Set(input.groups.flatMap((group) => group.entryIds));
  for (const fixture of input.knockout) {
    if (fixture.sideA) everyone.add(fixture.sideA);
    if (fixture.sideB) everyone.add(fixture.sideB);
  }

  if (input.format === "ROUND_ROBIN") {
    const group = input.groups[0];
    group?.confirmedOrder?.forEach((entryId, index) => set(entryId, index + 1, false, `第 ${index + 1} 名`));
    for (const entryId of group?.excludedEntryIds ?? []) if (group?.confirmedOrder) set(entryId, null, false, "排除，不计名次");
  } else {
    const main = input.knockout.filter((fixture) => fixture.kind === "KNOCKOUT");
    const finalRound = main.reduce((max, fixture) => Math.max(max, fixture.round), 0);
    const final = main.find((fixture) => fixture.round === finalRound);
    if (final?.winner) {
      set(final.winner, 1, false, "冠军");
      set(loserOf(final), 2, false, "亚军");
    }
    const third = input.knockout.find((fixture) => fixture.kind === "THIRD_PLACE");
    if (third) {
      if (third.winner) {
        set(third.winner, 3, false, "季军");
        set(loserOf(third), 4, false, "第 4 名");
      }
    }
    for (const fixture of main) {
      if (fixture === final || !fixture.winner) continue;
      if (third && fixture.round === finalRound - 1) continue; // 半决赛负者由三四名赛决定
      const bracket = 2 ** (finalRound - fixture.round + 1);
      const place = bracket / 2 + 1;
      const name = ROUND_NAMES[bracket];
      set(loserOf(fixture), place, true, `并列第 ${place} 名${name ? `（${name}）` : ""}`);
    }
    if (input.format === "GROUPS_KNOCKOUT") {
      for (const group of input.groups) {
        if (!group.confirmedOrder) continue;
        group.confirmedOrder.slice(input.qualifiersPerGroup).forEach((entryId) => set(entryId, null, false, `${group.code} 组未出线`));
        for (const entryId of group.excludedEntryIds) set(entryId, null, false, `${group.code} 组排除，不计名次`);
      }
    }
  }

  const list = [...everyone].map((entryId) => placements.get(entryId) ?? { entryId, place: null, tied: false, label: "名次待定" });
  list.sort((left, right) => (left.place ?? Number.MAX_SAFE_INTEGER) - (right.place ?? Number.MAX_SAFE_INTEGER));
  return { placements: list, complete: list.every((item) => item.label !== "名次待定") };
}

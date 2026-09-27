/**
 * 抽签编排的纯规则引擎。无 IO、无框架、不读当前时间；随机性只来自调用方传入的种子。
 *
 * 分两步：
 * 1. `runDraw` 用种子做出「布局」（谁在哪个组、签表哪个位置）——只有这一步用随机数；
 * 2. `deriveDraw` 从布局确定性地推导对阵、冲突与提示。手动调签只改布局，再重新推导。
 *
 * 同一份输入名单、设置和种子永远得到同一个布局；保存 输入＋设置＋种子＋手动调整 即可完整复现。
 *
 * 回避是软约束，优先级固定为：不漏不重 → 人数均衡 → 种子分区 → 尽量减少同单位相遇。
 * 做不到时逐条列出冲突和原因，不悄悄降级，也不无限重试。
 */

import { nameKey } from "@/domain/registration/registration-rules";

import {
  balancedGroupSizes,
  GROUP_SIZE,
  groupCodeAt,
  MAX_SEEDS,
  nextPowerOfTwo,
  recommendedSeedCap,
  ROUND_ROBIN_MAX_DEFAULT,
  suggestFormat,
  type DrawFormat,
} from "./format";
import { createDrawRandom, type DrawRandom } from "./random";

export const DRAW_ALGORITHM_VERSION = "draw-v1";

export interface DrawEntryInput {
  entryId: string;
  /** 报名单位编号，用于规范排序与显示。 */
  code: string;
  label: string;
  /** 回避用的代表队/单位名称（原文），内部按姓名同样的规则规范化比较。 */
  units: readonly string[];
}

export interface DrawSeedInput {
  entryId: string;
  seedNo: number;
  /** 设种依据（上届成绩、组委会决定等），必填。 */
  basis: string;
}

export interface DrawSettings {
  format: DrawFormat;
  /** 仅小组循环＋淘汰使用；null 表示按项目默认建议。 */
  groupCount: number | null;
  qualifiersPerGroup: 1 | 2;
  thirdPlaceMatch: boolean;
  avoidSameUnit: boolean;
  seeds: DrawSeedInput[];
}

export interface DrawInput {
  entries: readonly DrawEntryInput[];
  settings: DrawSettings;
  randomSeed: string;
}

export type SlotSource =
  | { type: "ENTRY"; entryId: string }
  | { type: "GROUP_RANK"; groupCode: string; rank: number }
  | { type: "FIXTURE_WINNER"; fixtureCode: string }
  | { type: "FIXTURE_LOSER"; fixtureCode: string };

export type FixtureKind = "GROUP" | "KNOCKOUT" | "THIRD_PLACE";

export interface PlannedFixture {
  code: string;
  kind: FixtureKind;
  groupCode: string | null;
  round: number;
  sequence: number;
  label: string;
  sideA: SlotSource;
  sideB: SlotSource;
}

export interface LayoutGroup {
  code: string;
  entryIds: string[];
}

export interface DrawLayout {
  format: DrawFormat;
  groups: LayoutGroup[];
  /** 签表位置，null 表示轮空位。单淘汰为报名单位，小组＋淘汰为「某组第几名」。 */
  bracket: { size: number; slots: (SlotSource | null)[] } | null;
}

export interface GroupRoundBye {
  groupCode: string;
  round: number;
  entryId: string;
}

export interface DrawConflict {
  kind: "SAME_UNIT_GROUP" | "SAME_UNIT_FIRST_ROUND";
  unit: string;
  where: string;
  entryIds: string[];
  reason: string;
}

export interface DrawWarning {
  code: string;
  message: string;
}

export interface DrawResult {
  algorithmVersion: string;
  layout: DrawLayout;
  fixtures: PlannedFixture[];
  groupByes: GroupRoundBye[];
  conflicts: DrawConflict[];
  warnings: DrawWarning[];
}

export type DrawOutcome = { ok: true; result: DrawResult } | { ok: false; errors: string[] };

export type DrawAdjustment =
  | { type: "SWAP"; entryA: string; entryB: string; reason: string }
  | { type: "MOVE"; entryId: string; toGroup: string; reason: string };

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

interface NormalizedInput {
  entries: DrawEntryInput[];
  byId: Map<string, DrawEntryInput>;
  unitKeys: Map<string, Set<string>>;
  unitLabels: Map<string, string>;
  seedByEntry: Map<string, number>;
  seedsSorted: DrawSeedInput[];
  settings: DrawSettings;
  groupCount: number;
  bracketSize: number;
}

function entryCountError(count: number) {
  if (count === 0) return "没有已审核通过的报名单位，不能编排。";
  if (count === 1) return "只有 1 个报名单位：只保留报名记录，不编排，也不自动产生冠军。";
  return null;
}

function normalizeInput(input: DrawInput): { ok: true; value: NormalizedInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const entries = [...input.entries].sort((left, right) => left.code.localeCompare(right.code, "en"));
  const countError = entryCountError(entries.length);
  if (countError) return { ok: false, errors: [countError] };
  if (!input.randomSeed) errors.push("缺少抽签随机种子。");

  const byId = new Map<string, DrawEntryInput>();
  const codes = new Set<string>();
  for (const entry of entries) {
    if (byId.has(entry.entryId)) errors.push(`报名单位 ${entry.code} 重复出现。`);
    if (codes.has(entry.code)) errors.push(`报名单位编号 ${entry.code} 重复。`);
    byId.set(entry.entryId, entry);
    codes.add(entry.code);
  }

  const unitKeys = new Map<string, Set<string>>();
  const unitLabels = new Map<string, string>();
  for (const entry of entries) {
    const keys = new Set<string>();
    for (const unit of entry.units) {
      const key = nameKey(unit);
      if (!key) continue;
      keys.add(key);
      if (!unitLabels.has(key)) unitLabels.set(key, unit.trim());
    }
    unitKeys.set(entry.entryId, keys);
  }

  const { settings } = input;
  const seedByEntry = new Map<string, number>();
  const seedsSorted = [...settings.seeds].sort((left, right) => left.seedNo - right.seedNo);
  seedsSorted.forEach((seed, index) => {
    const entry = byId.get(seed.entryId);
    if (!entry) errors.push(`种子 ${seed.seedNo} 指定的报名单位不在本次名单中。`);
    if (seedByEntry.has(seed.entryId)) errors.push(`${entry?.code ?? "同一报名单位"} 被重复设为种子。`);
    if (seed.seedNo !== index + 1) errors.push("种子序号必须从 1 开始连续编号。");
    if (!seed.basis.trim()) errors.push(`种子 ${seed.seedNo} 必须填写设种依据。`);
    seedByEntry.set(seed.entryId, seed.seedNo);
  });
  if (seedsSorted.length > MAX_SEEDS) errors.push(`种子最多 ${MAX_SEEDS} 个。`);

  const count = entries.length;
  let groupCount = 1;
  let bracketSize = 0;
  if (settings.format === "ROUND_ROBIN") {
    if (seedsSorted.length) errors.push("单循环所有报名单位互相比赛，不使用种子。");
  } else if (settings.format === "GROUPS_KNOCKOUT") {
    const qualifiers = settings.qualifiersPerGroup;
    if (qualifiers !== 1 && qualifiers !== 2) errors.push("每组出线名额只能是 1 或 2。");
    groupCount = settings.groupCount ?? suggestFormat(count)?.groupCount ?? 0;
    if (!Number.isInteger(groupCount) || groupCount < 2) {
      errors.push("小组循环＋淘汰至少需要 2 个小组；请指定组数或改用单循环/单淘汰。");
    } else if (groupCount > 16) {
      errors.push("小组数最多 16 个。");
    } else {
      const sizes = balancedGroupSizes(count, groupCount);
      const smallest = Math.min(...sizes);
      const largest = Math.max(...sizes);
      if (smallest < Math.max(GROUP_SIZE.hardMin, qualifiers + 1)) {
        errors.push(`${count} 个报名单位分 ${groupCount} 组时最小组只有 ${smallest} 个，不足以决出前 ${qualifiers} 名。`);
      }
      if (largest > GROUP_SIZE.hardMax) {
        errors.push(`${count} 个报名单位分 ${groupCount} 组时单组 ${largest} 个，超过 ${GROUP_SIZE.hardMax} 个上限，请增加组数。`);
      }
      if (seedsSorted.length > groupCount) errors.push(`小组赛每组最多 1 个种子，${groupCount} 个小组最多 ${groupCount} 个种子。`);
      bracketSize = nextPowerOfTwo(groupCount * qualifiers);
    }
  } else if (settings.format === "KNOCKOUT") {
    bracketSize = nextPowerOfTwo(count);
    if (seedsSorted.length > bracketSize / 2) errors.push(`${bracketSize} 签位的签表最多 ${bracketSize / 2} 个种子。`);
  } else {
    errors.push("未知的赛制。");
  }

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    value: { entries, byId, unitKeys, unitLabels, seedByEntry, seedsSorted, settings, groupCount, bracketSize },
  };
}

// ---------------------------------------------------------------------------
// 回避计分
// ---------------------------------------------------------------------------

function sharesUnit(input: NormalizedInput, left: string, right: string) {
  const a = input.unitKeys.get(left);
  const b = input.unitKeys.get(right);
  if (!a?.size || !b?.size) return false;
  for (const key of a) if (b.has(key)) return true;
  return false;
}

function groupConflictScore(input: NormalizedInput, groups: string[][]) {
  let score = 0;
  for (const group of groups) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) if (sharesUnit(input, group[i], group[j])) score += 1;
    }
  }
  return score;
}

/** 单位压力：该报名单位所属单位在本次名单里出现的最多次数。压力大的先分，更容易分散。 */
function unitPressure(input: NormalizedInput) {
  const counts = new Map<string, number>();
  for (const keys of input.unitKeys.values()) for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const pressure = new Map<string, number>();
  for (const [entryId, keys] of input.unitKeys) {
    pressure.set(entryId, Math.max(0, ...[...keys].map((key) => counts.get(key) ?? 0)));
  }
  return { counts, pressure };
}

function orderForPlacement(input: NormalizedInput, entryIds: string[], random: DrawRandom) {
  const shuffled = random.shuffle(entryIds);
  if (!input.settings.avoidSameUnit) return shuffled;
  const { pressure } = unitPressure(input);
  // 稳定排序：同压力保持随机顺序。
  return shuffled
    .map((entryId, index) => ({ entryId, index, pressure: pressure.get(entryId) ?? 0 }))
    .sort((left, right) => right.pressure - left.pressure || left.index - right.index)
    .map((item) => item.entryId);
}

// ---------------------------------------------------------------------------
// 布局：分组
// ---------------------------------------------------------------------------

function layoutGroups(input: NormalizedInput, groupCount: number, random: DrawRandom): LayoutGroup[] {
  const sizes = balancedGroupSizes(input.entries.length, groupCount);
  const groups: string[][] = sizes.map(() => []);
  // 种子按序号依次进入 A、B、C…，每组最多 1 个。
  input.seedsSorted.forEach((seed, index) => groups[index].push(seed.entryId));
  const unseeded = input.entries.map((entry) => entry.entryId).filter((id) => !input.seedByEntry.has(id));
  const avoid = input.settings.avoidSameUnit;

  for (const entryId of orderForPlacement(input, unseeded, random)) {
    const candidates = groups
      .map((members, index) => ({ index, members }))
      .filter(({ index, members }) => members.length < sizes[index]);
    const cost = (members: string[]) => (avoid ? members.filter((other) => sharesUnit(input, entryId, other)).length : 0);
    const minCost = Math.min(...candidates.map(({ members }) => cost(members)));
    const cheapest = candidates.filter(({ members }) => cost(members) === minCost);
    const maxRoom = Math.max(...cheapest.map(({ index, members }) => sizes[index] - members.length));
    const roomiest = cheapest.filter(({ index, members }) => sizes[index] - members.length === maxRoom);
    random.pick(roomiest).members.push(entryId);
  }

  if (avoid) improveGroupsBySwaps(input, groups);
  return groups.map((entryIds, index) => ({ code: groupCodeAt(index), entryIds }));
}

/**
 * 有界的交换改进：只交换两个非种子，且只在冲突总数严格下降时交换，
 * 因此最多执行「初始冲突数」次，必然终止。扫描顺序固定，结果仍可复现。
 */
function improveGroupsBySwaps(input: NormalizedInput, groups: string[][]) {
  let score = groupConflictScore(input, groups);
  while (score > 0) {
    let improved = false;
    search: for (let gi = 0; gi < groups.length; gi += 1) {
      for (let gj = gi + 1; gj < groups.length; gj += 1) {
        for (let xi = 0; xi < groups[gi].length; xi += 1) {
          for (let yj = 0; yj < groups[gj].length; yj += 1) {
            const x = groups[gi][xi];
            const y = groups[gj][yj];
            if (input.seedByEntry.has(x) || input.seedByEntry.has(y)) continue;
            groups[gi][xi] = y;
            groups[gj][yj] = x;
            const next = groupConflictScore(input, groups);
            if (next < score) {
              score = next;
              improved = true;
              break search;
            }
            groups[gi][xi] = x;
            groups[gj][yj] = y;
          }
        }
      }
    }
    if (!improved) break;
  }
}

// ---------------------------------------------------------------------------
// 布局：签表
// ---------------------------------------------------------------------------

/**
 * 标准签位顺序：返回数组的第 k 项是「第 k 号种子位」所在的位置（1 起）。
 * 1 号在最上，2 号在最下，3/4 号在两个半区的内侧，依此类推；每对相邻位置的种子位号之和为 size+1。
 */
export function seedPositionOrder(size: number): number[] {
  if (size < 1 || (size & (size - 1)) !== 0) throw new Error("签表大小必须是 2 的幂");
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2;
    const ranks = order.flatMap((rank, index) => (index % 2 === 0 ? [rank, next + 1 - rank] : [next + 1 - rank, rank]));
    order = ranks;
  }
  // `order` 目前是「按位置排列的种子位号」，转成「按种子位号排列的位置」。
  const positions = new Array<number>(size);
  order.forEach((rank, index) => {
    positions[rank - 1] = index + 1;
  });
  return positions;
}

function partnerPosition(position: number) {
  return position % 2 === 1 ? position + 1 : position - 1;
}

function blockOf(position: number, blockSize: number) {
  return Math.floor((position - 1) / blockSize);
}

/** 种子分档：1、2 号固定；3—4 号在对应两个位置中随机；5—8 号在对应四个位置中随机；依此类推。 */
function seedTierPositions(order: number[], seedCount: number, random: DrawRandom) {
  const assigned = new Map<number, number>();
  let tierStart = 0;
  let tierSize = 1;
  while (tierStart < seedCount) {
    const tierPositions = order.slice(tierStart, tierStart + tierSize);
    const shuffled = tierStart < 2 ? tierPositions : random.shuffle(tierPositions);
    for (let offset = 0; offset < tierSize && tierStart + offset < seedCount; offset += 1) {
      assigned.set(tierStart + offset + 1, shuffled[offset]);
    }
    tierStart += tierSize;
    if (tierStart >= 2) tierSize = tierStart;
  }
  return assigned;
}

function knockoutCost(input: NormalizedInput, slots: (string | null | undefined)[], position: number, entryId: string) {
  if (!input.settings.avoidSameUnit) return 0;
  const size = slots.length;
  let cost = 0;
  const opponent = slots[partnerPosition(position) - 1];
  if (opponent && sharesUnit(input, entryId, opponent)) cost += 1000;
  slots.forEach((other, index) => {
    if (!other || other === entryId) return;
    const otherPosition = index + 1;
    if (!sharesUnit(input, entryId, other)) return;
    if (size >= 4 && blockOf(otherPosition, size / 4) === blockOf(position, size / 4)) cost += 10;
    if (blockOf(otherPosition, size / 2) === blockOf(position, size / 2)) cost += 1;
  });
  return cost;
}

function knockoutTotalCost(input: NormalizedInput, slots: (string | null | undefined)[]) {
  let total = 0;
  slots.forEach((entryId, index) => {
    if (entryId) total += knockoutCost(input, slots, index + 1, entryId);
  });
  return total;
}

function layoutKnockout(input: NormalizedInput, random: DrawRandom): DrawLayout["bracket"] {
  const size = input.bracketSize;
  const order = seedPositionOrder(size);
  const count = input.entries.length;
  const slots: (string | null | undefined)[] = new Array(size).fill(undefined);
  // 轮空位给种子位号最靠前的位置的对手，即种子位号 count+1 … size 的位置。
  for (let rank = count + 1; rank <= size; rank += 1) slots[order[rank - 1] - 1] = null;
  const seedPositions = seedTierPositions(order, input.seedsSorted.length, random);
  for (const seed of input.seedsSorted) slots[(seedPositions.get(seed.seedNo) as number) - 1] = seed.entryId;

  const unseeded = input.entries.map((entry) => entry.entryId).filter((id) => !input.seedByEntry.has(id));
  for (const entryId of orderForPlacement(input, unseeded, random)) {
    const free = slots.map((value, index) => (value === undefined ? index + 1 : 0)).filter(Boolean);
    const costs = free.map((position) => knockoutCost(input, slots, position, entryId));
    const minCost = Math.min(...costs);
    const position = random.pick(free.filter((_, index) => costs[index] === minCost));
    slots[position - 1] = entryId;
  }

  if (input.settings.avoidSameUnit) {
    let total = knockoutTotalCost(input, slots);
    while (total > 0) {
      let improved = false;
      search: for (let i = 0; i < size; i += 1) {
        for (let j = i + 1; j < size; j += 1) {
          const x = slots[i];
          const y = slots[j];
          if (!x || !y || input.seedByEntry.has(x) || input.seedByEntry.has(y)) continue;
          slots[i] = y;
          slots[j] = x;
          const next = knockoutTotalCost(input, slots);
          if (next < total) {
            total = next;
            improved = true;
            break search;
          }
          slots[i] = x;
          slots[j] = y;
        }
      }
      if (!improved) break;
    }
  }

  return {
    size,
    slots: slots.map((entryId) => (entryId ? { type: "ENTRY" as const, entryId } : null)),
  };
}

/**
 * 小组出线者进入签表。
 * - 两组、每组 2 名：固定 A1—B2、B1—A2。
 * - 四组、每组 2 名：固定 QF1=A1—B2、QF2=C1—D2、QF3=B1—A2、QF4=D1—C2。
 * - 其他组数：取不小于出线总数的最小 2 次幂签位；各组第 1 名占靠前的种子位（顺序公开随机），
 *   轮空优先给小组第一；同组第 2 名一律放在本组第 1 名的另一半区。
 */
function layoutGroupQualifiers(input: NormalizedInput, groups: LayoutGroup[], random: DrawRandom): DrawLayout["bracket"] {
  const qualifiers = input.settings.qualifiersPerGroup;
  const codes = groups.map((group) => group.code);
  const rank = (groupCode: string, place: number): SlotSource => ({ type: "GROUP_RANK", groupCode, rank: place });
  if (qualifiers === 2 && codes.length === 2) {
    const [a, b] = codes;
    return { size: 4, slots: [rank(a, 1), rank(b, 2), rank(b, 1), rank(a, 2)] };
  }
  if (qualifiers === 2 && codes.length === 4) {
    const [a, b, c, d] = codes;
    return {
      size: 8,
      slots: [rank(a, 1), rank(b, 2), rank(c, 1), rank(d, 2), rank(b, 1), rank(a, 2), rank(d, 1), rank(c, 2)],
    };
  }

  const size = input.bracketSize;
  const order = seedPositionOrder(size);
  const slots: (SlotSource | null | undefined)[] = new Array(size).fill(undefined);
  const total = codes.length * qualifiers;
  for (let seedRank = total + 1; seedRank <= size; seedRank += 1) slots[order[seedRank - 1] - 1] = null;
  const winners = random.shuffle(codes);
  const winnerPosition = new Map<string, number>();
  winners.forEach((code, index) => {
    const position = order[index];
    slots[position - 1] = rank(code, 1);
    winnerPosition.set(code, position);
  });
  if (qualifiers === 1) return { size, slots: slots.map((slot) => slot ?? null) };

  const half = (position: number) => blockOf(position, size / 2);
  const runnersUp = random.shuffle(codes);
  const free = random.shuffle(
    slots.map((slot, index) => (slot === undefined ? index + 1 : 0)).filter((position) => position > 0),
  );
  const used = new Set<number>();
  const placement = new Map<string, number>();
  const place = (index: number): boolean => {
    if (index === runnersUp.length) return true;
    const code = runnersUp[index];
    const forbiddenHalf = half(winnerPosition.get(code) as number);
    for (const position of free) {
      if (used.has(position) || half(position) === forbiddenHalf) continue;
      used.add(position);
      placement.set(code, position);
      if (place(index + 1)) return true;
      used.delete(position);
      placement.delete(code);
    }
    return false;
  };
  if (!place(0)) throw new Error("无法把同组第 2 名放入与本组第 1 名不同的半区");
  for (const [code, position] of placement) slots[position - 1] = rank(code, 2);
  return { size, slots: slots.map((slot) => slot ?? null) };
}

// ---------------------------------------------------------------------------
// 推导：对阵、冲突、提示
// ---------------------------------------------------------------------------

/** 圆桌法单循环：每对只相遇一次；人数为奇数时每轮一人轮空（轮空不是比赛，也不记比分）。 */
export function roundRobinRounds(entryIds: readonly string[]) {
  const list: (string | null)[] = [...entryIds];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds: { pairs: [string, string][]; bye: string | null }[] = [];
  for (let round = 0; round < n - 1; round += 1) {
    const pairs: [string, string][] = [];
    let bye: string | null = null;
    for (let index = 0; index < n / 2; index += 1) {
      let a = list[index];
      let b = list[n - 1 - index];
      if (index === 0 && round % 2 === 1) [a, b] = [b, a];
      if (a && b) pairs.push([a, b]);
      else bye = a ?? b;
    }
    rounds.push({ pairs, bye });
    list.splice(1, 0, list.pop() as string | null);
  }
  return rounds;
}

function knockoutRoundName(matchesInRound: number, index: number) {
  if (matchesInRound === 1) return { code: "F", label: "决赛" };
  if (matchesInRound === 2) return { code: `SF${index}`, label: `半决赛 ${index}` };
  if (matchesInRound === 4) return { code: `QF${index}`, label: `1/4 决赛 ${index}` };
  return { code: `R${matchesInRound * 2}-${index}`, label: `1/${matchesInRound} 决赛 ${index}` };
}

function buildKnockoutFixtures(
  bracket: NonNullable<DrawLayout["bracket"]>,
  thirdPlace: boolean,
  warnings: DrawWarning[],
): PlannedFixture[] {
  const fixtures: PlannedFixture[] = [];
  let current: (SlotSource | null)[] = bracket.slots;
  let round = 1;
  let semifinals: (SlotSource | null)[] | null = null;
  while (current.length > 1) {
    const matchesInRound = current.length / 2;
    const next: (SlotSource | null)[] = [];
    const roundNodes: (SlotSource | null)[] = [];
    for (let index = 0; index < matchesInRound; index += 1) {
      const a = current[index * 2];
      const b = current[index * 2 + 1];
      if (a && b) {
        const { code, label } = knockoutRoundName(matchesInRound, index + 1);
        fixtures.push({ code, kind: "KNOCKOUT", groupCode: null, round, sequence: index + 1, label, sideA: a, sideB: b });
        const winner: SlotSource = { type: "FIXTURE_WINNER", fixtureCode: code };
        next.push(winner);
        roundNodes.push(winner);
      } else {
        if (!a && !b) throw new Error("签表出现两个相邻轮空位");
        next.push(a ?? b);
        roundNodes.push(null);
      }
    }
    if (matchesInRound === 2) semifinals = roundNodes;
    current = next;
    round += 1;
  }
  if (thirdPlace) {
    if (!semifinals) {
      warnings.push({ code: "third_place_unavailable", message: "签表只有决赛，没有半决赛，不安排三四名赛。" });
    } else if (semifinals.some((node) => !node)) {
      warnings.push({ code: "third_place_unavailable", message: "有一场半决赛是轮空，只有一名半决赛负者，不安排三四名赛，也不虚构第四名。" });
    } else {
      const finalRound = round - 1;
      fixtures.push({
        code: "3P",
        kind: "THIRD_PLACE",
        groupCode: null,
        round: finalRound,
        sequence: 2,
        label: "三四名赛",
        sideA: { type: "FIXTURE_LOSER", fixtureCode: "SF1" },
        sideB: { type: "FIXTURE_LOSER", fixtureCode: "SF2" },
      });
    }
  }
  return fixtures;
}

function orderedGroupMembers(input: NormalizedInput, group: LayoutGroup) {
  // 种子排在组内 1 号位，其余保持抽签顺序。
  const seeded = group.entryIds.filter((id) => input.seedByEntry.has(id));
  return [...seeded, ...group.entryIds.filter((id) => !input.seedByEntry.has(id))];
}

function groupConflicts(input: NormalizedInput, groups: LayoutGroup[]): DrawConflict[] {
  if (!input.settings.avoidSameUnit) return [];
  const { counts } = unitPressure(input);
  const conflicts: DrawConflict[] = [];
  for (const group of groups) {
    const byUnit = new Map<string, string[]>();
    for (const entryId of group.entryIds) {
      for (const key of input.unitKeys.get(entryId) ?? []) byUnit.set(key, [...(byUnit.get(key) ?? []), entryId]);
    }
    for (const [key, entryIds] of byUnit) {
      if (entryIds.length < 2) continue;
      const unit = input.unitLabels.get(key) ?? key;
      const total = counts.get(key) ?? entryIds.length;
      const seededCount = entryIds.filter((id) => input.seedByEntry.has(id)).length;
      let reason: string;
      if (total > groups.length) {
        reason = `「${unit}」共有 ${total} 个报名单位，只有 ${groups.length} 个小组，必然有同单位同组。`;
      } else if (seededCount > 0 && input.seedsSorted.length === groups.length) {
        reason = `种子分区优先于回避：每组各有 1 个种子，在保持各组人数均衡的前提下未能把「${unit}」完全分开。`;
      } else {
        reason = `在保持各组人数均衡（相差不超过 1）和种子分区的前提下，算法未找到让「${unit}」完全分开的分法；可手动调签。`;
      }
      conflicts.push({ kind: "SAME_UNIT_GROUP", unit, where: `${group.code} 组`, entryIds, reason });
    }
  }
  return conflicts;
}

function knockoutConflicts(input: NormalizedInput, bracket: NonNullable<DrawLayout["bracket"]>): DrawConflict[] {
  if (!input.settings.avoidSameUnit) return [];
  const conflicts: DrawConflict[] = [];
  const { counts } = unitPressure(input);
  for (let position = 1; position <= bracket.size; position += 2) {
    const a = bracket.slots[position - 1];
    const b = bracket.slots[position];
    if (a?.type !== "ENTRY" || b?.type !== "ENTRY") continue;
    if (!sharesUnit(input, a.entryId, b.entryId)) continue;
    const shared = [...(input.unitKeys.get(a.entryId) ?? [])].find((key) => input.unitKeys.get(b.entryId)?.has(key)) as string;
    const unit = input.unitLabels.get(shared) ?? shared;
    const total = counts.get(shared) ?? 2;
    const seeded = input.seedByEntry.has(a.entryId) || input.seedByEntry.has(b.entryId);
    const reason =
      total > bracket.size / 2
        ? `「${unit}」共有 ${total} 个报名单位，超过首轮 ${bracket.size / 2} 个对阵位，必然首轮相遇。`
        : seeded
          ? `种子位置固定，在不移动种子的前提下未能让「${unit}」首轮避开；可手动调签。`
          : `在固定种子与轮空位置的前提下未能让「${unit}」首轮避开；可手动调签。`;
    conflicts.push({ kind: "SAME_UNIT_FIRST_ROUND", unit, where: `签位 ${position}—${position + 1}`, entryIds: [a.entryId, b.entryId], reason });
  }
  return conflicts;
}

function baseWarnings(input: NormalizedInput): DrawWarning[] {
  const warnings: DrawWarning[] = [];
  const count = input.entries.length;
  const suggestion = suggestFormat(count);
  if (suggestion && suggestion.format !== input.settings.format) {
    warnings.push({ code: "format_differs_from_default", message: `与项目默认不同：${suggestion.reason}。` });
  }
  if (input.settings.format === "ROUND_ROBIN" && count > ROUND_ROBIN_MAX_DEFAULT) {
    warnings.push({ code: "large_round_robin", message: `单循环 ${count} 个报名单位将产生 ${(count * (count - 1)) / 2} 场对阵。` });
  }
  if (input.settings.format === "GROUPS_KNOCKOUT") {
    const sizes = balancedGroupSizes(count, input.groupCount);
    if (sizes.some((size) => size < GROUP_SIZE.recommendedMin || size > GROUP_SIZE.recommendedMax)) {
      warnings.push({ code: "group_size_outside_default", message: `各组人数 ${sizes.join("/")} 超出项目默认的每组 3—5 个。` });
    }
  }
  const cap = recommendedSeedCap(count);
  if (input.seedsSorted.length > cap) {
    warnings.push({ code: "seeds_over_recommended", message: `${count} 个报名单位的建议种子上限为 ${cap} 个，当前设置了 ${input.seedsSorted.length} 个。` });
  }
  return warnings;
}

function derive(input: NormalizedInput, layout: DrawLayout): DrawResult {
  const warnings = baseWarnings(input);
  const fixtures: PlannedFixture[] = [];
  const groupByes: GroupRoundBye[] = [];
  const groups = layout.groups.map((group) => ({ code: group.code, entryIds: orderedGroupMembers(input, group) }));

  for (const group of groups) {
    roundRobinRounds(group.entryIds).forEach((round, roundIndex) => {
      round.pairs.forEach(([a, b], pairIndex) => {
        fixtures.push({
          code: `${group.code}-R${roundIndex + 1}-${pairIndex + 1}`,
          kind: "GROUP",
          groupCode: group.code,
          round: roundIndex + 1,
          sequence: pairIndex + 1,
          label: `${layout.format === "ROUND_ROBIN" ? "单循环" : `${group.code} 组`}第 ${roundIndex + 1} 轮`,
          sideA: { type: "ENTRY", entryId: a },
          sideB: { type: "ENTRY", entryId: b },
        });
      });
      if (round.bye) groupByes.push({ groupCode: group.code, round: roundIndex + 1, entryId: round.bye });
    });
  }

  let conflicts = groupConflicts(input, groups);
  if (layout.bracket) {
    fixtures.push(...buildKnockoutFixtures(layout.bracket, input.settings.thirdPlaceMatch, warnings));
    if (layout.format === "KNOCKOUT") conflicts = [...conflicts, ...knockoutConflicts(input, layout.bracket)];
  }
  assertFixtureGraph(fixtures);
  return { algorithmVersion: DRAW_ALGORITHM_VERSION, layout: { ...layout, groups }, fixtures, groupByes, conflicts, warnings };
}

/**
 * 晋级来源必须形成无环依赖：只能引用更早轮次的对阵；每场对阵的胜者、负者各最多被引用一次；
 * 同一场对阵两侧不能是同一个来源。
 */
export function assertFixtureGraph(fixtures: readonly PlannedFixture[]) {
  const byCode = new Map(fixtures.map((fixture) => [fixture.code, fixture]));
  if (byCode.size !== fixtures.length) throw new Error("对阵编号重复");
  const used = new Set<string>();
  const sourceKey = (source: SlotSource) =>
    source.type === "ENTRY"
      ? `E:${source.entryId}`
      : source.type === "GROUP_RANK"
        ? `G:${source.groupCode}:${source.rank}`
        : `${source.type}:${source.fixtureCode}`;
  for (const fixture of fixtures) {
    if (sourceKey(fixture.sideA) === sourceKey(fixture.sideB)) throw new Error(`对阵 ${fixture.code} 两侧来源相同`);
    for (const source of [fixture.sideA, fixture.sideB]) {
      if (source.type !== "FIXTURE_WINNER" && source.type !== "FIXTURE_LOSER") continue;
      const origin = byCode.get(source.fixtureCode);
      if (!origin) throw new Error(`对阵 ${fixture.code} 引用了不存在的 ${source.fixtureCode}`);
      if (origin.kind === "GROUP" || origin.round >= fixture.round) {
        throw new Error(`对阵 ${fixture.code} 引用的 ${source.fixtureCode} 不在更早的淘汰轮次，依赖成环`);
      }
      const key = sourceKey(source);
      if (used.has(key)) throw new Error(`${source.fixtureCode} 的${source.type === "FIXTURE_WINNER" ? "胜者" : "负者"}被引用了两次`);
      used.add(key);
    }
    if (fixture.kind === "GROUP" && (fixture.sideA.type !== "ENTRY" || fixture.sideB.type !== "ENTRY")) {
      throw new Error(`小组对阵 ${fixture.code} 必须是确定的报名单位`);
    }
  }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export function runDraw(input: DrawInput): DrawOutcome {
  const normalized = normalizeInput(input);
  if (!normalized.ok) return normalized;
  const value = normalized.value;
  const random = createDrawRandom(`${DRAW_ALGORITHM_VERSION}|${input.randomSeed}`);
  let layout: DrawLayout;
  if (value.settings.format === "ROUND_ROBIN") {
    layout = { format: "ROUND_ROBIN", groups: [{ code: "A", entryIds: random.shuffle(value.entries.map((entry) => entry.entryId)) }], bracket: null };
  } else if (value.settings.format === "GROUPS_KNOCKOUT") {
    const groups = layoutGroups(value, value.groupCount, random);
    layout = { format: "GROUPS_KNOCKOUT", groups, bracket: layoutGroupQualifiers(value, groups, random) };
  } else {
    layout = { format: "KNOCKOUT", groups: [], bracket: layoutKnockout(value, random) };
  }
  return { ok: true, result: derive(value, layout) };
}

/**
 * 在已有布局上依次应用手动调签，再重新推导对阵与冲突。
 * 不允许破坏「不漏不重、人数均衡、种子分区」；回避冲突变化会如实重新列出。
 */
export function applyAdjustments(input: DrawInput, layout: DrawLayout, adjustments: readonly DrawAdjustment[]): DrawOutcome {
  const normalized = normalizeInput(input);
  if (!normalized.ok) return normalized;
  const value = normalized.value;
  const groups = layout.groups.map((group) => ({ code: group.code, entryIds: [...group.entryIds] }));
  const bracket = layout.bracket ? { size: layout.bracket.size, slots: [...layout.bracket.slots] } : null;
  const label = (entryId: string) => value.byId.get(entryId)?.code ?? "未知报名单位";

  for (const [index, adjustment] of adjustments.entries()) {
    const step = `第 ${index + 1} 次调签`;
    if (!adjustment.reason.trim()) return { ok: false, errors: [`${step}必须填写原因。`] };
    if (adjustment.type === "SWAP") {
      const { entryA, entryB } = adjustment;
      if (entryA === entryB) return { ok: false, errors: [`${step}：不能与自己交换。`] };
      if (!value.byId.has(entryA) || !value.byId.has(entryB)) return { ok: false, errors: [`${step}：报名单位不在本次名单中。`] };
      if (layout.format === "KNOCKOUT") {
        if (value.seedByEntry.has(entryA) || value.seedByEntry.has(entryB)) {
          return { ok: false, errors: [`${step}：种子签位由规则决定，不能手动调换；如需调整请修改种子设置后重新抽签。`] };
        }
        const slots = bracket?.slots ?? [];
        const ia = slots.findIndex((slot) => slot?.type === "ENTRY" && slot.entryId === entryA);
        const ib = slots.findIndex((slot) => slot?.type === "ENTRY" && slot.entryId === entryB);
        if (ia < 0 || ib < 0) return { ok: false, errors: [`${step}：报名单位不在签表中。`] };
        [slots[ia], slots[ib]] = [slots[ib], slots[ia]];
      } else {
        const ga = groups.find((group) => group.entryIds.includes(entryA));
        const gb = groups.find((group) => group.entryIds.includes(entryB));
        if (!ga || !gb) return { ok: false, errors: [`${step}：报名单位不在分组中。`] };
        if (ga === gb) return { ok: false, errors: [`${step}：${label(entryA)} 与 ${label(entryB)} 已在同一组，交换没有意义。`] };
        ga.entryIds[ga.entryIds.indexOf(entryA)] = entryB;
        gb.entryIds[gb.entryIds.indexOf(entryB)] = entryA;
      }
    } else {
      if (layout.format === "KNOCKOUT") return { ok: false, errors: [`${step}：单淘汰只能交换签位，不能移组。`] };
      const from = groups.find((group) => group.entryIds.includes(adjustment.entryId));
      const to = groups.find((group) => group.code === adjustment.toGroup);
      if (!from) return { ok: false, errors: [`${step}：报名单位不在分组中。`] };
      if (!to) return { ok: false, errors: [`${step}：目标小组不存在。`] };
      if (from === to) return { ok: false, errors: [`${step}：${label(adjustment.entryId)} 已在 ${to.code} 组。`] };
      from.entryIds = from.entryIds.filter((id) => id !== adjustment.entryId);
      to.entryIds = [...to.entryIds, adjustment.entryId];
    }
    // 每一步之后都检查硬约束。
    if (layout.format !== "KNOCKOUT") {
      const sizes = groups.map((group) => group.entryIds.length);
      if (Math.max(...sizes) - Math.min(...sizes) > 1) {
        return { ok: false, errors: [`${step}：调整后各组人数 ${sizes.join("/")} 相差超过 1，请改用交换。`] };
      }
      const minimum = layout.format === "GROUPS_KNOCKOUT" ? Math.max(GROUP_SIZE.hardMin, value.settings.qualifiersPerGroup + 1) : 2;
      if (Math.min(...sizes) < minimum) return { ok: false, errors: [`${step}：调整后有小组不足 ${minimum} 个报名单位。`] };
      for (const group of groups) {
        const seeds = group.entryIds.filter((id) => value.seedByEntry.has(id));
        if (seeds.length > 1) {
          return { ok: false, errors: [`${step}：调整后 ${group.code} 组有 ${seeds.length} 个种子（${seeds.map(label).join("、")}），每组最多 1 个。`] };
        }
      }
    }
  }
  // 不漏不重：布局必须恰好覆盖名单一次。
  const placed = layout.format === "KNOCKOUT"
    ? (bracket?.slots ?? []).flatMap((slot) => (slot?.type === "ENTRY" ? [slot.entryId] : []))
    : groups.flatMap((group) => group.entryIds);
  const expected = value.entries.map((entry) => entry.entryId).sort();
  if (placed.length !== expected.length || [...placed].sort().some((id, index) => id !== expected[index])) {
    return { ok: false, errors: ["布局与报名名单不一致（有遗漏或重复），拒绝继续。"] };
  }
  return { ok: true, result: derive(value, { format: layout.format, groups, bracket }) };
}

/** 从已保存的种子、输入与调签记录重新计算，用于发布前核对「结果可复现」。 */
export function replayDraw(input: DrawInput, adjustments: readonly DrawAdjustment[]): DrawOutcome {
  const base = runDraw(input);
  if (!base.ok || !adjustments.length) return base;
  return applyAdjustments(input, base.result.layout, adjustments);
}

/**
 * 团体小组积分榜的纯规则。无 IO、无框架。
 *
 * 排名依据（项目默认，参照团体赛常见做法，正式规程须由组织者采纳）：
 * 1. 对抗胜场多者列前；
 * 2. 两队胜场相同：看两队之间那场对抗的胜负；
 * 3. 三队及以上胜场相同：依次比较组内全部对抗的小场胜负差、局数差、分数差；
 *    比较后仍剩两队相同时看两队之间的胜负，仍剩三队及以上相同时须抽签决定。
 * 只统计已结束（全部小场都有最终去向）的对抗。系统不替组织者抽签，无法区分的名次交由裁判长确认。
 */

export interface StandingTie {
  sideA: string;
  sideB: string;
  complete: boolean;
  winner: "A" | "B" | null;
  rubbers: { A: number; B: number };
  games: { A: number; B: number };
  points: { A: number; B: number };
}

export type StandingBasis = "WINS" | "HEAD_TO_HEAD" | "DIFFERENTIALS" | "LOTS";

export const STANDING_BASIS_LABEL: Record<StandingBasis, string> = {
  WINS: "对抗胜场",
  HEAD_TO_HEAD: "相互间胜负",
  DIFFERENTIALS: "小场/局/分差",
  LOTS: "须抽签",
};

export interface StandingRow {
  entryId: string;
  played: number;
  won: number;
  lost: number;
  rubbersWon: number;
  rubbersLost: number;
  gamesWon: number;
  gamesLost: number;
  pointsWon: number;
  pointsLost: number;
  /** 名次；须抽签的几队共用同一个起始名次。 */
  position: number;
  basis: StandingBasis;
}

export interface GroupStandings {
  rows: StandingRow[];
  /** 组内全部对抗都已结束。 */
  complete: boolean;
  /** 须抽签才能区分的报名单位（每组按当前排序）。 */
  unresolved: string[][];
}

function emptyRow(entryId: string): StandingRow {
  return {
    entryId,
    played: 0,
    won: 0,
    lost: 0,
    rubbersWon: 0,
    rubbersLost: 0,
    gamesWon: 0,
    gamesLost: 0,
    pointsWon: 0,
    pointsLost: 0,
    position: 0,
    basis: "WINS",
  };
}

function headToHead(ties: readonly StandingTie[], left: string, right: string): string | null {
  const tie = ties.find(
    (item) => item.complete && ((item.sideA === left && item.sideB === right) || (item.sideA === right && item.sideB === left)),
  );
  if (!tie || !tie.winner) return null;
  return tie.winner === "A" ? tie.sideA : tie.sideB;
}

function diffKey(row: StandingRow) {
  return [row.rubbersWon - row.rubbersLost, row.gamesWon - row.gamesLost, row.pointsWon - row.pointsLost];
}

function compareDiffs(left: StandingRow, right: StandingRow) {
  const a = diffKey(left);
  const b = diffKey(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

/** 规范顺序：输入名单顺序作为最后的稳定排序依据，不含任何随机性。 */
export function computeStandings(entryIds: readonly string[], ties: readonly StandingTie[]): GroupStandings {
  const rows = new Map(entryIds.map((id) => [id, emptyRow(id)]));
  for (const tie of ties) {
    if (!tie.complete) continue;
    const a = rows.get(tie.sideA);
    const b = rows.get(tie.sideB);
    if (!a || !b) continue;
    a.played += 1;
    b.played += 1;
    if (tie.winner === "A") {
      a.won += 1;
      b.lost += 1;
    } else if (tie.winner === "B") {
      b.won += 1;
      a.lost += 1;
    }
    a.rubbersWon += tie.rubbers.A;
    a.rubbersLost += tie.rubbers.B;
    b.rubbersWon += tie.rubbers.B;
    b.rubbersLost += tie.rubbers.A;
    a.gamesWon += tie.games.A;
    a.gamesLost += tie.games.B;
    b.gamesWon += tie.games.B;
    b.gamesLost += tie.games.A;
    a.pointsWon += tie.points.A;
    a.pointsLost += tie.points.B;
    b.pointsWon += tie.points.B;
    b.pointsLost += tie.points.A;
  }

  const ordered: StandingRow[] = [];
  const unresolved: string[][] = [];
  const inputOrder = new Map(entryIds.map((id, index) => [id, index]));
  const stable = (left: StandingRow, right: StandingRow) => (inputOrder.get(left.entryId) ?? 0) - (inputOrder.get(right.entryId) ?? 0);

  const resolvePair = (pair: StandingRow[]) => {
    const winner = headToHead(ties, pair[0].entryId, pair[1].entryId);
    if (!winner) {
      pair.forEach((row) => (row.basis = "LOTS"));
      unresolved.push(pair.map((row) => row.entryId));
      return pair;
    }
    const sorted = winner === pair[0].entryId ? pair : [pair[1], pair[0]];
    sorted.forEach((row) => (row.basis = "HEAD_TO_HEAD"));
    return sorted;
  };

  const all = [...rows.values()].sort((left, right) => right.won - left.won || stable(left, right));
  let index = 0;
  while (index < all.length) {
    const block = all.filter((row) => row.won === all[index].won);
    index += block.length;
    if (block.length === 1) {
      block[0].basis = "WINS";
      ordered.push(block[0]);
      continue;
    }
    if (block.length === 2) {
      ordered.push(...resolvePair(block));
      continue;
    }
    const byDiff = [...block].sort((left, right) => compareDiffs(left, right) || stable(left, right));
    let cursor = 0;
    while (cursor < byDiff.length) {
      const sub = byDiff.filter((row) => compareDiffs(row, byDiff[cursor]) === 0);
      cursor += sub.length;
      if (sub.length === 1) {
        sub[0].basis = "DIFFERENTIALS";
        ordered.push(sub[0]);
      } else if (sub.length === 2) {
        ordered.push(...resolvePair(sub));
      } else {
        sub.forEach((row) => (row.basis = "LOTS"));
        unresolved.push(sub.map((row) => row.entryId));
        ordered.push(...sub);
      }
    }
  }

  // 名次：须抽签的一组共用起始名次，其余按顺序递增。
  const lotsOf = new Map<string, string[]>();
  for (const group of unresolved) for (const id of group) lotsOf.set(id, group);
  let position = 1;
  for (let cursor = 0; cursor < ordered.length; ) {
    const group = lotsOf.get(ordered[cursor].entryId);
    const span = group ? group.length : 1;
    for (let offset = 0; offset < span; offset += 1) ordered[cursor + offset].position = position;
    position += span;
    cursor += span;
  }

  const expected = (entryIds.length * (entryIds.length - 1)) / 2;
  const completeTies = ties.filter((tie) => tie.complete && rows.has(tie.sideA) && rows.has(tie.sideB)).length;
  return { rows: ordered, complete: completeTies >= expected && ties.every((tie) => tie.complete), unresolved };
}

/**
 * 裁判长确认名次：无法区分的几队须给出抽签后的顺序，其余名次不能改动。
 * 返回最终顺序（报名单位 ID），或错误。
 */
export function applyConfirmedOrder(
  standings: GroupStandings,
  submitted: readonly string[] | null | undefined,
): { order: string[] | null; error: string | null } {
  const computed = standings.rows.map((row) => row.entryId);
  if (!standings.complete) return { order: null, error: "本组还有对抗未结束，不能确认名次" };
  if (!standings.unresolved.length) {
    if (submitted && submitted.length && submitted.join() !== computed.join()) {
      return { order: null, error: "本组名次已由成绩确定，不能手动改动" };
    }
    return { order: computed, error: null };
  }
  if (!submitted || submitted.length !== computed.length || new Set(submitted).size !== computed.length) {
    return { order: null, error: "有名次须抽签决定，请按抽签结果给出本组完整顺序" };
  }
  if (submitted.some((id) => !computed.includes(id))) return { order: null, error: "顺序中含有不属于本组的报名单位" };
  const lotsOf = new Map<string, number>();
  standings.unresolved.forEach((group, index) => group.forEach((id) => lotsOf.set(id, index)));
  for (let position = 0; position < computed.length; position += 1) {
    const expected = computed[position];
    const actual = submitted[position];
    if (expected === actual) continue;
    const expectedGroup = lotsOf.get(expected);
    if (expectedGroup === undefined || lotsOf.get(actual) !== expectedGroup) {
      return { order: null, error: "只能调整须抽签的几队之间的先后，其余名次由成绩决定" };
    }
  }
  return { order: [...submitted], error: null };
}

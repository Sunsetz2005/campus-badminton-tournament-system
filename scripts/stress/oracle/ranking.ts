/**
 * 独立的小组排名（§8.5）。**不引用 src/domain**，按知识库文字实现：
 *
 * 个人项目（《分组排名与特殊结果》规则链）：
 *   1. 全部有效小组比赛胜场；
 *   2. 恰好两方并列看直接胜负（缺有效直接对赛 → 待裁定）；
 *   3. 三方及以上比较整个小组有效比赛净胜局；分层后剩两方回到直接胜负；
 *   4. 仍三方及以上比整个小组净胜分；剩两方回到直接胜负；
 *   5. 仍完全相同 → 并列待裁定（裁判长抽签）。不在缩小的子集上重算。
 *   有效比赛 = 经复核锁定且正常完赛（NORMAL）的组内比赛；被排除单位的全部对阵不计。
 *
 * 团体项目（追踪矩阵 TEAM-006 的文字）：对抗胜场 → 两队看相互胜负 → 三队及以上比小场差、局差、分差 → 仍同须抽签。
 *   文档没有写「三队分层后剩两队是否回到相互胜负」，这里**按个人项目同样的做法回到直接胜负**，作为口径假设记入报告；
 *   若与系统不一致，先列为「口径差异」而不是 bug。
 *   另一口径 `pairRule: "AFTER_ALL"`：小场差、局差、分差全部比完仍剩两队才看相互胜负（系统 standings.ts 注释所写的做法），
 *   只用于判定里区分「口径差异」与真正的错，不作为期望值。
 */

export interface RankedMatch {
  a: string;
  b: string;
  winner: string | null;
  /** 个人：逐局比分；团体：小场汇总（rubbersA/B 为小场胜数）。 */
  gamesA: number;
  gamesB: number;
  pointsA: number;
  pointsB: number;
  rubbersA?: number;
  rubbersB?: number;
}

export interface RankingOutcome {
  order: string[];
  /** 无法区分、须抽签的并列块（按名次顺序）。 */
  unresolved: string[][];
  steps: Record<string, string>;
}

type Metric = "gameDiff" | "pointDiff" | "rubberDiff";

export type PairRule = "EACH_LEVEL" | "AFTER_ALL";

export function rankGroup(entries: readonly string[], matches: readonly RankedMatch[], kind: "INDIVIDUAL" | "TEAM", pairRule: PairRule = "EACH_LEVEL"): RankingOutcome {
  const stats = new Map(entries.map((id) => [id, { wins: 0, gameDiff: 0, pointDiff: 0, rubberDiff: 0 }]));
  for (const match of matches) {
    const a = stats.get(match.a);
    const b = stats.get(match.b);
    if (!a || !b) continue;
    if (match.winner === match.a) a.wins += 1;
    else if (match.winner === match.b) b.wins += 1;
    a.gameDiff += match.gamesA - match.gamesB;
    b.gameDiff += match.gamesB - match.gamesA;
    a.pointDiff += match.pointsA - match.pointsB;
    b.pointDiff += match.pointsB - match.pointsA;
    if (match.rubbersA !== undefined && match.rubbersB !== undefined) {
      a.rubberDiff += match.rubbersA - match.rubbersB;
      b.rubberDiff += match.rubbersB - match.rubbersA;
    }
  }
  const chain: Metric[] = kind === "TEAM" ? ["rubberDiff", "gameDiff", "pointDiff"] : ["gameDiff", "pointDiff"];
  const steps: Record<string, string> = {};
  const unresolved: string[][] = [];

  const headToHead = (x: string, y: string) => {
    const decisive = matches.filter((match) => ((match.a === x && match.b === y) || (match.a === y && match.b === x)) && match.winner);
    if (decisive.length !== 1) return null;
    return decisive[0].winner === x ? [x, y] : [y, x];
  };

  const resolve = (block: string[], level: number, label: string): string[] => {
    if (block.length === 1) {
      steps[block[0]] = label;
      return block;
    }
    if (block.length === 2 && (pairRule === "EACH_LEVEL" || level === 0 || level >= chain.length)) {
      const decided = headToHead(block[0], block[1]);
      if (decided) {
        steps[decided[0]] = `${label}→直接胜负`;
        steps[decided[1]] = `${label}→直接胜负`;
        return decided;
      }
      unresolved.push([...block].sort());
      for (const id of block) steps[id] = `${label}→直接胜负无法区分→抽签`;
      return [...block].sort();
    }
    if (level >= chain.length) {
      unresolved.push([...block].sort());
      for (const id of block) steps[id] = `${label}→完全相同→抽签`;
      return [...block].sort();
    }
    const metric = chain[level];
    return splitBy(block, (id) => stats.get(id)![metric]).flatMap((sub) => resolve(sub, level + 1, `${label}→${metric}`));
  };

  const order = splitBy([...entries], (id) => stats.get(id)!.wins).flatMap((block) => resolve(block, 0, "胜场"));
  return { order, unresolved, steps };
}

/** 按指标从大到小分层，同值的放在同一块。 */
function splitBy(ids: string[], value: (id: string) => number) {
  const sorted = [...ids].sort((x, y) => value(y) - value(x) || x.localeCompare(y));
  const blocks: string[][] = [];
  for (const id of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && value(last[0]) === value(id)) last.push(id);
    else blocks.push([id]);
  }
  return blocks;
}

/**
 * 给定系统确认的顺序，判断它是否与独立计算一致：并列块内的先后由抽签决定，只要求块的集合与位置相同。
 */
export function compareRanking(expected: RankingOutcome, confirmed: readonly string[]) {
  if (expected.order.length !== confirmed.length) return [`名次人数 期望 ${expected.order.length} 实际 ${confirmed.length}`];
  const blockOf = new Map<string, number>();
  expected.unresolved.forEach((block, index) => block.forEach((id) => blockOf.set(id, index)));
  const differences: string[] = [];
  for (let position = 0; position < confirmed.length; position += 1) {
    const want = expected.order[position];
    const got = confirmed[position];
    if (want === got) continue;
    const block = blockOf.get(want);
    if (block === undefined || blockOf.get(got) !== block) differences.push(`第 ${position + 1} 名 期望 ${want} 实际 ${got}`);
  }
  return differences;
}

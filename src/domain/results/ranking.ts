/**
 * 个人项目小组名次的纯规则。无 IO、无框架。
 *
 * 组内排名规则与每球计分规则分开：这里只读取「结果事实」，不关心比赛是怎么记分的。
 * 方案依据 BWF General Competition Regulations 16.2（2024-11 V6.0），由用户 2026-10-27 授权采用（赛务口径 R-1、R-3）。
 * 已确认的历史名次保存了确认时的方案键与版本（旧键 `campus-demo` v1），可据此复现。
 */

import type { MatchResultFact } from "@/domain/results/match-result";

export interface RankingProfile {
  key: string;
  version: number;
  name: string;
  /** 演示方案：须组织者确认后才能正式使用。 */
  demo: boolean;
  notice: string;
  rules: readonly string[];
}

/**
 * BWF 小组排名方案（GCR 16.2）：
 * 1. 只统计经裁判长复核锁定的组内比赛，按获胜场数降序（16.2.1）；
 * 2. 同胜场恰好两方：看两方直接对赛结果（16.2.2）；缺少有效直接对赛则待处理；
 * 3. 同胜场三方或以上：比较整个小组的净胜局（16.2.3），剩两方看直接对赛（16.2.3.1）；
 * 4. 仍有三方或以上再比整个小组的净胜分（16.2.4），剩两方看直接对赛（16.2.4.1）；三方或以上完全相同抽签（16.2.4.2），
 *    由裁判长记录抽签依据。
 * 不在缩小的同分子集上递归重算，不用得失分比例、报名时间、姓名、数据库 ID 或种子顺位决胜。
 * 没有打完全部小组比赛的单位（弃权、退赛、取消资格的负方）全部小组成绩自动删除（16.2.5）；
 * 终止待裁决（无胜方）的比赛仍须裁判长先处理。
 */
export const GROUP_RANKING: RankingProfile = Object.freeze({
  key: "bwf-gcr-16-2",
  version: 1,
  name: "BWF 小组排名方案",
  demo: false,
  notice: "依据 BWF《竞赛通则》（GCR 2024-11 V6.0）第 16.2 条。",
  rules: Object.freeze([
    "只统计经裁判长复核锁定的组内比赛，先比获胜场数（16.2.1）。",
    "同胜场恰好两方：比两方之间的直接对赛（16.2.2）；缺少有效直接对赛时待裁判长处理。",
    "同胜场三方或以上：比整个小组的净胜局；比完剩两方时看直接对赛（16.2.3）。",
    "仍有三方或以上：比整个小组的净胜分；剩两方看直接对赛，三方或以上完全相同由裁判长抽签并记录依据（16.2.4）。",
    "因弃权、退赛、取消资格没有打完全部小组比赛的单位，全部小组成绩自动删除（16.2.5）；终止待裁决的比赛须裁判长先处理。",
  ]),
}) as RankingProfile;

export interface RankingMatch {
  id: string;
  code: string;
  sideA: string;
  sideB: string;
  fact: MatchResultFact;
}

export interface RankingExclusionInput {
  entryId: string;
  reason: string;
  /** 由 16.2.5 自动删除（未打完全部小组比赛），不是裁判长手工排除。 */
  automatic?: boolean;
}

export interface RankingInput {
  /** 规范顺序（例如报名编号），只作为展示时的稳定次序，不参与决胜。 */
  entryIds: readonly string[];
  matches: readonly RankingMatch[];
  excluded?: readonly RankingExclusionInput[];
}

export type RankingStep =
  | { kind: "WINS"; wins: number; tiedWith: string[] }
  | { kind: "HEAD_TO_HEAD"; opponent: string; won: boolean | null; matchCode: string | null }
  | { kind: "NET_GAMES"; value: number; tiedWith: string[] }
  | { kind: "NET_POINTS"; value: number; tiedWith: string[] }
  | { kind: "UNRESOLVED"; tiedWith: string[]; reason: "LOTS" | "NO_HEAD_TO_HEAD" };

export type RankingBasis = "WINS" | "HEAD_TO_HEAD" | "NET_GAMES" | "NET_POINTS" | "UNRESOLVED";

export const RANKING_BASIS_LABEL: Record<RankingBasis, string> = {
  WINS: "胜场",
  HEAD_TO_HEAD: "直接对赛",
  NET_GAMES: "净胜局",
  NET_POINTS: "净胜分",
  UNRESOLVED: "并列待裁定",
};

export interface RankingRow {
  entryId: string;
  played: number;
  won: number;
  lost: number;
  gamesWon: number;
  gamesLost: number;
  pointsWon: number;
  pointsLost: number;
  netGames: number;
  netPoints: number;
  /** 名次；并列待裁定的几方共用同一起始名次。 */
  position: number;
  /** 最终区分该名次所采用的比较项。 */
  basis: RankingBasis;
  steps: RankingStep[];
}

export type RankingStatus = "READY" | "PROVISIONAL" | "NEEDS_DECISION" | "BLOCKED";

export const RANKING_STATUS_LABEL: Record<RankingStatus, string> = {
  READY: "可确认",
  PROVISIONAL: "暂定（尚有比赛未正式确认）",
  NEEDS_DECISION: "并列待裁定",
  BLOCKED: "有特殊结果待处理",
};

export interface RankingBlocker {
  code: "SPECIAL_OUTCOME";
  matchCode: string;
  entryIds: [string, string];
  outcome: string;
}

export interface GroupRanking {
  profile: Pick<RankingProfile, "key" | "version" | "name" | "demo">;
  status: RankingStatus;
  rows: RankingRow[];
  excluded: RankingExclusionInput[];
  /** 并列待裁定的几组（按当前排序）。 */
  unresolved: string[][];
  blockers: RankingBlocker[];
  /** 尚未正式确认、因此不计入的比赛。 */
  pendingMatchCodes: string[];
  /** 计入统计的比赛。 */
  countedMatchCodes: string[];
  /** 因涉及被排除单位而不计入的比赛。 */
  excludedMatchCodes: string[];
}

const OUTCOME_REASON: Record<string, string> = { WO: "弃权", RET: "退赛", DSQ: "取消资格" };

function emptyRow(entryId: string): RankingRow {
  return {
    entryId,
    played: 0,
    won: 0,
    lost: 0,
    gamesWon: 0,
    gamesLost: 0,
    pointsWon: 0,
    pointsLost: 0,
    netGames: 0,
    netPoints: 0,
    position: 0,
    basis: "WINS",
    steps: [],
  };
}

export function computeGroupRanking(input: RankingInput, profile: RankingProfile = GROUP_RANKING): GroupRanking {
  const excluded = [...(input.excluded ?? [])];
  const excludedIds = new Set(excluded.map((item) => item.entryId));
  const canonicalIds = new Set(input.entryIds);
  // 16.2.5：弃权、退赛、取消资格的负方没有打完全部小组比赛，全部小组成绩删除（等同排除），自动生效。
  for (const match of input.matches) {
    if (match.fact.stage !== "CONFIRMED" || !match.fact.winner) continue;
    if (!match.fact.outcome || !(match.fact.outcome in OUTCOME_REASON)) continue;
    if (!canonicalIds.has(match.sideA) || !canonicalIds.has(match.sideB)) continue;
    const loser = match.fact.winner === "A" ? match.sideB : match.sideA;
    if (excludedIds.has(loser)) continue;
    excludedIds.add(loser);
    excluded.push({ entryId: loser, reason: `${match.code} ${OUTCOME_REASON[match.fact.outcome] ?? match.fact.outcome}，未打完全部小组比赛，成绩按 BWF GCR 16.2.5 删除。`, automatic: true });
  }
  const ranked = input.entryIds.filter((id) => !excludedIds.has(id));
  const rows = new Map(ranked.map((id) => [id, emptyRow(id)]));
  const canonical = new Map(input.entryIds.map((id, index) => [id, index]));
  const stable = (left: RankingRow, right: RankingRow) => (canonical.get(left.entryId) ?? 0) - (canonical.get(right.entryId) ?? 0);

  const valid: RankingMatch[] = [];
  const blockers: RankingBlocker[] = [];
  const pendingMatchCodes: string[] = [];
  const excludedMatchCodes: string[] = [];
  for (const match of input.matches) {
    if (!canonical.has(match.sideA) || !canonical.has(match.sideB)) continue;
    if (excludedIds.has(match.sideA) || excludedIds.has(match.sideB)) {
      excludedMatchCodes.push(match.code);
      continue;
    }
    if (match.fact.stage !== "CONFIRMED") {
      pendingMatchCodes.push(match.code);
      continue;
    }
    if (match.fact.outcome !== "NORMAL" || !match.fact.winner) {
      blockers.push({ code: "SPECIAL_OUTCOME", matchCode: match.code, entryIds: [match.sideA, match.sideB], outcome: match.fact.outcome ?? "UNKNOWN" });
      continue;
    }
    valid.push(match);
  }

  for (const match of valid) {
    const a = rows.get(match.sideA) as RankingRow;
    const b = rows.get(match.sideB) as RankingRow;
    a.played += 1;
    b.played += 1;
    if (match.fact.winner === "A") {
      a.won += 1;
      b.lost += 1;
    } else {
      b.won += 1;
      a.lost += 1;
    }
    for (const game of match.fact.games) {
      a.pointsWon += game.a;
      a.pointsLost += game.b;
      b.pointsWon += game.b;
      b.pointsLost += game.a;
      if (game.a > game.b) {
        a.gamesWon += 1;
        b.gamesLost += 1;
      } else {
        b.gamesWon += 1;
        a.gamesLost += 1;
      }
    }
  }
  for (const row of rows.values()) {
    row.netGames = row.gamesWon - row.gamesLost;
    row.netPoints = row.pointsWon - row.pointsLost;
  }

  const headToHead = (left: string, right: string) =>
    valid.find((match) => (match.sideA === left && match.sideB === right) || (match.sideA === right && match.sideB === left)) ?? null;

  const unresolved: string[][] = [];
  const ordered: RankingRow[] = [];

  const markUnresolved = (block: RankingRow[], reason: "LOTS" | "NO_HEAD_TO_HEAD") => {
    const ids = block.map((row) => row.entryId);
    for (const row of block) {
      row.basis = "UNRESOLVED";
      row.steps.push({ kind: "UNRESOLVED", tiedWith: ids.filter((id) => id !== row.entryId), reason });
    }
    unresolved.push(ids);
    ordered.push(...block);
  };

  const resolvePair = (pair: RankingRow[]) => {
    const [first, second] = pair;
    const match = headToHead(first.entryId, second.entryId);
    if (!match) {
      first.steps.push({ kind: "HEAD_TO_HEAD", opponent: second.entryId, won: null, matchCode: null });
      second.steps.push({ kind: "HEAD_TO_HEAD", opponent: first.entryId, won: null, matchCode: null });
      markUnresolved(pair, "NO_HEAD_TO_HEAD");
      return;
    }
    const winnerId = match.fact.winner === "A" ? match.sideA : match.sideB;
    const sorted = winnerId === first.entryId ? [first, second] : [second, first];
    sorted[0].steps.push({ kind: "HEAD_TO_HEAD", opponent: sorted[1].entryId, won: true, matchCode: match.code });
    sorted[1].steps.push({ kind: "HEAD_TO_HEAD", opponent: sorted[0].entryId, won: false, matchCode: match.code });
    for (const row of sorted) row.basis = "HEAD_TO_HEAD";
    ordered.push(...sorted);
  };

  /** 按某一个整组指标分层：每层 1 方即定，2 方回到直接对赛，3 方及以上交给下一项。 */
  const splitBy = (
    block: RankingRow[],
    kind: "NET_GAMES" | "NET_POINTS",
    value: (row: RankingRow) => number,
    next: (sub: RankingRow[]) => void,
  ) => {
    const sorted = [...block].sort((left, right) => value(right) - value(left) || stable(left, right));
    for (let cursor = 0; cursor < sorted.length; ) {
      const layer = sorted.filter((row) => value(row) === value(sorted[cursor]));
      cursor += layer.length;
      for (const row of layer) {
        row.steps.push({ kind, value: value(row), tiedWith: layer.filter((other) => other !== row).map((other) => other.entryId) });
      }
      if (layer.length === 1) {
        layer[0].basis = kind;
        ordered.push(layer[0]);
      } else if (layer.length === 2) {
        resolvePair(layer);
      } else {
        next(layer);
      }
    }
  };

  const byWins = [...rows.values()].sort((left, right) => right.won - left.won || stable(left, right));
  for (let cursor = 0; cursor < byWins.length; ) {
    const block = byWins.filter((row) => row.won === byWins[cursor].won);
    cursor += block.length;
    for (const row of block) {
      row.steps.push({ kind: "WINS", wins: row.won, tiedWith: block.filter((other) => other !== row).map((other) => other.entryId) });
    }
    if (block.length === 1) {
      block[0].basis = "WINS";
      ordered.push(block[0]);
    } else if (block.length === 2) {
      resolvePair(block);
    } else {
      splitBy(block, "NET_GAMES", (row) => row.netGames, (layer) =>
        splitBy(layer, "NET_POINTS", (row) => row.netPoints, (rest) => markUnresolved(rest, "LOTS")),
      );
    }
  }

  const blockOf = new Map<string, string[]>();
  for (const group of unresolved) for (const id of group) blockOf.set(id, group);
  let position = 1;
  for (let cursor = 0; cursor < ordered.length; ) {
    const span = blockOf.get(ordered[cursor].entryId)?.length ?? 1;
    for (let offset = 0; offset < span; offset += 1) ordered[cursor + offset].position = position;
    position += span;
    cursor += span;
  }

  let status: RankingStatus = "READY";
  if (blockers.length) status = "BLOCKED";
  else if (pendingMatchCodes.length) status = "PROVISIONAL";
  else if (unresolved.length) status = "NEEDS_DECISION";

  return {
    profile: { key: profile.key, version: profile.version, name: profile.name, demo: profile.demo },
    status,
    rows: ordered,
    excluded,
    unresolved,
    blockers,
    pendingMatchCodes,
    countedMatchCodes: valid.map((match) => match.code),
    excludedMatchCodes,
  };
}

/**
 * 裁判长确认名次：只有「可确认」或「并列待裁定」可以确认；
 * 并列待裁定的几方必须按抽签/裁定结果给出完整顺序，其余名次由成绩决定、不能改动。
 */
export function applyRankingDecision(
  ranking: GroupRanking,
  submitted: readonly string[] | null | undefined,
): { order: string[] | null; error: string | null } {
  if (ranking.status === "BLOCKED") return { order: null, error: "本组有特殊结果尚未处理，不能确认正式名次" };
  if (ranking.status === "PROVISIONAL") return { order: null, error: "本组还有比赛未经裁判长复核锁定，只能显示暂定名次" };
  const computed = ranking.rows.map((row) => row.entryId);
  if (!ranking.unresolved.length) {
    if (submitted && submitted.length && submitted.join() !== computed.join()) {
      return { order: null, error: "本组名次已由成绩确定，不能手动改动" };
    }
    return { order: computed, error: null };
  }
  if (!submitted || submitted.length !== computed.length || new Set(submitted).size !== computed.length) {
    return { order: null, error: "有名次并列待裁定，请按抽签或裁定结果给出本组完整顺序" };
  }
  if (submitted.some((id) => !computed.includes(id))) return { order: null, error: "顺序中含有不属于本组名次的报名单位" };
  const blockIndex = new Map<string, number>();
  ranking.unresolved.forEach((group, index) => group.forEach((id) => blockIndex.set(id, index)));
  for (let position = 0; position < computed.length; position += 1) {
    const expected = computed[position];
    const actual = submitted[position];
    if (expected === actual) continue;
    const group = blockIndex.get(expected);
    if (group === undefined || blockIndex.get(actual) !== group) {
      return { order: null, error: "只能调整并列待裁定的几方之间的先后，其余名次由成绩决定" };
    }
  }
  return { order: [...submitted], error: null };
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

/** 把一步比较写成中文解释（「为什么排在这个位置」）。 */
export function describeStep(step: RankingStep, nameOf: (entryId: string) => string) {
  const names = (ids: string[]) => ids.map(nameOf).join("、");
  switch (step.kind) {
    case "WINS":
      return step.tiedWith.length ? `胜 ${step.wins} 场，与 ${names(step.tiedWith)} 相同` : `胜 ${step.wins} 场，胜场即可区分`;
    case "HEAD_TO_HEAD":
      if (step.won === null) return `与 ${nameOf(step.opponent)} 没有有效的直接对赛结果`;
      return `直接对赛${step.won ? "胜" : "负"} ${nameOf(step.opponent)}（${step.matchCode}）`;
    case "NET_GAMES":
      return step.tiedWith.length ? `全组净胜局 ${signed(step.value)}，与 ${names(step.tiedWith)} 相同` : `全组净胜局 ${signed(step.value)}，由此区分`;
    case "NET_POINTS":
      return step.tiedWith.length ? `全组净胜分 ${signed(step.value)}，与 ${names(step.tiedWith)} 相同` : `全组净胜分 ${signed(step.value)}，由此区分`;
    case "UNRESOLVED":
      return step.reason === "LOTS"
        ? `与 ${names(step.tiedWith)} 各项完全相同，并列待裁定（须记录抽签/裁定依据）`
        : `与 ${names(step.tiedWith)} 缺少有效直接对赛，待裁判长处理`;
  }
}

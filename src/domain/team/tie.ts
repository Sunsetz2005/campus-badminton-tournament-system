/**
 * 团体对抗胜负的纯规则。无 IO、无框架。
 *
 * - 只有裁判长复核锁定的小场结果才计入；比赛中、待提交、待复核的小场都不算。
 * - 先赢下过半小场（5 场为 3 场）的一方赢得对抗。
 * - 小组赛/循环赛「打满」：胜负已定后剩余小场照常进行，结果计入小场、局、分统计；
 *   淘汰赛「决出即止」：胜负已定时尚未开始的小场记为「未进行」，不是弃权、不记比分；
 *   已经开始的小场照常打完并计入。（2026-09-24 用户决定，与国际羽联团体赛通行做法一致。）
 * - 结果被重开后按事实重新推导：胜负可能撤回，「未进行」的小场随之恢复。
 * - 认输与中途退赛（赛务口径 R-4 / W-6，BWF GCR 16.3.8）：一方因伤病、人数不足等不能完成某个小场，
 *   该小场按「认输方不再得分」补完后计入局、分统计（例如 15:21 时退赛记 15:21、0:21）；
 *   负方在本场对抗里退赛或弃权的队员，后续小场不再上场且不得替换，那些小场同样按认输计（GCR 13.6.2）。
 *   比分展示仍用实际比分，补完的比分只用于积分榜统计。
 */

import type { RubberKind } from "@/domain/registration/team-roster";

export type TieSide = "A" | "B";
export type TiePolicy = "PLAY_ALL" | "STOP_WHEN_DECIDED";
export type TieFixtureKind = "GROUP" | "KNOCKOUT" | "THIRD_PLACE";

export const TIE_POLICY_LABEL: Record<TiePolicy, string> = {
  PLAY_ALL: "打满全部小场",
  STOP_WHEN_DECIDED: "决出胜负即止",
};

export function tiePolicyFor(kind: TieFixtureKind): TiePolicy {
  return kind === "GROUP" ? "PLAY_ALL" : "STOP_WHEN_DECIDED";
}

export interface RubberFact {
  order: number;
  kind: RubberKind;
  /** 已经开始（进入计分或有过任何计分事件）。 */
  started: boolean;
  /** 结果已由裁判长复核锁定。 */
  final: boolean;
  /** 锁定结果的胜方；中止等无胜方的结果为 null。 */
  winner: TieSide | null;
  /** 已完成各局比分（锁定结果）；退赛时包含中断局的已得分。 */
  games: readonly { a: number; b: number }[];
  /** 计入积分榜的各局比分：认输、退赛时按 GCR 16.3.8 补完；缺省与 `games` 相同。 */
  countedGames?: readonly { a: number; b: number }[];
}

export interface ConcessionRules {
  bestOf: number;
  targetPoints: number;
  winBy: number;
  capPoints: number;
}

/**
 * GCR 16.3.8：认输方不再得分。先把进行中的那一局补到胜方赢下（不少于目标分、领先 winBy，封顶 capPoints），
 * 再按 目标分:0 补齐胜方还差的局数。`partial` 是中断局的比分（赛前认输为 null）。
 */
export function concededGames(
  games: readonly { a: number; b: number }[],
  partial: { a: number; b: number } | null,
  winner: TieSide,
  rules: ConcessionRules,
): { a: number; b: number }[] {
  const result = games.map((game) => ({ ...game }));
  const needed = Math.floor(rules.bestOf / 2) + 1;
  const wonBy = (side: TieSide) => result.filter((game) => (side === "A" ? game.a > game.b : game.b > game.a)).length;
  const loserScore = partial ? (winner === "A" ? partial.b : partial.a) : 0;
  if (wonBy(winner) < needed && partial && (partial.a > 0 || partial.b > 0)) {
    const winnerScore = Math.min(rules.capPoints, Math.max(rules.targetPoints, loserScore + rules.winBy));
    result.push(winner === "A" ? { a: winnerScore, b: loserScore } : { a: loserScore, b: winnerScore });
  }
  while (wonBy(winner) < needed) {
    result.push(winner === "A" ? { a: rules.targetPoints, b: 0 } : { a: 0, b: rules.targetPoints });
  }
  return result;
}

export type TieStatus = "NOT_STARTED" | "IN_PROGRESS" | "DECIDED" | "COMPLETE" | "NO_RESULT";

export const TIE_STATUS_LABEL: Record<TieStatus, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  DECIDED: "胜负已定",
  COMPLETE: "已结束",
  NO_RESULT: "无法判定",
};

export interface TieSummary {
  policy: TiePolicy;
  needed: number;
  rubbers: Record<TieSide, number>;
  games: Record<TieSide, number>;
  points: Record<TieSide, number>;
  winner: TieSide | null;
  status: TieStatus;
  /** 全部小场都有了最终去向（锁定或「未进行」）。 */
  complete: boolean;
  /** 按规则此刻应当记为「未进行」的小场顺序号。 */
  notPlayedOrders: number[];
}

export function tieWinsNeeded(rubberCount: number) {
  return Math.floor(rubberCount / 2) + 1;
}

export function computeTie(rubbers: readonly RubberFact[], policy: TiePolicy): TieSummary {
  const needed = tieWinsNeeded(rubbers.length);
  const rubbersWon: Record<TieSide, number> = { A: 0, B: 0 };
  const games: Record<TieSide, number> = { A: 0, B: 0 };
  const points: Record<TieSide, number> = { A: 0, B: 0 };
  for (const rubber of rubbers) {
    if (!rubber.final) continue;
    if (rubber.winner) rubbersWon[rubber.winner] += 1;
    for (const game of rubber.countedGames ?? rubber.games) {
      points.A += game.a;
      points.B += game.b;
      if (game.a > game.b) games.A += 1;
      else if (game.b > game.a) games.B += 1;
    }
  }
  const winner: TieSide | null = rubbersWon.A >= needed ? "A" : rubbersWon.B >= needed ? "B" : null;
  const notPlayedOrders =
    winner && policy === "STOP_WHEN_DECIDED"
      ? rubbers.filter((rubber) => !rubber.started && !rubber.final).map((rubber) => rubber.order).sort((a, b) => a - b)
      : [];
  const settled = new Set(notPlayedOrders);
  const complete = rubbers.every((rubber) => rubber.final || settled.has(rubber.order));
  let status: TieStatus;
  if (complete) status = winner ? "COMPLETE" : "NO_RESULT";
  else if (winner) status = "DECIDED";
  else if (rubbers.some((rubber) => rubber.started || rubber.final)) status = "IN_PROGRESS";
  else status = "NOT_STARTED";
  return { policy, needed, rubbers: rubbersWon, games, points, winner, status, complete, notPlayedOrders };
}

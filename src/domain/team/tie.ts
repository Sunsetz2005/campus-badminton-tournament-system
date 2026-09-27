/**
 * 团体对抗胜负的纯规则。无 IO、无框架。
 *
 * - 只有裁判长复核锁定的小场结果才计入；比赛中、待提交、待复核的小场都不算。
 * - 先赢下过半小场（5 场为 3 场）的一方赢得对抗。
 * - 小组赛/循环赛「打满」：胜负已定后剩余小场照常进行，结果计入小场、局、分统计；
 *   淘汰赛「决出即止」：胜负已定时尚未开始的小场记为「未进行」，不是弃权、不记比分；
 *   已经开始的小场照常打完并计入。（2026-09-24 用户决定，与国际羽联团体赛通行做法一致。）
 * - 结果被重开后按事实重新推导：胜负可能撤回，「未进行」的小场随之恢复。
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
    for (const game of rubber.games) {
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

/**
 * 报表数据快照的形状（阶段 7）。纯类型与纯函数，无 IO。
 *
 * 一份快照由服务端在**同一个可重复读、只读事务**中一次取齐（见 `report-snapshot-service.ts`），
 * Excel、打印网页与 PDF 都只从同一份快照渲染，因此同一份成绩册里各表之间不会前后矛盾。
 *
 * 快照只含对外字段：姓名与代表队按 `Tournament.namePolicy` 投影，比赛只取已进入逐场公开边界的，
 * 不含学号、联系方式、内部备注、更正理由、账号或数据库 ID。内部报名名单另走独立的形状。
 */

import type { ResultOutcome, ResultStage } from "@/domain/results/match-result";

export type ReportEditionValue = "DRAFT" | "OFFICIAL";

export const EDITION_LABEL: Record<ReportEditionValue, string> = {
  DRAFT: "草稿（含暂定结果，不作为正式成绩）",
  OFFICIAL: "正式版（仅含经裁判长复核锁定的结果）",
};

export interface ReportSide {
  code: string | null;
  /** 报名单位名称；待定签位显示来源，如「A 组第 1 名」。 */
  name: string;
  /** 成员（公开编号＋按策略公开的姓名）。 */
  members: string[];
  pending: boolean;
}

export interface ReportMatch {
  code: string;
  competitionCode: string;
  competitionName: string;
  stage: string;
  group: string | null;
  /** 对阵标签（如「第 1 轮」「半决赛」）。 */
  round: string | null;
  fixtureCode: string | null;
  /** 团体小场：如「第 2 场 女单」。 */
  rubber: string | null;
  scheduledAt: string | null;
  /** 赛事时区下的日期与时刻。 */
  date: string | null;
  time: string | null;
  estimated: boolean;
  court: string | null;
  sideA: ReportSide;
  sideB: ReportSide;
  resultStage: ResultStage;
  statusLabel: string;
  /** 已正式确认（裁判长复核锁定）。 */
  confirmed: boolean;
  /** 本版本是否给出比分：正式版只给已确认结果，草稿给出已开始比赛的暂定比分。 */
  showResult: boolean;
  outcome: ResultOutcome | null;
  outcomeLabel: string | null;
  winner: "A" | "B" | null;
  games: { a: number; b: number }[];
  partial: { a: number; b: number } | null;
  /** 各局比分（A 方视角），如「21:15 18:21 21:19」；特殊结果的中断局加括号。 */
  scoreline: string;
  gamesWon: string | null;
}

export interface ReportTie {
  code: string;
  competitionCode: string;
  stage: string;
  group: string | null;
  round: string;
  sideA: ReportSide;
  sideB: ReportSide;
  /** 已锁定小场的胜负，如「3:1」。 */
  rubbersWon: string;
  winner: "A" | "B" | null;
  decided: boolean;
  matchCodes: string[];
}

export interface ReportRankingRow {
  position: number | null;
  code: string;
  name: string;
  detail: string | null;
}

export type ReportRankingStatus = "CONFIRMED" | "PUBLISHED" | "PROVISIONAL";

export const RANKING_STATUS_TEXT: Record<ReportRankingStatus, string> = {
  CONFIRMED: "裁判长已确认",
  PUBLISHED: "已发布榜单",
  PROVISIONAL: "暂定（未确认，不作为正式名次）",
};

export interface ReportGroupRanking {
  competitionCode: string;
  group: string;
  status: ReportRankingStatus;
  rows: ReportRankingRow[];
  note: string | null;
}

export interface ReportPlacement {
  competitionCode: string;
  place: number | null;
  label: string;
  code: string;
  name: string;
}

export interface ReportEntry {
  code: string;
  name: string;
  team: string | null;
  members: string[];
}

export interface ReportGroup {
  competitionCode: string;
  stage: string;
  code: string;
  name: string;
  entries: { code: string; name: string }[];
}

export interface ReportCompetition {
  code: string;
  name: string;
  kindLabel: string;
  team: boolean;
  format: string | null;
  entries: ReportEntry[];
  groups: ReportGroup[];
  ties: ReportTie[];
  rankings: ReportGroupRanking[];
  placements: ReportPlacement[];
  placementsNote: string;
  /** 正式版引用的名次榜单发布版本（个人项目）；团体项目为 null。 */
  standingsVersion: number | null;
  /** 已发布榜单之后结果又有更正、尚未重新发布（只在公开页的宽松模式下出现）。 */
  standingsStale: boolean;
}

export interface ReportRule {
  name: string;
  revision: number;
  source: string;
  configHash: string;
  summary: string;
  usedBy: string[];
}

export interface ReportSnapshot {
  schema: 1;
  edition: ReportEditionValue;
  tournament: {
    slug: string;
    name: string;
    subtitle: string | null;
    organizer: string | null;
    venue: string | null;
    dates: string | null;
    timezone: string;
    summary: string | null;
    regulations: string | null;
    namesPublic: boolean;
  };
  rules: ReportRule[];
  rankingProfile: { name: string; version: number; demo: boolean; notice: string; rules: string[] };
  competitions: ReportCompetition[];
  matches: ReportMatch[];
  specialResults: { matchCode: string; text: string }[];
  counts: { matches: number; confirmed: number; unconfirmed: number };
  /** 引用的名次榜单发布版本：项目代码 → 版本号（未发布为 null）。 */
  standings: Record<string, number | null>;
}

/** 快照外的元数据：取数时刻与内容摘要。摘要只覆盖快照本身，不含取数时刻，相同数据得到相同摘要。 */
export interface CapturedSnapshot {
  snapshot: ReportSnapshot;
  capturedAt: Date;
  snapshotHash: string;
}

export function dataRevision(snapshotHash: string) {
  return snapshotHash.slice(0, 12);
}

export function formatScoreline(games: readonly { a: number; b: number }[], partial: { a: number; b: number } | null) {
  const parts = games.map((game) => `${game.a}:${game.b}`);
  if (partial) parts.push(`(${partial.a}:${partial.b})`);
  return parts.join(" ");
}

export function sideLabel(side: ReportSide) {
  if (side.pending || !side.code) return side.name;
  return side.name === side.code ? side.code : `${side.code} ${side.name}`;
}

export function winnerLabel(match: Pick<ReportMatch, "winner" | "sideA" | "sideB" | "showResult">) {
  if (!match.showResult || !match.winner) return "";
  return sideLabel(match.winner === "A" ? match.sideA : match.sideB);
}

/**
 * 报表表格：把一份数据快照转成若干张二维表。纯函数，无 IO。
 *
 * Excel 工作簿与打印/PDF 成绩册共用这里的表格定义，保证同一份快照在两种文件里的
 * 比分、胜方与名次逐字一致；渲染层只负责排版，不再自行计算任何结果或名次。
 */

import {
  dataRevision,
  EDITION_LABEL,
  RANKING_STATUS_TEXT,
  sideLabel,
  winnerLabel,
  type ReportSide,
  type ReportSnapshot,
} from "@/reports/report-model";

export type ReportCellValue = string | number | null;

export interface ReportTable {
  key: "info" | "entries" | "groups" | "fixtures" | "schedule" | "results" | "rankings" | "special";
  title: string;
  columns: { header: string; width: number }[];
  rows: ReportCellValue[][];
  empty: string;
  notes: string[];
}

export interface ReportMeta {
  capturedAt: Date;
  snapshotHash: string;
  /** 本文件的版本号；预览时为 null。 */
  version: number | null;
}

export const MOCK_NOTICE = "本系统当前数据均为模拟赛事，姓名、代表队、日期与成绩均不代表真实比赛。";

function members(side: ReportSide) {
  return side.members.length ? side.members.join("、") : "";
}

function sideCell(side: ReportSide) {
  const label = sideLabel(side);
  const list = members(side);
  return list && list !== label ? `${label}（${list}）` : label;
}

function capturedText(meta: ReportMeta, timeZone: string) {
  const local = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(meta.capturedAt);
  return `${local.replace(/\//g, "-")}（${timeZone}）`;
}

export function reportSubtitle(snapshot: ReportSnapshot, meta: ReportMeta) {
  const edition = snapshot.edition === "OFFICIAL" ? "正式版" : "草稿";
  const version = meta.version ? ` · 第 ${meta.version} 版` : "";
  return `${edition}${version} · 数据修订 ${dataRevision(meta.snapshotHash)} · 取数 ${capturedText(meta, snapshot.tournament.timezone)}`;
}

export function infoRows(snapshot: ReportSnapshot, meta: ReportMeta): [string, string][] {
  const t = snapshot.tournament;
  const standings = Object.entries(snapshot.standings);
  const rows: [string, string][] = [
    ["赛事名称", t.name],
    ["副标题", t.subtitle ?? ""],
    ["主办", t.organizer ?? ""],
    ["场馆", t.venue ?? ""],
    ["比赛日期", t.dates ?? "待定"],
    ["赛事时区", t.timezone],
    ["版本", EDITION_LABEL[snapshot.edition]],
    ["文件版本", meta.version ? `第 ${meta.version} 版` : "预览（未存档）"],
    ["数据修订号", dataRevision(meta.snapshotHash)],
    ["取数时间", capturedText(meta, t.timezone)],
    [
      "名次榜单版本",
      standings.length ? standings.map(([code, version]) => `${code}：${version ? `第 ${version} 版` : "未发布"}`).join("；") : "无个人项目榜单",
    ],
    ["公开比赛", `${snapshot.counts.matches} 场（已正式确认 ${snapshot.counts.confirmed} 场，其余 ${snapshot.counts.unconfirmed} 场未确认）`],
    ["姓名公开", t.namesPublic ? "公开姓名与代表队" : "只公开编号（按赛事姓名公开策略）"],
    ["排名方案", `${snapshot.rankingProfile.name} v${snapshot.rankingProfile.version}${snapshot.rankingProfile.demo ? "（演示配置）" : ""}`],
    ["数据说明", MOCK_NOTICE],
  ];
  for (const rule of snapshot.rules) {
    rows.push([`计分规则 · ${rule.name} r${rule.revision}`, `${rule.summary}；来源 ${rule.source}；配置摘要 ${rule.configHash}${rule.usedBy.length ? `；用于 ${rule.usedBy.join("、")}` : ""}`]);
  }
  return rows;
}

export function buildReportTables(snapshot: ReportSnapshot, meta: ReportMeta): ReportTable[] {
  const official = snapshot.edition === "OFFICIAL";
  const tables: ReportTable[] = [];

  tables.push({
    key: "info",
    title: "说明",
    columns: [
      { header: "项目", width: 22 },
      { header: "内容", width: 90 },
    ],
    rows: infoRows(snapshot, meta),
    empty: "",
    notes: [
      official
        ? "正式版只引用经裁判长复核锁定的结果；未确认的比赛只列状态，不列比分。"
        : "草稿：暂定比分与暂定名次可能变化，不作为正式成绩。",
      "逐局比分一律按 A 方:B 方 记录；特殊结果中止局以括号标出实际比分，不补满。",
    ],
  });

  tables.push({
    key: "entries",
    title: "参赛名单",
    columns: [
      { header: "项目", width: 14 },
      { header: "编号", width: 12 },
      { header: "名称", width: 26 },
      { header: "成员", width: 48 },
      { header: "代表队", width: 22 },
    ],
    rows: snapshot.competitions.flatMap((competition) =>
      competition.entries.map((entry) => [competition.name, entry.code, entry.name, entry.members.join("、"), entry.team ?? ""]),
    ),
    empty: "没有已审核通过的报名单位。",
    notes: ["公开版名单：不含学号、联系方式与报名审核记录。"],
  });

  tables.push({
    key: "groups",
    title: "分组",
    columns: [
      { header: "项目", width: 14 },
      { header: "阶段", width: 14 },
      { header: "组别", width: 8 },
      { header: "编号", width: 12 },
      { header: "名称", width: 30 },
    ],
    rows: snapshot.competitions.flatMap((competition) =>
      competition.groups.flatMap((group) => group.entries.map((entry) => [competition.name, group.stage, group.code, entry.code, entry.name])),
    ),
    empty: "没有已公开比赛的小组。",
    notes: [],
  });

  const fixtureRows: ReportCellValue[][] = [];
  for (const competition of snapshot.competitions) {
    if (competition.team) {
      for (const tie of competition.ties) {
        const winner = tie.winner ? sideLabel(tie.winner === "A" ? tie.sideA : tie.sideB) : "";
        fixtureRows.push([competition.name, tie.stage, tie.group ?? "", tie.round, tie.code, sideLabel(tie.sideA), sideLabel(tie.sideB), tie.rubbersWon, winner]);
      }
    }
  }
  for (const match of snapshot.matches) {
    if (match.rubber) continue; // 团体小场已并入上面的对抗
    fixtureRows.push([
      match.competitionName,
      match.stage,
      match.group ?? "",
      match.round ?? "",
      match.fixtureCode ?? match.code,
      sideCell(match.sideA),
      sideCell(match.sideB),
      match.gamesWon ?? "",
      winnerLabel(match),
    ]);
  }
  tables.push({
    key: "fixtures",
    title: "对阵",
    columns: [
      { header: "项目", width: 14 },
      { header: "阶段", width: 12 },
      { header: "组别", width: 8 },
      { header: "轮次", width: 14 },
      { header: "对阵编号", width: 14 },
      { header: "A 方", width: 30 },
      { header: "B 方", width: 30 },
      { header: official ? "局分/小场（已确认）" : "局分/小场", width: 12 },
      { header: "胜方", width: 24 },
    ],
    rows: fixtureRows,
    empty: "没有已公开的对阵。",
    notes: ["团体对抗的「小场」只统计已锁定的小场；待定签位写明来源（某组第几名、某场胜者/负者）。"],
  });

  tables.push({
    key: "schedule",
    title: "赛程",
    columns: [
      { header: "日期", width: 12 },
      { header: "时间", width: 8 },
      { header: "场地", width: 10 },
      { header: "比赛编号", width: 16 },
      { header: "项目", width: 14 },
      { header: "轮次/小场", width: 18 },
      { header: "A 方", width: 30 },
      { header: "B 方", width: 30 },
      { header: "时间性质", width: 10 },
    ],
    rows: snapshot.matches.map((match) => [
      match.date ?? "待定",
      match.time ?? "",
      match.court ?? "待定",
      match.code,
      match.competitionName,
      [match.group ? `${match.group} 组` : "", match.round ?? "", match.rubber ?? ""].filter(Boolean).join(" "),
      sideCell(match.sideA),
      sideCell(match.sideB),
      match.scheduledAt ? (match.estimated ? "预计" : "计划") : "待排期",
    ]),
    empty: "没有已公开的赛程。",
    notes: ["时间为赛事时区；「预计」表示接上一场之后推算，可能随现场进度变化。"],
  });

  tables.push({
    key: "results",
    title: "逐场成绩",
    columns: [
      { header: "比赛编号", width: 16 },
      { header: "项目", width: 14 },
      { header: "轮次/小场", width: 18 },
      { header: "A 方", width: 30 },
      { header: "B 方", width: 30 },
      { header: "逐局比分（A:B）", width: 22 },
      { header: "局数", width: 6 },
      { header: "结局", width: 14 },
      { header: "胜方", width: 24 },
      { header: "状态", width: 16 },
    ],
    rows: snapshot.matches.map((match) => [
      match.code,
      match.competitionName,
      [match.group ? `${match.group} 组` : "", match.round ?? "", match.rubber ?? ""].filter(Boolean).join(" "),
      sideCell(match.sideA),
      sideCell(match.sideB),
      match.scoreline,
      match.gamesWon ?? "",
      match.outcomeLabel ?? "",
      winnerLabel(match),
      match.confirmed || official || match.resultStage === "NOT_STARTED" ? match.statusLabel : `暂定 · ${match.statusLabel}`,
    ]),
    empty: "没有已公开的比赛。",
    notes: official ? ["未确认的比赛不列比分与胜方。"] : ["草稿中「暂定」比分尚未经裁判长复核锁定。"],
  });

  const rankingRows: ReportCellValue[][] = [];
  for (const competition of snapshot.competitions) {
    for (const ranking of competition.rankings) {
      for (const row of ranking.rows) {
        rankingRows.push([competition.name, `${ranking.group} 组名次`, row.position, row.code, row.name, RANKING_STATUS_TEXT[ranking.status], [row.detail, ranking.note].filter(Boolean).join("；")]);
      }
    }
    for (const placement of competition.placements) {
      rankingRows.push([competition.name, "最终名次", placement.place, placement.code, placement.name, placement.label, competition.placementsNote]);
    }
    if (!competition.rankings.length && !competition.placements.length && competition.placementsNote) {
      rankingRows.push([competition.name, "—", null, "", "", "", competition.placementsNote]);
    }
  }
  tables.push({
    key: "rankings",
    title: "名次",
    columns: [
      { header: "项目", width: 14 },
      { header: "类别", width: 12 },
      { header: "名次", width: 6 },
      { header: "编号", width: 12 },
      { header: "名称", width: 26 },
      { header: "说明", width: 22 },
      { header: "备注", width: 50 },
    ],
    rows: rankingRows,
    empty: "暂无名次。",
    notes: [
      `排名方案：${snapshot.rankingProfile.name} v${snapshot.rankingProfile.version}。${snapshot.rankingProfile.notice}`,
      "只列赛制真正决出的名次：未出线者不跨组排名，早轮淘汰者记并列名次。",
    ],
  });

  tables.push({
    key: "special",
    title: "特殊结果",
    columns: [
      { header: "比赛编号", width: 16 },
      { header: "说明", width: 90 },
    ],
    rows: snapshot.specialResults.map((item) => [item.matchCode, item.text]),
    empty: "没有弃权、退赛、取消资格或终止的比赛。",
    notes: ["只列结局与实际比分；伤病、纪律等内部原因不公开。"],
  });

  return tables;
}

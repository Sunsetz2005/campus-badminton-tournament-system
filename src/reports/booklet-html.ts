/**
 * A4 成绩册的 HTML 模板。纯函数，无 IO。
 *
 * 同一份模板既是浏览器里的「打印网页」，也是服务端生成 PDF 的唯一输入：
 * PDF 引擎只渲染这里拼出的内部 HTML，不访问任何 URL。表格内容全部来自 `buildReportTables`，
 * 与 Excel 工作簿逐字一致；模板只负责排版。
 *
 * 安全：所有来自数据库的文本都经过 `escapeHtml`；文档不含任何脚本，打印网页另以 CSP 禁止脚本与外部资源。
 * 版式：不使用学校印章、官方签字或「已批准」字样；草稿每页都有醒目水印。
 * 字体：只按名称引用系统已安装的中文字体（部署环境可安装 Noto Sans CJK 等开源字体），不随文件分发字体。
 */

import { dataRevision, type ReportSnapshot } from "@/reports/report-model";
import { buildReportTables, infoRows, MOCK_NOTICE, reportSubtitle, type ReportMeta, type ReportTable } from "@/reports/report-tables";

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FONT_STACK = `"Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif`;

export const BOOKLET_CSS = `
@page { size: A4 portrait; margin: 16mm 14mm 18mm; }
@page landscape { size: A4 landscape; margin: 14mm 14mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #0f172a; background: #fff; font-family: ${FONT_STACK}; font-size: 10pt; line-height: 1.5; }
.sheet { max-width: 190mm; margin: 0 auto; }
.watermark { position: fixed; inset: 0; display: grid; place-items: center; pointer-events: none; z-index: 0; }
.watermark span { color: rgba(185, 28, 28, .10); font-size: 96pt; font-weight: 900; letter-spacing: .2em; transform: rotate(-28deg); white-space: nowrap; }
.draft-banner { margin: 0 0 6mm; padding: 3mm 4mm; color: #7f1d1d; background: #fef2f2; border: 1.5pt solid #b91c1c; border-radius: 2mm; font-weight: 700; }
.cover { min-height: 250mm; display: flex; flex-direction: column; justify-content: center; gap: 6mm; break-after: page; position: relative; z-index: 1; }
.cover .band { height: 3mm; background: linear-gradient(90deg, #0b2a4a 0 40%, #0f766e 40% 80%, #b8860b 80%); border-radius: 1mm; }
.cover .kicker { margin: 0; color: #0f766e; font-size: 11pt; font-weight: 700; letter-spacing: .3em; }
.cover h1 { margin: 0; color: #0b2a4a; font-size: 28pt; line-height: 1.25; overflow-wrap: anywhere; }
.cover .subtitle { margin: 0; color: #334155; font-size: 14pt; }
.cover dl { display: grid; grid-template-columns: 34mm 1fr; gap: 2mm 4mm; margin: 6mm 0 0; font-size: 11pt; }
.cover dt { color: #475569; }
.cover dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.cover .edition { display: inline-block; padding: 1.5mm 4mm; border: 1.5pt solid currentColor; border-radius: 2mm; font-size: 14pt; font-weight: 800; }
.cover .edition.official { color: #0b2a4a; }
.cover .edition.draft { color: #b91c1c; }
.cover .notice { margin-top: 8mm; padding: 3mm 4mm; color: #7c2d12; background: #fff7ed; border: 1pt solid #fdba74; border-radius: 2mm; font-size: 9.5pt; }
section { position: relative; z-index: 1; margin: 0 0 8mm; }
section.break { break-before: page; }
section.landscape { page: landscape; }
h2 { margin: 0 0 3mm; padding-bottom: 1.5mm; color: #0b2a4a; border-bottom: 1.2pt solid #0f766e; font-size: 14pt; break-after: avoid; }
h3 { margin: 4mm 0 2mm; color: #0b2a4a; font-size: 11pt; break-after: avoid; }
p.meta { margin: 0 0 3mm; color: #475569; font-size: 8.5pt; }
table { width: 100%; border-collapse: collapse; table-layout: auto; font-size: 8.8pt; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { padding: 1.4mm 1.8mm; border: .5pt solid #cbd5e1; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: normal; }
th { color: #fff; background: #0b2a4a; font-weight: 700; }
tbody tr:nth-child(even) td { background: #f8fafc; }
td.num { text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.score { white-space: nowrap; font-variant-numeric: tabular-nums; }
td.code { white-space: nowrap; font-variant-numeric: tabular-nums; }
td.empty { color: #64748b; text-align: center; font-style: italic; }
ul.notes { margin: 2mm 0 0; padding-left: 5mm; color: #475569; font-size: 8.5pt; }
.kv { display: grid; grid-template-columns: 40mm 1fr; gap: 1.5mm 4mm; margin: 0; }
.kv dt { color: #475569; }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
ol.rules { margin: 0; padding-left: 5mm; }
@media screen {
  body { background: #e2e8f0; padding: 12mm 0; }
  .sheet { padding: 14mm; background: #fff; box-shadow: 0 2mm 8mm rgba(15, 23, 42, .15); }
  .screen-note { max-width: 190mm; margin: 0 auto 6mm; padding: 3mm 4mm; color: #0b3f7d; background: #eff6ff; border: 1pt solid #bfdbfe; border-radius: 2mm; font-size: 10pt; }
  .watermark { position: absolute; min-height: 100%; }
}
@media print { .screen-note { display: none; } .sheet { max-width: none; } }
`;

const NUMERIC_HEADERS = new Set(["名次", "局数", "时间", "日期", "场地", "局分/小场", "局分/小场（已确认）", "组别"]);
const SCORE_HEADERS = new Set(["逐局比分（A:B）"]);
const CODE_HEADERS = new Set(["比赛编号", "对阵编号", "编号", "结局"]);

function renderTable(table: ReportTable) {
  const head = table.columns.map((column) => `<th scope="col">${escapeHtml(column.header)}</th>`).join("");
  const body = table.rows.length
    ? table.rows
        .map(
          (row) =>
            `<tr>${table.columns
              .map((column, index) => {
                const cls = NUMERIC_HEADERS.has(column.header)
                  ? ' class="num"'
                  : SCORE_HEADERS.has(column.header)
                    ? ' class="score"'
                    : CODE_HEADERS.has(column.header)
                      ? ' class="code"'
                      : "";
                return `<td${cls}>${escapeHtml(row[index] ?? "")}</td>`;
              })
              .join("")}</tr>`,
        )
        .join("")
    : `<tr><td class="empty" colspan="${table.columns.length}">${escapeHtml(table.empty)}</td></tr>`;
  const notes = table.notes.length ? `<ul class="notes">${table.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : "";
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${notes}`;
}

export interface BookletOptions {
  /** 浏览器打印网页顶部的提示（PDF 中不出现）。 */
  screenNote?: string;
}

/** 生成完整的成绩册 HTML 文档。 */
export function renderBookletHtml(snapshot: ReportSnapshot, meta: ReportMeta, options: BookletOptions = {}) {
  const t = snapshot.tournament;
  const official = snapshot.edition === "OFFICIAL";
  const tables = buildReportTables(snapshot, meta);
  const byKey = new Map(tables.map((table) => [table.key, table]));
  const subtitle = reportSubtitle(snapshot, meta);
  const info = infoRows(snapshot, meta);
  const infoValue = (label: string) => info.find(([key]) => key === label)?.[1] ?? "";

  const cover = `
<div class="cover">
  <div class="band"></div>
  <p class="kicker">成 绩 册</p>
  <h1>${escapeHtml(t.name)}</h1>
  ${t.subtitle ? `<p class="subtitle">${escapeHtml(t.subtitle)}</p>` : ""}
  <div><span class="edition ${official ? "official" : "draft"}">${official ? "正式版" : "草稿 · 非正式成绩"}</span></div>
  <dl>
    <dt>主办</dt><dd>${escapeHtml(t.organizer ?? "—")}</dd>
    <dt>场馆</dt><dd>${escapeHtml(t.venue ?? "—")}</dd>
    <dt>比赛日期</dt><dd>${escapeHtml(t.dates ?? "待定")}</dd>
    <dt>文件版本</dt><dd>${escapeHtml(infoValue("文件版本"))}</dd>
    <dt>数据修订号</dt><dd>${escapeHtml(dataRevision(meta.snapshotHash))}</dd>
    <dt>取数时间</dt><dd>${escapeHtml(infoValue("取数时间"))}</dd>
    <dt>名次榜单版本</dt><dd>${escapeHtml(infoValue("名次榜单版本"))}</dd>
  </dl>
  <p class="notice">${escapeHtml(MOCK_NOTICE)} 本文件由系统依据数据快照自动生成，不含任何印章、签字或审批标记；成绩以赛事组织方正式公告为准。</p>
  <div class="band"></div>
</div>`;

  const rulesList = snapshot.rankingProfile.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("");
  const infoSection = `
<section>
  <h2>赛事信息与采用规程摘要</h2>
  <dl class="kv">${info.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
  <h3>名次规则：${escapeHtml(snapshot.rankingProfile.name)} v${snapshot.rankingProfile.version}${snapshot.rankingProfile.demo ? "（演示配置）" : ""}</h3>
  <ol class="rules">${rulesList}</ol>
  <p class="meta">${escapeHtml(snapshot.rankingProfile.notice)}</p>
  ${t.regulations ? `<h3>规程说明</h3><p class="pre">${escapeHtml(t.regulations)}</p>` : ""}
</section>`;

  const section = (key: ReportTable["key"], heading: string, extraClass = "") => {
    const table = byKey.get(key);
    if (!table) return "";
    return `<section class="break ${extraClass}"><h2>${escapeHtml(heading)}</h2><p class="meta">${escapeHtml(subtitle)}</p>${renderTable(table)}</section>`;
  };

  const body = [
    official ? "" : `<p class="draft-banner">草稿：含暂定比分与暂定名次，可能变化，不作为正式成绩使用。</p>`,
    infoSection,
    section("entries", "公开参赛名单"),
    section("groups", "分组"),
    section("fixtures", "对阵"),
    section("schedule", "赛程", "landscape"),
    section("results", "逐场结果", "landscape"),
    section("rankings", "名次"),
    section("special", "特殊结果说明"),
  ].join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${t.name} 成绩册（${official ? "正式版" : "草稿"}）`)}</title>
<style>${BOOKLET_CSS}</style>
</head>
<body>
${options.screenNote ? `<p class="screen-note">${escapeHtml(options.screenNote)}</p>` : ""}
${official ? "" : `<div class="watermark" aria-hidden="true"><span>草稿</span></div>`}
<main class="sheet">
${cover}
${body}
</main>
</body>
</html>`;
}

/** PDF 页脚：页码与版本信息（Chromium 页眉页脚模板，字号须显式指定）。 */
export function bookletFooterTemplate(snapshot: ReportSnapshot, meta: ReportMeta) {
  const edition = snapshot.edition === "OFFICIAL" ? "正式版" : "草稿";
  const version = meta.version ? `第 ${meta.version} 版` : "预览";
  const text = `${snapshot.tournament.name} · 成绩册 · ${edition} · ${version} · 数据修订 ${dataRevision(meta.snapshotHash)}`;
  return `<div style="width:100%;padding:0 14mm;font-family:${escapeHtml(FONT_STACK)};font-size:7.5pt;color:#475569;display:flex;justify-content:space-between;">
<span>${escapeHtml(text)}</span><span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</span></div>`;
}

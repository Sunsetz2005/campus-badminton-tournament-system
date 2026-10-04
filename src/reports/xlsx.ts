/**
 * 最小 .xlsx（Office Open XML 电子表格）写出器。纯函数，只依赖 Node 自带的 zlib。
 *
 * 为什么自己写：导出只需要「文本/数字单元格 + 表头样式 + 冻结首行 + 列宽」，
 * 引入完整的电子表格库会带来大量传递依赖和许可核对，而这里的格式是公开标准（ECMA-376）。
 *
 * 公式注入防护（CSV/Excel injection）：
 * - 所有文本一律写成内联字符串单元格（`t="inlineStr"`），本写出器根本不生成 `<f>` 公式元素，
 *   表格软件打开时不会把 `=HYPERLINK(...)`、`+1`、`@SUM(...)` 当公式执行；
 * - 以 `=`、`+`、`-`、`@`、制表符、回车开头的文本再加 `quotePrefix` 样式，
 *   用户在表格软件里编辑该单元格后也仍按文本保存，不会被「重新识别」为公式。
 * XML 不允许的控制字符在写出前删除，避免生成打不开的文件。
 */

import { crc32, deflateRawSync } from "node:zlib";

export type XlsxCell = string | number | null | undefined;

export interface XlsxColumn {
  header: string;
  /** 列宽（字符数，按中文约 2 个字符宽估算）。 */
  width?: number;
}

export interface XlsxSheet {
  name: string;
  /** 表头上方的标题行与说明行（可选）。 */
  title?: string;
  subtitle?: string;
  columns: XlsxColumn[];
  rows: XlsxCell[][];
  /** 表格下方的说明（每项一行）。 */
  notes?: string[];
}

export interface XlsxWorkbook {
  title: string;
  /** 生成时间：写进文档属性。由调用方传入，保证同一份快照生成的文件可复现。 */
  createdAt: Date;
  sheets: XlsxSheet[];
}

/** 单个工作表的行数上限（远低于 Excel 的 1,048,576 行，防止误导出超大报告）。 */
export const XLSX_MAX_ROWS = 20_000;

const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;
// XML 1.0 允许 #x9 #xA #xD 与 #x20 以上字符；其余控制字符删除。孤立代理项同样删除。
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeXmlText(value: string) {
  return value.replace(XML_INVALID, "");
}

export function escapeXml(value: string) {
  return sanitizeXmlText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 工作表名：最长 31 字符，不得含 `[]:*?/\`，不得以撇号开头或结尾，且同一工作簿内不重名。 */
export function safeSheetName(name: string, taken: Set<string>) {
  let base = sanitizeXmlText(name).replace(/[[\]:*?/\\]/g, "·").replace(/^'+|'+$/g, "").trim() || "Sheet";
  base = [...base].slice(0, 31).join("");
  let candidate = base;
  for (let index = 2; taken.has(candidate.toLowerCase()); index += 1) {
    const suffix = `(${index})`;
    candidate = [...base].slice(0, 31 - suffix.length).join("") + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

export function columnLetter(index: number) {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// 样式索引，对应 stylesXml() 中 cellXfs 的顺序。
const STYLE = { body: 0, header: 1, title: 2, subtitle: 3, bodyQuoted: 4, note: 5 } as const;

function cellXml(ref: string, value: XlsxCell, style: number) {
  if (value === null || value === undefined || value === "") return style === STYLE.body ? "" : `<c r="${ref}" s="${style}"/>`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`;
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  const text = sanitizeXmlText(value);
  const quoted = style === STYLE.body && FORMULA_TRIGGERS.test(text) ? STYLE.bodyQuoted : style;
  return `<c r="${ref}" s="${quoted}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function rowXml(rowNumber: number, cells: XlsxCell[], style: number, height?: number) {
  const body = cells.map((value, index) => cellXml(`${columnLetter(index)}${rowNumber}`, value, style)).join("");
  const ht = height ? ` ht="${height}" customHeight="1"` : "";
  return `<row r="${rowNumber}"${ht}>${body}</row>`;
}

function sheetXml(sheet: XlsxSheet) {
  if (sheet.rows.length > XLSX_MAX_ROWS) {
    throw new RangeError(`工作表「${sheet.name}」有 ${sheet.rows.length} 行，超过单表 ${XLSX_MAX_ROWS} 行的导出上限。`);
  }
  const width = Math.max(1, sheet.columns.length);
  const rows: string[] = [];
  let rowNumber = 1;
  if (sheet.title) rows.push(rowXml(rowNumber++, [sheet.title], STYLE.title, 24));
  if (sheet.subtitle) rows.push(rowXml(rowNumber++, [sheet.subtitle], STYLE.subtitle));
  if (sheet.title || sheet.subtitle) rowNumber += 1; // 空一行再写表头
  const headerRow = rowNumber;
  rows.push(rowXml(rowNumber++, sheet.columns.map((column) => column.header), STYLE.header, 20));
  for (const cells of sheet.rows) rows.push(rowXml(rowNumber++, cells.slice(0, width), STYLE.body));
  const lastDataRow = rowNumber - 1;
  if (sheet.notes?.length) {
    rowNumber += 1;
    for (const note of sheet.notes) rows.push(rowXml(rowNumber++, [note], STYLE.note));
  }

  const cols = sheet.columns
    .map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.min(Math.max(column.width ?? 14, 4), 80)}" customWidth="1"/>`)
    .join("");
  const lastColumn = columnLetter(width - 1);
  // 冻结到表头下一行；有数据时给表头加筛选。
  const pane = `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/>`;
  const filter = lastDataRow > headerRow ? `<autoFilter ref="A${headerRow}:${lastColumn}${lastDataRow}"/>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="16"/>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${rows.join("")}</sheetData>` +
    filter +
    `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
    `<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>` +
    `</worksheet>`
  );
}

function stylesXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="5">` +
    `<font><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="等线"/><family val="2"/><charset val="134"/></font>` +
    `<font><b/><sz val="15"/><color rgb="FF0B2A4A"/><name val="等线"/><family val="2"/><charset val="134"/></font>` +
    `<font><sz val="10"/><color rgb="FF475569"/><name val="等线"/><family val="2"/><charset val="134"/></font>` +
    `<font><i/><sz val="10"/><color rgb="FF475569"/><name val="等线"/><family val="2"/><charset val="134"/></font>` +
    `</fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF0B2A4A"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" quotePrefix="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`
  );
}

function isoSeconds(date: Date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** 按工作簿描述生成 .xlsx 文件字节。相同输入（含 createdAt）得到逐字节相同的输出。 */
export function buildXlsx(workbook: XlsxWorkbook): Buffer {
  if (!workbook.sheets.length) throw new RangeError("工作簿至少需要一个工作表。");
  const taken = new Set<string>();
  const names = workbook.sheets.map((sheet) => safeSheetName(sheet.name, taken));
  const files: [string, string][] = [];

  files.push([
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      names.map((_name, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
      `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
      `</Types>`,
  ]);
  files.push([
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>` +
      `</Relationships>`,
  ]);
  files.push([
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${escapeXml(workbook.title)}</dc:title>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${isoSeconds(workbook.createdAt)}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${isoSeconds(workbook.createdAt)}</dcterms:modified>` +
      `</cp:coreProperties>`,
  ]);
  files.push([
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>赛事台</Application></Properties>`,
  ]);
  files.push([
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<bookViews><workbookView/></bookViews><sheets>` +
      names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("") +
      `</sheets>` +
      // 筛选范围按 Excel 约定登记为隐藏的内置名称。
      workbook.sheets
        .map((sheet, index) => ({ sheet, index }))
        .filter(({ sheet }) => sheet.rows.length > 0)
        .map(({ sheet, index }) => {
          const headerRow = sheet.title || sheet.subtitle ? (sheet.title ? 1 : 0) + (sheet.subtitle ? 1 : 0) + 2 : 1;
          const last = headerRow + sheet.rows.length;
          const quoted = `'${names[index].replace(/'/g, "''")}'`;
          return `<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">${escapeXml(`${quoted}!$A$${headerRow}:$${columnLetter(Math.max(1, sheet.columns.length) - 1)}$${last}`)}</definedName>`;
        })
        .join("")
        .replace(/^(.+)$/, "<definedNames>$1</definedNames>") +
      `</workbook>`,
  ]);
  files.push([
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      names.map((_name, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  ]);
  files.push(["xl/styles.xml", stylesXml()]);
  workbook.sheets.forEach((sheet, index) => files.push([`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)]));

  return zip(files.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })), workbook.createdAt);
}

// ---------------------------------------------------------------------------
// ZIP 容器（PKWARE APPNOTE）：本地文件头 + deflate 数据 + 中央目录。不含 ZIP64，单文件远小于 4 GiB。
// ---------------------------------------------------------------------------

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

export function zip(entries: { name: string; data: Buffer }[], modified: Date): Buffer {
  const { time, day } = dosDateTime(modified);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

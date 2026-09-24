/**
 * 最小 RFC 4180 CSV 解析器，只把单元格当作文本，从不求值。
 *
 * 为了让「第 N 行」与表格软件里看到的行号一致，单元格内换行直接判为错误，
 * 因此一条记录恰好对应文件中的一行。
 */

export interface CsvLimits {
  maxRecords: number;
  maxColumns: number;
}

export type CsvParseResult =
  | { ok: true; records: string[][] }
  | { ok: false; line: number; message: string };

export function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCsv(input: string, limits: CsvLimits): CsvParseResult {
  const text = stripBom(input);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let afterClosingQuote = false;
  let nonEmptyRecords = 0;
  let line = 1;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
    afterClosingQuote = false;
  };
  const endRecord = (): CsvParseResult | null => {
    endField();
    // 完全空白的行（包括只有逗号的行）记为空数组占位，保证 records[i] 对应第 i+1 行。
    if (record.some((cell) => cell.trim() !== "")) {
      if (record.length > limits.maxColumns) {
        return { ok: false, line, message: `第 ${line} 行超过 ${limits.maxColumns} 列` };
      }
      records.push(record);
      nonEmptyRecords += 1;
      if (nonEmptyRecords > limits.maxRecords) {
        return { ok: false, line, message: `文件超过 ${limits.maxRecords} 行上限` };
      }
    } else {
      records.push([]);
    }
    record = [];
    return null;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else if (character === "\n" || character === "\r") {
        return { ok: false, line, message: `第 ${line} 行的单元格内含换行，请改为单行文本` };
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (fieldStarted || field !== "") {
        return { ok: false, line, message: `第 ${line} 行存在未正确转义的引号` };
      }
      inQuotes = true;
      fieldStarted = true;
    } else if (character === ",") {
      endField();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      const failure = endRecord();
      if (failure) return failure;
      line += 1;
    } else {
      if (afterClosingQuote) {
        return { ok: false, line, message: `第 ${line} 行的引号后面还有多余字符` };
      }
      field += character;
    }
  }

  if (inQuotes) return { ok: false, line, message: `第 ${line} 行的引号没有闭合` };
  if (field !== "" || fieldStarted || record.length > 0) {
    const failure = endRecord();
    if (failure) return failure;
  }

  // 去掉文件末尾的空行，行号不受影响。
  while (records.length && records[records.length - 1].length === 0) records.pop();
  return { ok: true, records };
}

/** 生成可被 Excel 正确识别为 UTF-8 的 CSV（带 BOM、CRLF 换行）。 */
export function toCsv(rows: readonly (readonly string[])[]) {
  const escape = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return `﻿${rows.map((row) => row.map(escape).join(",")).join("\r\n")}\r\n`;
}

import { describe, expect, it } from "vitest";

import { buildXlsx, columnLetter, safeSheetName, XLSX_MAX_ROWS } from "@/reports/xlsx";
import { readXlsx, readZip } from "../support/xlsx-reader";

const AT = new Date("2026-09-28T08:00:00Z");

describe("xlsx 写出器", () => {
  it("生成可解压、CRC 正确的标准包结构；同一输入逐字节可复现", () => {
    const workbook = { title: "测试", createdAt: AT, sheets: [{ name: "成绩", columns: [{ header: "编号" }], rows: [["A"]] }] };
    const bytes = buildXlsx(workbook);
    const files = readZip(bytes);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "docProps/core.xml"]),
    );
    expect(buildXlsx(workbook).equals(bytes)).toBe(true);
  });

  it("公式样式文本写成内联字符串并加 quotePrefix；全文件不含任何公式元素", () => {
    const risky = ['=HYPERLINK("http://evil","点我")', "+86 138 0000 0000", "-2+3", "@SUM(A1:A2)", "\t=1+1", "普通文本"];
    const bytes = buildXlsx({ title: "注入", createdAt: AT, sheets: [{ name: "a", columns: [{ header: "值" }], rows: risky.map((value) => [value]) }] });
    const [sheet] = readXlsx(bytes);
    expect(sheet.xml).not.toMatch(/<f[ >]/);
    const cells = [...sheet.xml.matchAll(/<c r="A(\d+)" s="(\d+)" t="inlineStr">/g)].map((match) => ({ row: Number(match[1]), style: match[2] }));
    // 第 1 行是表头（样式 1），其后 5 个危险值是样式 4（quotePrefix），最后的普通文本是样式 0。
    expect(cells.map((cell) => cell.style)).toEqual(["1", "4", "4", "4", "4", "4", "0"]);
    expect(sheet.rows.slice(1).map((row) => row[0])).toEqual(risky);
    const styles = readZip(bytes).get("xl/styles.xml")?.toString("utf8") ?? "";
    expect(styles).toMatch(/quotePrefix="1"/);
  });

  it("转义 XML 特殊字符、删除非法控制字符，中文长姓名与数字原样保留", () => {
    const name = "欧阳娜娜·阿卜杜热合曼·买买提提江·<script>&\"";
    const bytes = buildXlsx({ title: "x", createdAt: AT, sheets: [{ name: "a", columns: [{ header: "名" }, { header: "分" }], rows: [[`${name}\u0001\u0008`, 21], [null, 0]] }] });
    const [sheet] = readXlsx(bytes);
    expect(sheet.rows[1]).toEqual([name, "21"]);
    expect(sheet.xml).toContain("&lt;script&gt;&amp;&quot;");
    expect(sheet.xml).toContain("<v>21</v>");
    expect(sheet.rows[2]).toEqual(["", "0"]);
  });

  it("工作表名去掉非法字符、截到 31 字并去重；列号换算正确", () => {
    const taken = new Set<string>();
    expect(safeSheetName("a/b:c*d?[e]", taken)).toBe("a·b·c·d··e·");
    expect([...safeSheetName("一".repeat(40), taken)]).toHaveLength(31);
    expect(safeSheetName("一".repeat(40), taken)).toBe(`${"一".repeat(28)}(2)`);
    expect([columnLetter(0), columnLetter(25), columnLetter(26), columnLetter(701), columnLetter(702)]).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
  });

  it("超过单表行数上限时拒绝生成，并给出可理解的中文原因", () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS + 1 }, (_value, index) => [index]);
    expect(() => buildXlsx({ title: "大", createdAt: AT, sheets: [{ name: "大表", columns: [{ header: "n" }], rows }] })).toThrow(/超过单表 20000 行/);
  });
});

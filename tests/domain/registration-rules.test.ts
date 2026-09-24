import { describe, expect, it } from "vitest";

import { parseCsv, toCsv } from "@/domain/registration/csv";
import { IMPORT_HEADERS, planImport, type ImportContext } from "@/domain/registration/import-plan";
import {
  formatReferenceCode,
  looksLikeFormula,
  nameSetKey,
  normalizeStudentId,
  registrationDedupeKey,
  validateNote,
  validateRegistrationMembers,
} from "@/domain/registration/registration-rules";
import { utcToZonedLocal, zonedLocalToUtc } from "@/domain/time/zoned-time";

const LIMITS = { maxRecords: 100, maxColumns: 12 };

describe("报名成员校验", () => {
  it("单打恰好 1 人，双打恰好 2 人", () => {
    expect(validateRegistrationMembers("SINGLES", [{ displayName: "张三" }]).members).toHaveLength(1);
    expect(validateRegistrationMembers("SINGLES", [{ displayName: "张三" }, { displayName: "李四" }]).errors).toContain(
      "单打项目只能填写 1 名选手",
    );
    expect(validateRegistrationMembers("DOUBLES", [{ displayName: "张三" }]).errors).toContain("选手 2 的姓名不能为空");
    expect(validateRegistrationMembers("DOUBLES", [{ displayName: "张三" }, { displayName: "李四" }]).members).toHaveLength(2);
  });

  it("双打两名成员学号相同即拒绝（同一人不能与自己组队）", () => {
    const result = validateRegistrationMembers("DOUBLES", [
      { displayName: "张三", studentId: "2026001" },
      { displayName: "张 三", studentId: " 2026001 " },
    ]);
    expect(result.members).toBeNull();
    expect(result.errors).toContain("双打两名选手的学号相同，同一人不能与自己组队");
  });

  it("规范化全角、空白与学号大小写", () => {
    const result = validateRegistrationMembers("SINGLES", [{ displayName: "  张　三 ", studentId: "ｓ２０２６ 001" }]);
    expect(result.members?.[0]).toMatchObject({ displayName: "张 三", studentId: "S2026001" });
    expect(normalizeStudentId("ab-12")).toBe("AB-12");
  });

  it("拒绝疑似表格公式、控制字符和超长字段", () => {
    expect(validateRegistrationMembers("SINGLES", [{ displayName: "=HYPERLINK(\"x\")" }]).errors[0]).toContain("疑似表格公式");
    expect(validateRegistrationMembers("SINGLES", [{ displayName: "@SUM(A1)" }]).members).toBeNull();
    expect(validateRegistrationMembers("SINGLES", [{ displayName: "张三\n李四" }]).errors[0]).toContain("控制字符");
    expect(validateRegistrationMembers("SINGLES", [{ displayName: "长".repeat(41) }]).errors[0]).toContain("超过 40");
    expect(validateRegistrationMembers("SINGLES", [{ displayName: "张三", studentId: "20 26/01" }]).errors[0]).toContain("学号只能");
    // 国际电话号码是合法联系方式，不是公式。
    expect(looksLikeFormula("+86 138-0000-0000", true)).toBe(false);
    expect(looksLikeFormula("+cmd|calc", true)).toBe(true);
    expect(validateNote("-1+1").error).toContain("公式");
  });

  it("去重键与成员顺序无关，任一成员缺学号时不生成硬键", () => {
    const a = { displayName: "张三", studentId: "S1", teamName: null, contact: null };
    const b = { displayName: "李四", studentId: "S2", teamName: null, contact: null };
    expect(registrationDedupeKey([a, b])).toBe(registrationDedupeKey([b, a]));
    expect(registrationDedupeKey([a, { ...b, studentId: null }])).toBeNull();
    expect(nameSetKey([a, b])).toBe(nameSetKey([b, a]));
  });

  it("回执编号不含易混字符", () => {
    const code = formatReferenceCode(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 30, 31]));
    expect(code).toMatch(/^R-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  });
});

describe("CSV 解析", () => {
  it("支持 BOM、引号转义、CRLF，并保持行号与文件行一致", () => {
    const result = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\nlast,1\r\n', LIMITS);
    expect(result).toEqual({ ok: true, records: [["a", "b"], ["x, y", 'say "hi"'], [], ["last", "1"]] });
  });

  it("单元格内换行、未闭合引号和引号后多余字符都给出行号", () => {
    expect(parseCsv('a\n"x\ny"', LIMITS)).toMatchObject({ ok: false, line: 2 });
    expect(parseCsv('a\nb\n"open', LIMITS)).toMatchObject({ ok: false, line: 3, message: expect.stringContaining("没有闭合") });
    expect(parseCsv('"a"b,c', LIMITS)).toMatchObject({ ok: false, line: 1, message: expect.stringContaining("多余字符") });
  });

  it("超过行数或列数上限即停止", () => {
    const rows = Array.from({ length: 5 }, (_, index) => `r${index}`).join("\n");
    expect(parseCsv(rows, { maxRecords: 3, maxColumns: 5 })).toMatchObject({ ok: false, line: 4 });
    expect(parseCsv("a,b,c", { maxRecords: 3, maxColumns: 2 })).toMatchObject({ ok: false, line: 1 });
  });

  it("导出时转义逗号与引号并带 BOM", () => {
    expect(toCsv([["a,b", 'c"d']])).toBe('﻿"a,b","c""d"\r\n');
  });
});

describe("导入计划", () => {
  const competitions = new Map([
    ["MS", { id: "ms", code: "MS", name: "男子单打", entryType: "SINGLES" as const }],
    ["MD", { id: "md", code: "MD", name: "男子双打", entryType: "DOUBLES" as const }],
  ]);
  const baseContext: ImportContext = {
    competitions,
    activeDedupeKeys: new Map([["md|S10|S11", "R-EXST-0001"]]),
    activeStudentIds: new Map([
      ["md|S10", "R-EXST-0001"],
      ["md|S11", "R-EXST-0001"],
      ["ms|S20", "R-EXST-0002"],
    ]),
    activeNameSets: new Map([["ms|王五", "R-EXST-0003"]]),
  };
  const header = [...IMPORT_HEADERS];
  const row = (...cells: string[]) => [...cells, ...Array(10 - cells.length).fill("")];

  it("逐行给出新增、重复和错误，行号与表格一致", () => {
    const records = [
      header,
      row("MS", "张三", "S1"),
      [],
      row("MD", "赵六", "S11", "", "", "钱七", "S10"),
      row("XX", "无效"),
      row("MS", "李四", "S20"),
      row("MS", "王五"),
    ];
    const plan = planImport(records, baseContext);
    expect(plan.headerError).toBeNull();
    expect(plan.rows.map((item) => [item.line, item.status])).toEqual([
      [2, "NEW"],
      [4, "DUPLICATE"],
      [5, "ERROR"],
      [6, "ERROR"],
      [7, "NEW"],
    ]);
    expect(plan.rows[2].messages[0]).toContain("XX 不属于本赛事");
    expect(plan.rows[3].messages[0]).toContain("R-EXST-0002");
    expect(plan.rows[4].warnings.join()).toContain("同名");
    expect(plan.counts).toEqual({ total: 5, new: 2, duplicate: 1, error: 2 });
    expect(plan.canCommit).toBe(false);
  });

  it("文件内 A+B 与 B+A 视为同一报名；同一学号在同一项目重复出现判错", () => {
    const plan = planImport(
      [
        header,
        row("MD", "甲", "S1", "", "", "乙", "S2"),
        row("MD", "乙", "S2", "", "", "甲", "S1"),
        row("MD", "甲", "S1", "", "", "丙", "S3"),
      ],
      { ...baseContext, activeDedupeKeys: new Map(), activeStudentIds: new Map() },
    );
    expect(plan.rows[1].messages[0]).toContain("与第 2 行是同一报名");
    expect(plan.rows[2].messages[0]).toContain("学号 S1 在第 2 行已报名同一项目");
  });

  it("单打行填写了选手2、表头不符、公式单元格都判错", () => {
    expect(planImport([header, row("MS", "张三", "", "", "", "李四")], baseContext).rows[0].messages.join()).toContain("选手2各列必须留空");
    expect(planImport([["项目", "姓名"]], baseContext).headerError).toContain("表头与模板不一致");
    expect(planImport([header], baseContext).headerError).toContain("没有任何数据行");
    const formula = planImport([header, row("MS", "=1+1")], baseContext);
    expect(formula.rows[0].status).toBe("ERROR");
    expect(formula.rows[0].messages[0]).toContain("疑似表格公式");
  });

  it("全部为新增或重复时才允许提交", () => {
    const plan = planImport([header, row("MS", "张三", "S1"), row("MS", "李四")], baseContext);
    expect(plan.canCommit).toBe(true);
    expect(plan.rows[1].warnings.join()).toContain("缺少学号");
  });
});

describe("赛事时区换算", () => {
  it("按赛事时区而不是服务器时区解释墙上时间", () => {
    expect(zonedLocalToUtc("2026-10-01T09:00", "Asia/Shanghai")?.toISOString()).toBe("2026-10-01T01:00:00.000Z");
    expect(zonedLocalToUtc("2026-10-01T09:00", "UTC")?.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(utcToZonedLocal(new Date("2026-10-01T01:00:00.000Z"), "Asia/Shanghai")).toBe("2026-10-01T09:00");
  });

  it("不存在的日期、时刻或夏令时跳过的时段返回 null", () => {
    expect(zonedLocalToUtc("2026-02-30T09:00", "Asia/Shanghai")).toBeNull();
    expect(zonedLocalToUtc("2026-10-01T25:00", "Asia/Shanghai")).toBeNull();
    expect(zonedLocalToUtc("2026-03-08T02:30", "America/New_York")).toBeNull();
    expect(zonedLocalToUtc("2026-10-01T09:00", "Mars/Olympus")).toBeNull();
  });
});

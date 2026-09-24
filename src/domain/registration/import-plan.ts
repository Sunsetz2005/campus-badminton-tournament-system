import {
  nameSetKey,
  registrationDedupeKey,
  validateNote,
  validateRegistrationMembers,
  type MemberInput,
  type NormalizedMember,
  type RegistrationEntryType,
} from "@/domain/registration/registration-rules";

/**
 * 批量导入的纯计划：给定解析好的表格和当前报名状况，逐行给出「新增 / 重复 / 错误」。
 * 服务端在预览和确认提交时各算一次；两次结果不一致就拒绝提交，避免按过期预览写库。
 */

export const IMPORT_HEADERS = [
  "项目代码",
  "选手1姓名",
  "选手1学号",
  "选手1代表队",
  "选手1联系方式",
  "选手2姓名",
  "选手2学号",
  "选手2代表队",
  "选手2联系方式",
  "备注",
] as const;

export const IMPORT_LIMITS = {
  maxBytes: 256 * 1024,
  maxDataRows: 500,
  maxColumns: IMPORT_HEADERS.length + 2,
} as const;

export interface ImportCompetition {
  id: string;
  code: string;
  name: string;
  entryType: RegistrationEntryType;
}

export interface ImportContext {
  competitions: ReadonlyMap<string, ImportCompetition>;
  /** `${competitionId}|${dedupeKey}` → 已存在的进行中/已通过报名回执号 */
  activeDedupeKeys: ReadonlyMap<string, string>;
  /** `${competitionId}|${studentId}` → 该学号所在的进行中/已通过报名回执号 */
  activeStudentIds: ReadonlyMap<string, string>;
  /** `${competitionId}|${nameSetKey}` → 同名报名回执号（只做提示） */
  activeNameSets: ReadonlyMap<string, string>;
}

export type ImportRowStatus = "NEW" | "DUPLICATE" | "ERROR";

export interface ImportRow {
  line: number;
  status: ImportRowStatus;
  competitionCode: string;
  competitionId: string | null;
  members: NormalizedMember[];
  note: string | null;
  dedupeKey: string | null;
  messages: string[];
  warnings: string[];
}

export interface ImportPlan {
  headerError: string | null;
  rows: ImportRow[];
  counts: { total: number; new: number; duplicate: number; error: number };
  canCommit: boolean;
}

function cell(record: readonly string[], index: number) {
  return record[index] ?? "";
}

function memberInput(record: readonly string[], offset: number): MemberInput {
  return {
    displayName: cell(record, offset),
    studentId: cell(record, offset + 1),
    teamName: cell(record, offset + 2),
    contact: cell(record, offset + 3),
  };
}

function headerMatches(record: readonly string[]) {
  return IMPORT_HEADERS.every((header, index) => (record[index] ?? "").trim() === header);
}

export function planImport(records: readonly (readonly string[])[], context: ImportContext): ImportPlan {
  const empty = { headerError: null, rows: [], counts: { total: 0, new: 0, duplicate: 0, error: 0 }, canCommit: false };
  if (!records.length || !records[0].length) {
    return { ...empty, headerError: "第 1 行必须是模板表头" };
  }
  if (!headerMatches(records[0])) {
    return { ...empty, headerError: `第 1 行表头与模板不一致，应为：${IMPORT_HEADERS.join("，")}` };
  }

  const rows: ImportRow[] = [];
  const seenInFile = new Map<string, number>();
  const studentIdsInFile = new Map<string, number>();

  records.forEach((record, index) => {
    if (index === 0 || record.length === 0) return;
    const line = index + 1;
    const messages: string[] = [];
    const warnings: string[] = [];
    const competitionCode = cell(record, 0).trim().toUpperCase();
    const competition = context.competitions.get(competitionCode) ?? null;
    if (!competitionCode) messages.push("项目代码不能为空");
    else if (!competition) messages.push(`项目代码 ${competitionCode} 不属于本赛事`);

    const extraCells = record.slice(IMPORT_HEADERS.length).filter((value) => value.trim() !== "");
    if (extraCells.length) messages.push("模板列之外还有内容，请删除多余列");

    const { note, error: noteError } = validateNote(cell(record, 9));
    if (noteError) messages.push(noteError);

    let members: NormalizedMember[] = [];
    let dedupeKey: string | null = null;
    if (competition) {
      const inputs = [memberInput(record, 1), memberInput(record, 5)];
      const secondHasContent = [5, 6, 7, 8].some((column) => cell(record, column).trim() !== "");
      if (competition.entryType === "SINGLES" && secondHasContent) {
        messages.push(`${competition.code} 是单打项目，选手2各列必须留空`);
      }
      const result = validateRegistrationMembers(competition.entryType, competition.entryType === "SINGLES" ? [inputs[0]] : inputs);
      messages.push(...result.errors);
      if (result.members) {
        members = result.members;
        dedupeKey = registrationDedupeKey(members);
      }
    }

    if (!messages.length && competition) {
      const fileKey = dedupeKey ? `${competition.id}|${dedupeKey}` : null;
      const earlierSame = fileKey ? seenInFile.get(fileKey) : undefined;
      if (earlierSame) {
        messages.push(`与第 ${earlierSame} 行是同一报名（成员顺序不影响判定）`);
      } else {
        for (const member of members) {
          if (!member.studentId) continue;
          const earlier = studentIdsInFile.get(`${competition.id}|${member.studentId}`);
          if (earlier) messages.push(`学号 ${member.studentId} 在第 ${earlier} 行已报名同一项目，同一人不能在同一项目报两次`);
        }
        if (!messages.length) {
          if (fileKey) seenInFile.set(fileKey, line);
          for (const member of members) {
            if (member.studentId) studentIdsInFile.set(`${competition.id}|${member.studentId}`, line);
          }
        }
      }
    }

    let status: ImportRowStatus = messages.length ? "ERROR" : "NEW";
    if (status === "NEW" && competition) {
      const existing = dedupeKey ? context.activeDedupeKeys.get(`${competition.id}|${dedupeKey}`) : undefined;
      if (existing) {
        status = "DUPLICATE";
        warnings.push(`已存在相同报名 ${existing}，确认导入时将跳过本行`);
      } else {
        for (const member of members) {
          if (!member.studentId) continue;
          const holder = context.activeStudentIds.get(`${competition.id}|${member.studentId}`);
          if (holder) messages.push(`学号 ${member.studentId} 已在报名 ${holder} 中报了同一项目`);
        }
        if (messages.length) status = "ERROR";
      }
      if (status === "NEW") {
        const sameNames = context.activeNameSets.get(`${competition.id}|${nameSetKey(members)}`);
        if (sameNames) warnings.push(`与报名 ${sameNames} 同名，可能是同一人也可能是同名不同人，请在审核时确认`);
        if (members.some((member) => !member.studentId)) warnings.push("缺少学号，审核时需人工确认身份");
      }
    }

    rows.push({
      line,
      status,
      competitionCode,
      competitionId: competition?.id ?? null,
      members,
      note,
      dedupeKey,
      messages,
      warnings,
    });
  });

  const counts = {
    total: rows.length,
    new: rows.filter((row) => row.status === "NEW").length,
    duplicate: rows.filter((row) => row.status === "DUPLICATE").length,
    error: rows.filter((row) => row.status === "ERROR").length,
  };
  if (!rows.length) return { ...empty, headerError: "表头之后没有任何数据行" };
  return { headerError: null, rows, counts, canCommit: counts.error === 0 && counts.new > 0 };
}

/**
 * 团体赛（学院对抗）名单的纯规则。无 IO、无框架。
 *
 * - 一支队伍 = 一个代表队（学院）在一个团体项目里的报名单位，对抗由若干「小场」组成（默认男单、女单、男双、女双、混双）。
 * - 队员必须填写学号与性别：学号是赛事内唯一可自动判定同一人的依据；
 *   性别只用于核对名单是否够出男/女/混合小场，由负责人明确填写，不从姓名、照片或证件推断。
 * - 报名时负责人为每名队员勾选报项（可参加的小场类型）；每场对抗的出场名单只能从报了该项的队员里选
 *   （出场名单规则见 `src/domain/team/lineup.ts`）。同一队员在一场对抗里可以上几个小场不设上限。
 */

import {
  looksLikeFormula,
  memberCountFor,
  nameKey,
  normalizeText,
  validateMember,
  type MemberInput,
  type NormalizedMember,
  type RegistrationCompetitionKind,
} from "./registration-rules";

export type Gender = "MALE" | "FEMALE";
export type RubberKind = RegistrationCompetitionKind;

export const GENDER_LABEL: Record<Gender, string> = { MALE: "男", FEMALE: "女" };

export const RUBBER_KINDS: readonly RubberKind[] = ["MS", "WS", "MD", "WD", "XD"];

/** 一个小场每一侧的上场人数：单打 1 人，双打 2 人。 */
export function rubberSize(kind: RubberKind): 1 | 2 {
  return kind === "MS" || kind === "WS" ? 1 : 2;
}

/** 小场对性别的要求：男单/男双只能男队员，女单/女双只能女队员，混双一男一女。 */
export function rubberGender(kind: RubberKind): Gender | "MIXED" {
  if (kind === "MS" || kind === "MD") return "MALE";
  if (kind === "WS" || kind === "WD") return "FEMALE";
  return "MIXED";
}

/** 某性别的队员在本项目可以报哪些小场（按项目小场的规范顺序去重）。 */
export function eligibleRubberKinds(gender: Gender, rubbers: readonly RubberKind[]): RubberKind[] {
  return RUBBER_KINDS.filter((kind) => rubbers.includes(kind) && (rubberGender(kind) === "MIXED" || rubberGender(kind) === gender));
}

export interface TeamFormat {
  /** 每场对抗的小场顺序，可重复（如三单两双）。 */
  rubbers: RubberKind[];
  rosterMin: number;
  rosterMax: number;
  minMale: number;
  minFemale: number;
  /** 同一队员在一场对抗里最多上几个小场（按性别）；null 表示不设上限。 */
  maxRubbersMale?: number | null;
  maxRubbersFemale?: number | null;
}

export const TEAM_ROSTER_HARD_MAX = 30;
export const TEAM_RUBBERS_MAX = 9;

/** 项目默认：五个小场各一场；名单 4—12 人，至少 2 男 2 女。须由组织者按规程确认。 */
export const DEFAULT_TEAM_FORMAT: TeamFormat = {
  rubbers: ["MS", "WS", "MD", "WD", "XD"],
  rosterMin: 4,
  rosterMax: 12,
  minMale: 2,
  minFemale: 2,
};

/** 一场对抗里各性别至少要出场的「人次」（不同小场可由同一人兼项，所以只作参考）。 */
export function genderSlotsPerTie(rubbers: readonly RubberKind[]) {
  let male = 0;
  let female = 0;
  for (const kind of rubbers) {
    const count = memberCountFor(kind === "MS" || kind === "WS" ? "SINGLES" : "DOUBLES");
    if (kind === "MS" || kind === "MD") male += count;
    else if (kind === "WS" || kind === "WD") female += count;
    else {
      male += 1;
      female += 1;
    }
  }
  return { male, female };
}

export function validateTeamFormat(format: TeamFormat): string[] {
  const errors: string[] = [];
  if (!Array.isArray(format.rubbers) || format.rubbers.length === 0) errors.push("团体赛至少需要 1 个小场");
  else if (format.rubbers.length > TEAM_RUBBERS_MAX) errors.push(`团体赛最多 ${TEAM_RUBBERS_MAX} 个小场`);
  else if (format.rubbers.some((kind) => !RUBBER_KINDS.includes(kind))) errors.push("小场只能是男单、女单、男双、女双或混双");
  const integers = [format.rosterMin, format.rosterMax, format.minMale, format.minFemale];
  if (integers.some((value) => !Number.isInteger(value) || value < 0)) {
    errors.push("名单人数设置必须是非负整数");
    return errors;
  }
  if (format.rosterMin < 1) errors.push("名单最少 1 人");
  if (format.rosterMax > TEAM_ROSTER_HARD_MAX) errors.push(`名单最多 ${TEAM_ROSTER_HARD_MAX} 人`);
  if (format.rosterMin > format.rosterMax) errors.push("名单最少人数不能大于最多人数");
  if (format.minMale + format.minFemale > format.rosterMax) errors.push("男女最少人数之和不能超过名单最多人数");
  for (const [key, label] of [["maxRubbersMale", "男"], ["maxRubbersFemale", "女"]] as const) {
    const value = format[key];
    if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 1 || value > TEAM_RUBBERS_MAX)) {
      errors.push(`${label}队员每场对抗最多出场小场数须为 1—${TEAM_RUBBERS_MAX}，或留空表示不设上限`);
    }
  }
  if (!errors.length) {
    const needs = genderSlotsPerTie(format.rubbers);
    if (needs.male > 0 && format.minMale === 0) errors.push("设置了男子或混合小场时，至少需要 1 名男队员");
    if (needs.female > 0 && format.minFemale === 0) errors.push("设置了女子或混合小场时，至少需要 1 名女队员");
    // 设了兼项上限时，名单最少人数要够排满一场对抗（例如男队员不得兼项、需要 4 男次时至少 4 名男队员）。
    const minMaleNeeded = format.maxRubbersMale ? Math.ceil(needs.male / format.maxRubbersMale) : 0;
    const minFemaleNeeded = format.maxRubbersFemale ? Math.ceil(needs.female / format.maxRubbersFemale) : 0;
    if (format.minMale < minMaleNeeded) {
      errors.push(`男队员每场最多 ${format.maxRubbersMale} 项、每场对抗需要 ${needs.male} 男次，名单至少要 ${minMaleNeeded} 名男队员`);
    }
    if (format.minFemale < minFemaleNeeded) {
      errors.push(`女队员每场最多 ${format.maxRubbersFemale} 项、每场对抗需要 ${needs.female} 女次，名单至少要 ${minFemaleNeeded} 名女队员`);
    }
  }
  return errors;
}

export interface TeamMemberInput extends MemberInput {
  gender?: string | null;
  /** 报项：可参加的小场类型。 */
  rubberKinds?: readonly string[] | null;
}

export interface NormalizedTeamMember extends NormalizedMember {
  studentId: string;
  gender: Gender;
  /** 按规范顺序去重后的报项。 */
  rubberKinds: RubberKind[];
}

function isGender(value: unknown): value is Gender {
  return value === "MALE" || value === "FEMALE";
}

function hasContent(input: TeamMemberInput) {
  return [input.displayName, input.studentId, input.teamName, input.contact, input.gender].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

/**
 * 校验一份团体名单：人数在范围内、每人有姓名/学号/性别、学号不重复、男女人数达到下限；
 * 每人至少报 1 项且报项与性别相符，本项目的每种小场都有足够的报项队员（单打 1 人、双打 2 人、混双 1 男 1 女）。
 * 空行忽略；出错时返回全部错误，便于负责人一次改完。
 */
export function validateTeamRoster(
  format: TeamFormat,
  inputs: readonly TeamMemberInput[],
): { members: NormalizedTeamMember[] | null; errors: string[] } {
  const errors: string[] = [];
  const rows = inputs.filter(hasContent);
  const members: NormalizedTeamMember[] = [];
  rows.forEach((input, index) => {
    const prefix = `第 ${index + 1} 名队员的`;
    const { member, errors: memberErrors } = validateMember({ ...input, teamName: null }, prefix);
    errors.push(...memberErrors);
    if (!member) return;
    if (!member.studentId) {
      errors.push(`${prefix}学号不能为空（团体赛以学号识别队员）`);
      return;
    }
    if (!isGender(input.gender)) {
      errors.push(`${prefix}性别必须选择「男」或「女」`);
      return;
    }
    const raw = Array.isArray(input.rubberKinds) ? input.rubberKinds : [];
    const unknown = raw.filter((kind) => !RUBBER_KINDS.includes(kind as RubberKind) || !format.rubbers.includes(kind as RubberKind));
    if (unknown.length) {
      errors.push(`${prefix}报项只能从本项目的小场（${describeRubbers(uniqueRubbers(format.rubbers))}）中选择`);
      return;
    }
    const allowed = eligibleRubberKinds(input.gender, format.rubbers);
    const kinds = RUBBER_KINDS.filter((kind) => raw.includes(kind));
    const wrongGender = kinds.filter((kind) => !allowed.includes(kind));
    if (wrongGender.length) {
      errors.push(`${prefix}报项「${describeRubbers(wrongGender)}」与性别「${GENDER_LABEL[input.gender]}」不符`);
      return;
    }
    if (!kinds.length) {
      errors.push(`${prefix}报项至少选 1 项`);
      return;
    }
    members.push({ ...member, studentId: member.studentId, gender: input.gender, rubberKinds: kinds });
  });

  if (rows.length < format.rosterMin) errors.push(`名单至少 ${format.rosterMin} 人，当前 ${rows.length} 人`);
  if (rows.length > format.rosterMax) errors.push(`名单最多 ${format.rosterMax} 人，当前 ${rows.length} 人`);

  const seen = new Map<string, number>();
  members.forEach((member, index) => {
    const previous = seen.get(member.studentId);
    if (previous !== undefined) errors.push(`学号 ${member.studentId} 在名单中重复（第 ${previous + 1} 与第 ${index + 1} 名）`);
    else seen.set(member.studentId, index);
  });

  if (members.length === rows.length) {
    const male = members.filter((member) => member.gender === "MALE").length;
    const female = members.length - male;
    if (male < format.minMale) errors.push(`至少需要 ${format.minMale} 名男队员，当前 ${male} 名`);
    if (female < format.minFemale) errors.push(`至少需要 ${format.minFemale} 名女队员，当前 ${female} 名`);
    errors.push(...rubberCoverageErrors(format.rubbers, members));
  }

  return errors.length ? { members: null, errors: [...new Set(errors)] } : { members, errors };
}

export const RUBBER_LABEL: Record<RubberKind, string> = {
  MS: "男单",
  WS: "女单",
  MD: "男双",
  WD: "女双",
  XD: "混双",
};

export function describeRubbers(rubbers: readonly RubberKind[]) {
  return rubbers.map((kind) => RUBBER_LABEL[kind]).join("、");
}

function uniqueRubbers(rubbers: readonly RubberKind[]) {
  return RUBBER_KINDS.filter((kind) => rubbers.includes(kind));
}

/**
 * 名单能否排满本项目的每种小场：报了该项且性别相符的人数够不够。
 * 同一队员可以兼项，所以只按「每种小场」各自判断，不要求总人数。
 */
export function rubberCoverageErrors(
  rubbers: readonly RubberKind[],
  members: readonly { gender: Gender; rubberKinds: readonly RubberKind[] }[],
): string[] {
  const errors: string[] = [];
  for (const kind of uniqueRubbers(rubbers)) {
    const entered = members.filter((member) => member.rubberKinds.includes(kind));
    const male = entered.filter((member) => member.gender === "MALE").length;
    const female = entered.length - male;
    const need = rubberGender(kind);
    if (need === "MIXED") {
      if (male < 1 || female < 1) errors.push(`报「混双」的队员至少要有 1 男 1 女，当前 ${male} 男 ${female} 女`);
    } else {
      const have = need === "MALE" ? male : female;
      if (have < rubberSize(kind)) errors.push(`报「${RUBBER_LABEL[kind]}」的队员至少 ${rubberSize(kind)} 人，当前 ${have} 人`);
    }
  }
  return errors;
}

export const TEAM_NAME_LIMIT = 30;

/** 队伍（学院）名称：单行、非公式、2—30 字。比较唯一性时用 `teamNameKey`（忽略全半角、大小写与空白）。 */
export function validateTeamName(raw: unknown): { name: string | null; error: string | null } {
  if (typeof raw !== "string") return { name: null, error: "队伍名称格式无效" };
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) return { name: null, error: "队伍名称含有换行或控制字符" };
  if (looksLikeFormula(raw)) return { name: null, error: "队伍名称以 = + - @ 开头，疑似表格公式，已拒绝" };
  const name = normalizeText(raw);
  const length = [...name].length;
  if (length < 2 || length > TEAM_NAME_LIMIT) return { name: null, error: `队伍名称应为 2—${TEAM_NAME_LIMIT} 个字符` };
  return { name, error: null };
}

export function teamNameKey(name: string) {
  return nameKey(name);
}

export function formatTeamCode(sequence: number) {
  return `T${String(sequence).padStart(2, "0")}`;
}

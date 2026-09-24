/**
 * 报名的纯规则：规范化、校验与去重键。无 IO、无框架，前后端只允许有这一份。
 *
 * 身份原则：
 * - 姓名不是身份。同名只提示「疑似重复」，绝不自动合并或自动拒绝。
 * - 学号在赛事内唯一，是唯一可以自动判定「同一人」的依据；它和联系方式只供内部审核，不公开。
 * - 双打 A+B 与 B+A 是同一组合：去重键对成员排序后生成。
 */

export type RegistrationEntryType = "SINGLES" | "DOUBLES";
export type RegistrationCompetitionKind = "MS" | "WS" | "MD" | "WD" | "XD";

export const COMPETITION_KIND_ENTRY_TYPE: Record<RegistrationCompetitionKind, RegistrationEntryType> = {
  MS: "SINGLES",
  WS: "SINGLES",
  MD: "DOUBLES",
  WD: "DOUBLES",
  XD: "DOUBLES",
};

export const COMPETITION_KIND_LABEL: Record<RegistrationCompetitionKind, string> = {
  MS: "男子单打",
  WS: "女子单打",
  MD: "男子双打",
  WD: "女子双打",
  XD: "混合双打",
};

export const MEMBER_FIELD_LIMITS = {
  displayName: 40,
  studentId: 32,
  teamName: 60,
  contact: 60,
} as const;

export const REGISTRATION_NOTE_LIMIT = 200;
export const REVIEW_REASON_LIMIT = 200;

export function memberCountFor(entryType: RegistrationEntryType) {
  return entryType === "SINGLES" ? 1 : 2;
}

// 控制字符（含换行、制表符）一律拒绝，而不是悄悄删掉。
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** NFKC 统一全角/半角，去首尾空白并把连续空白折叠为一个空格。 */
export function normalizeText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/** 学号大小写不敏感，内部空白无意义。 */
export function normalizeStudentId(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

/** 姓名比较键：忽略全半角、大小写和空白（「孙 七」与「孙七」相同）。只作提示或与学号共同使用，不单独判定身份。 */
export function nameKey(value: string) {
  return normalizeText(value).replace(/\s/g, "").toLowerCase();
}

/**
 * 表格软件会把以 `=`、`+`、`-`、`@` 开头的单元格当成公式执行。
 * 这类值既不会被本系统求值，也不允许入库，以免日后导出时被表格软件执行。
 * 联系方式允许 `+86 138…` 这类国际电话写法。
 */
export function looksLikeFormula(value: string, allowPhonePrefix = false) {
  const trimmed = value.trimStart();
  if (!trimmed) return false;
  if (allowPhonePrefix && /^\+[\d\s-]+$/.test(trimmed)) return false;
  return /^[=+\-@\t\r]/.test(trimmed);
}

export interface MemberInput {
  displayName?: string | null;
  studentId?: string | null;
  teamName?: string | null;
  contact?: string | null;
}

export interface NormalizedMember {
  displayName: string;
  studentId: string | null;
  teamName: string | null;
  contact: string | null;
}

type FieldName = keyof typeof MEMBER_FIELD_LIMITS;

const FIELD_LABEL: Record<FieldName, string> = {
  displayName: "姓名",
  studentId: "学号",
  teamName: "代表队/单位",
  contact: "联系方式",
};

function checkField(field: FieldName, raw: string | null | undefined, prefix: string, errors: string[]) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    errors.push(`${prefix}${FIELD_LABEL[field]}格式无效`);
    return null;
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    errors.push(`${prefix}${FIELD_LABEL[field]}含有换行或控制字符`);
    return null;
  }
  if (looksLikeFormula(raw, field === "contact")) {
    errors.push(`${prefix}${FIELD_LABEL[field]}以 = + - @ 开头，疑似表格公式，已拒绝`);
    return null;
  }
  const value = field === "studentId" ? normalizeStudentId(raw) : normalizeText(raw);
  if (!value) return null;
  if ([...value].length > MEMBER_FIELD_LIMITS[field]) {
    errors.push(`${prefix}${FIELD_LABEL[field]}超过 ${MEMBER_FIELD_LIMITS[field]} 个字符`);
    return null;
  }
  if (field === "studentId" && !/^[0-9A-Z-]+$/.test(value)) {
    errors.push(`${prefix}学号只能包含数字、字母和连字符`);
    return null;
  }
  return value;
}

export function validateMember(input: MemberInput, prefix = ""): { member: NormalizedMember | null; errors: string[] } {
  const errors: string[] = [];
  const displayName = checkField("displayName", input.displayName, prefix, errors);
  const studentId = checkField("studentId", input.studentId, prefix, errors);
  const teamName = checkField("teamName", input.teamName, prefix, errors);
  const contact = checkField("contact", input.contact, prefix, errors);
  if (!displayName && !errors.some((message) => message.startsWith(`${prefix}姓名`))) {
    errors.push(`${prefix}姓名不能为空`);
  }
  if (errors.length || !displayName) return { member: null, errors };
  return { member: { displayName, studentId, teamName, contact }, errors };
}

export function memberPrefix(entryType: RegistrationEntryType, index: number) {
  return entryType === "SINGLES" ? "" : `选手 ${index + 1} 的`;
}

/**
 * 校验一份报名的成员数与成员之间的关系。
 * 单打恰好 1 人；双打恰好 2 人且不能是同一学号。
 */
export function validateRegistrationMembers(
  entryType: RegistrationEntryType,
  inputs: readonly MemberInput[],
): { members: NormalizedMember[] | null; errors: string[] } {
  const expected = memberCountFor(entryType);
  const provided = inputs.filter((input) =>
    [input.displayName, input.studentId, input.teamName, input.contact].some(
      (value) => typeof value === "string" && value.trim() !== "",
    ),
  );
  const errors: string[] = [];
  if (entryType === "SINGLES" && provided.length > 1) {
    errors.push("单打项目只能填写 1 名选手");
  }
  const members: NormalizedMember[] = [];
  for (let index = 0; index < expected; index += 1) {
    const { member, errors: memberErrors } = validateMember(inputs[index] ?? {}, memberPrefix(entryType, index));
    errors.push(...memberErrors);
    if (member) members.push(member);
  }
  if (members.length === 2 && members[0].studentId && members[0].studentId === members[1].studentId) {
    errors.push("双打两名选手的学号相同，同一人不能与自己组队");
  }
  return errors.length ? { members: null, errors: [...new Set(errors)] } : { members, errors };
}

/**
 * 学号齐全时的硬去重键：同一项目内相同组合只允许一份进行中/已通过的报名。
 * 成员排序后拼接，所以 A+B 与 B+A 得到同一个键。任一成员缺学号时返回 null，改由审核时人工确认。
 */
export function registrationDedupeKey(members: readonly NormalizedMember[]) {
  if (!members.length || members.some((member) => !member.studentId)) return null;
  return members
    .map((member) => member.studentId as string)
    .sort()
    .join("|");
}

/** 「疑似重复」的软提示键：只用姓名，同样与成员顺序无关。 */
export function nameSetKey(members: readonly Pick<NormalizedMember, "displayName">[]) {
  return members
    .map((member) => nameKey(member.displayName))
    .sort()
    .join("|");
}

export function entryDisplayName(names: readonly string[]) {
  return names.join(" / ");
}

/** 不含易混字符（0/O、1/I/L）的回执编号字符表。 */
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function formatReferenceCode(randomBytes: Uint8Array) {
  if (randomBytes.length < 8) throw new Error("回执编号至少需要 8 个随机字节");
  const characters = [...randomBytes.subarray(0, 8)].map((byte) => REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]);
  return `R-${characters.slice(0, 4).join("")}-${characters.slice(4, 8).join("")}`;
}

export function formatEntryCode(competitionCode: string, sequence: number) {
  return `${competitionCode}-${String(sequence).padStart(3, "0")}`;
}

export function formatParticipantCode(sequence: number) {
  return `P${String(sequence).padStart(3, "0")}`;
}

export const COMPETITION_CODE_PATTERN = /^[A-Z][A-Z0-9-]{0,15}$/;

export function normalizeReason(value: unknown) {
  if (typeof value !== "string") return null;
  // 原因允许多行输入，换行折叠为空格；其余控制字符仍拒绝。
  const reason = normalizeText(value);
  if (!reason || [...reason].length > REVIEW_REASON_LIMIT || CONTROL_CHARACTERS.test(reason)) return null;
  return reason;
}

/** 备注：单行、非公式、200 字以内。空值返回 null。 */
export function validateNote(raw: string): { note: string | null; error: string | null } {
  if (CONTROL_CHARACTERS.test(raw.trim())) return { note: null, error: "备注含有换行或控制字符" };
  if (looksLikeFormula(raw)) return { note: null, error: "备注以 = + - @ 开头，疑似表格公式，已拒绝" };
  const note = normalizeText(raw);
  if ([...note].length > REGISTRATION_NOTE_LIMIT) return { note: null, error: `备注超过 ${REGISTRATION_NOTE_LIMIT} 个字符` };
  return { note: note || null, error: null };
}

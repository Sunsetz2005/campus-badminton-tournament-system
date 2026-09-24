import { randomBytes } from "node:crypto";

import { z } from "zod";

import { Prisma, type RegistrationSource, type TournamentPhase } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import {
  entryDisplayName,
  formatEntryCode,
  formatParticipantCode,
  formatReferenceCode,
  nameKey,
  normalizeReason,
  registrationDedupeKey,
  validateMember,
  validateNote,
  validateRegistrationMembers,
  type MemberInput,
  type NormalizedMember,
} from "@/domain/registration/registration-rules";
import { requireManagedTournament } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";

type Tx = Prisma.TransactionClient;

/** 可以新增或变更报名的赛事阶段。开赛后（RUNNING/FINISHED）一律拒绝。 */
export const REGISTRATION_EDITABLE_PHASES: TournamentPhase[] = ["PREPARING", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"];

export async function lockTournamentRow(transaction: Tx, tournamentId: string) {
  // 同一赛事的报名写入串行化：身份判定、去重和编号分配都依赖「读到的就是最新的」。
  await transaction.$queryRaw`SELECT "id" FROM "tournaments" WHERE "id" = ${tournamentId}::uuid FOR UPDATE`;
}

/**
 * 项目是否已锁定：赛事已开赛，或该项目已有比赛/已冻结的报名单位（抽签发布后由阶段 4-B 设置）。
 * 锁定后不允许新增、通过或撤回报名，避免悄悄改变已经生成的对阵。
 */
export async function lockedCompetitionIds(transaction: Tx, tournamentPhase: TournamentPhase, competitionIds: string[]) {
  if (!competitionIds.length) return new Set<string>();
  if (!REGISTRATION_EDITABLE_PHASES.includes(tournamentPhase)) return new Set(competitionIds);
  const [withMatches, withFrozenEntries] = await Promise.all([
    transaction.stage.findMany({
      where: { competitionId: { in: competitionIds }, matches: { some: {} } },
      select: { competitionId: true },
    }),
    transaction.entry.findMany({
      where: { competitionId: { in: competitionIds }, frozenAt: { not: null } },
      select: { competitionId: true },
    }),
  ]);
  return new Set([...withMatches, ...withFrozenEntries].map((row) => row.competitionId));
}

async function assertCompetitionEditable(transaction: Tx, tournamentPhase: TournamentPhase, competitionId: string) {
  const locked = await lockedCompetitionIds(transaction, tournamentPhase, [competitionId]);
  if (locked.has(competitionId)) {
    throw new AppError(409, "competition_locked", "该项目已开赛或已完成编排，不能再变更报名。");
  }
}

async function generateReferenceCode(transaction: Tx) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = formatReferenceCode(randomBytes(8));
    const existing = await transaction.registration.findUnique({ where: { referenceCode: code }, select: { id: true } });
    if (!existing) return code;
  }
  throw new AppError(503, "reference_code_exhausted", "暂时无法生成回执编号，请稍后重试。");
}

export interface InsertRegistrationInput {
  tournamentId: string;
  competition: { id: string; entryType: "SINGLES" | "DOUBLES" };
  members: NormalizedMember[];
  source: RegistrationSource;
  note: string | null;
  submittedByUserId?: string | null;
  inviteId?: string | null;
  submitterFingerprint?: string | null;
  importBatchId?: string | null;
  importRowNumber?: number | null;
}

/**
 * 写入一份待审核报名。调用方必须已持有赛事行锁。
 *
 * 硬性去重只依据学号：同一项目内，同一学号只能出现在一份进行中/已通过的报名里；
 * 学号齐全时 A+B 与 B+A 由 `dedupeKey` 与部分唯一索引兜底。只有姓名时不在这里拒绝，交给审核。
 */
export async function insertRegistration(transaction: Tx, input: InsertRegistrationInput) {
  const studentIds = input.members.map((member) => member.studentId).filter((value): value is string => Boolean(value));
  if (studentIds.length) {
    const holder = await transaction.registrationMember.findFirst({
      where: {
        studentId: { in: studentIds },
        registration: { competitionId: input.competition.id, status: { in: ["PENDING", "APPROVED"] } },
      },
      select: { studentId: true, registration: { select: { referenceCode: true } } },
    });
    if (holder) {
      throw new AppError(
        409,
        "member_already_registered",
        `学号 ${holder.studentId} 已在报名 ${holder.registration.referenceCode} 中报了同一项目。`,
      );
    }
    const entered = await transaction.entryMember.findFirst({
      where: { competitionId: input.competition.id, participant: { studentId: { in: studentIds } } },
      select: { participant: { select: { studentId: true } }, entry: { select: { code: true } } },
    });
    if (entered) {
      throw new AppError(
        409,
        "member_already_registered",
        `学号 ${entered.participant.studentId} 已是本项目报名单位 ${entered.entry.code} 的成员。`,
      );
    }
  }

  const referenceCode = await generateReferenceCode(transaction);
  return transaction.registration.create({
    data: {
      tournamentId: input.tournamentId,
      competitionId: input.competition.id,
      referenceCode,
      source: input.source,
      dedupeKey: registrationDedupeKey(input.members),
      note: input.note,
      submittedByUserId: input.submittedByUserId ?? null,
      inviteId: input.inviteId ?? null,
      submitterFingerprint: input.submitterFingerprint ?? null,
      importBatchId: input.importBatchId ?? null,
      importRowNumber: input.importRowNumber ?? null,
      members: {
        create: input.members.map((member, index) => ({
          slot: index + 1,
          displayName: member.displayName,
          studentId: member.studentId,
          teamName: member.teamName,
          contact: member.contact,
        })),
      },
    },
    select: { id: true, referenceCode: true },
  });
}

export function mapRegistrationWriteError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new AppError(409, "duplicate_registration", "同一项目已存在相同成员的报名（成员顺序不影响判定）。");
  }
  throw error;
}

export function parseNote(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new AppError(400, "invalid_input", "备注格式无效。");
  const { note, error } = validateNote(value);
  if (error) throw new AppError(400, "invalid_input", `${error}。`);
  return note;
}

export function validateMembersOrThrow(entryType: "SINGLES" | "DOUBLES", inputs: unknown) {
  if (!Array.isArray(inputs)) throw new AppError(400, "invalid_input", "请填写选手信息。");
  const { members, errors } = validateRegistrationMembers(entryType, inputs as MemberInput[]);
  if (!members) throw new AppError(400, "invalid_members", errors.join("；"), { errors });
  return members;
}

const manualSchema = z.object({
  competitionId: z.string().uuid(),
  members: z.array(z.record(z.string(), z.unknown())).max(2),
  note: z.string().nullish(),
});

/** 管理端手工录入：与导入、邀请一样只生成「待审核」报名。 */
export async function createManualRegistration(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  const parsed = manualSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "报名信息格式无效。");
  if (!REGISTRATION_EDITABLE_PHASES.includes(tournament.phase)) {
    throw new AppError(409, "tournament_locked", "赛事已开赛或结束，不能再新增报名。");
  }
  const competition = await prisma.competition.findFirst({
    where: { id: parsed.data.competitionId, tournamentId: tournament.id },
    select: { id: true, entryType: true },
  });
  if (!competition) throw new AppError(404, "competition_not_found", "项目不属于本赛事。");
  const members = validateMembersOrThrow(competition.entryType, parsed.data.members);
  const note = parseNote(parsed.data.note);

  try {
    return await prisma.$transaction(async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      await assertCompetitionEditable(transaction, tournament.phase, competition.id);
      const registration = await insertRegistration(transaction, {
        tournamentId: tournament.id,
        competition,
        members,
        source: "MANUAL",
        note,
        submittedByUserId: actorUserId,
      });
      await transaction.auditLog.create({
        data: {
          tournamentId: tournament.id,
          actorUserId,
          action: "REGISTRATION_CREATED",
          targetType: "Registration",
          targetId: registration.id,
          outcome: "SUCCESS",
          metadata: { source: "MANUAL", referenceCode: registration.referenceCode },
        },
      });
      return registration;
    });
  } catch (error) {
    return mapRegistrationWriteError(error);
  }
}

// --- 身份判定 -----------------------------------------------------------------

export interface IdentityCandidate {
  id: string;
  publicCode: string;
  displayName: string;
  studentId: string | null;
  teamName: string | null;
  competitions: string[];
}

export type IdentityPreview =
  | { kind: "MATCH"; participant: IdentityCandidate; reason: string }
  | { kind: "NEW" }
  | { kind: "AMBIGUOUS"; candidates: IdentityCandidate[]; reason: string }
  | { kind: "CONFLICT"; participant: IdentityCandidate; reason: string };

const candidateSelect = {
  id: true,
  publicCode: true,
  displayName: true,
  studentId: true,
  teamName: true,
  memberships: { select: { competition: { select: { code: true } } } },
} as const;

type CandidateRow = Prisma.ParticipantGetPayload<{ select: typeof candidateSelect }>;

function toCandidate(row: CandidateRow): IdentityCandidate {
  return {
    id: row.id,
    publicCode: row.publicCode,
    displayName: row.displayName,
    studentId: row.studentId,
    teamName: row.teamName,
    competitions: [...new Set(row.memberships.map((membership) => membership.competition.code))].sort(),
  };
}

async function sameNameParticipants(client: Tx | typeof prisma, tournamentId: string, displayName: string) {
  // 先用索引按原文缩小范围，再按规范化姓名精确比较；姓名只用于提示，不用于自动合并。
  const rows = await client.participant.findMany({
    where: { tournamentId, displayName: { equals: displayName, mode: "insensitive" } },
    select: candidateSelect,
    orderBy: { publicCode: "asc" },
  });
  const key = nameKey(displayName);
  return rows.filter((row) => nameKey(row.displayName) === key);
}

/**
 * 自动身份判定（不写库）：
 * - 有学号：学号命中且姓名一致 → 同一人；学号命中但姓名不同 → 冲突，必须人工处理；
 *   学号未命中但存在「无学号的同名人员」→ 可能是同一人，需人工确认；否则新建。
 * - 无学号：存在任何同名人员 → 需人工确认；否则新建。
 */
export async function previewIdentity(
  client: Tx | typeof prisma,
  tournamentId: string,
  member: Pick<NormalizedMember, "displayName" | "studentId">,
): Promise<IdentityPreview> {
  if (member.studentId) {
    const byStudentId = await client.participant.findUnique({
      where: { tournamentId_studentId: { tournamentId, studentId: member.studentId } },
      select: candidateSelect,
    });
    if (byStudentId) {
      const participant = toCandidate(byStudentId);
      if (nameKey(byStudentId.displayName) === nameKey(member.displayName)) {
        return { kind: "MATCH", participant, reason: `学号 ${member.studentId} 与 ${participant.publicCode} 一致` };
      }
      return {
        kind: "CONFLICT",
        participant,
        reason: `学号 ${member.studentId} 已属于 ${participant.publicCode} ${participant.displayName}，与报名姓名「${member.displayName}」不一致`,
      };
    }
    const unverified = (await sameNameParticipants(client, tournamentId, member.displayName)).filter((row) => !row.studentId);
    if (unverified.length) {
      return {
        kind: "AMBIGUOUS",
        candidates: unverified.map(toCandidate),
        reason: `已有未登记学号的同名人员「${member.displayName}」，无法判断是否同一人`,
      };
    }
    return { kind: "NEW" };
  }
  const sameName = await sameNameParticipants(client, tournamentId, member.displayName);
  if (sameName.length) {
    return {
      kind: "AMBIGUOUS",
      candidates: sameName.map(toCandidate),
      reason: `已有同名人员「${member.displayName}」且本报名没有学号，无法判断是否同一人`,
    };
  }
  return { kind: "NEW" };
}

/** 每个成员位的人工决定：沿用自动判定、确认新建为不同的人，或关联到指定的既有人员。 */
export type IdentityResolution = "AUTO" | "NEW" | { participantId: string };

const resolutionSchema = z.union([
  z.literal("AUTO"),
  z.literal("NEW"),
  z.object({ participantId: z.string().uuid() }),
]);

async function allocateParticipantCode(transaction: Tx, tournamentId: string) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const updated = await transaction.tournament.update({
      where: { id: tournamentId },
      data: { nextParticipantSeq: { increment: 1 } },
      select: { nextParticipantSeq: true },
    });
    const code = formatParticipantCode(updated.nextParticipantSeq - 1);
    const taken = await transaction.participant.findUnique({
      where: { tournamentId_publicCode: { tournamentId, publicCode: code } },
      select: { id: true },
    });
    if (!taken) return code;
  }
  throw new AppError(503, "participant_code_exhausted", "暂时无法分配选手编号。");
}

async function allocateEntryCode(transaction: Tx, competition: { id: string; code: string }) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const updated = await transaction.competition.update({
      where: { id: competition.id },
      data: { nextEntrySeq: { increment: 1 } },
      select: { nextEntrySeq: true },
    });
    const code = formatEntryCode(competition.code, updated.nextEntrySeq - 1);
    const taken = await transaction.entry.findUnique({
      where: { competitionId_code: { competitionId: competition.id, code } },
      select: { id: true },
    });
    if (!taken) return code;
  }
  throw new AppError(503, "entry_code_exhausted", "暂时无法分配报名单位编号。");
}

interface RegistrationMemberRow {
  slot: number;
  displayName: string;
  studentId: string | null;
  teamName: string | null;
  contact: string | null;
}

async function resolveMember(
  transaction: Tx,
  tournamentId: string,
  member: RegistrationMemberRow,
  resolution: IdentityResolution,
): Promise<{ participantId: string; created: boolean }> {
  const slotLabel = `第 ${member.slot} 位选手`;
  if (typeof resolution === "object") {
    const participant = await transaction.participant.findFirst({
      where: { id: resolution.participantId, tournamentId },
      select: { id: true, studentId: true, publicCode: true, teamName: true, contact: true },
    });
    if (!participant) throw new AppError(404, "participant_not_found", `${slotLabel}指定的人员不属于本赛事。`);
    if (member.studentId && participant.studentId && member.studentId !== participant.studentId) {
      throw new AppError(
        409,
        "identity_conflict",
        `${slotLabel}的学号 ${member.studentId} 与 ${participant.publicCode} 登记的学号不同，不能关联为同一人。`,
      );
    }
    if (member.studentId && !participant.studentId) {
      const holder = await transaction.participant.findUnique({
        where: { tournamentId_studentId: { tournamentId, studentId: member.studentId } },
        select: { publicCode: true },
      });
      if (holder) {
        throw new AppError(409, "identity_conflict", `${slotLabel}的学号 ${member.studentId} 已属于 ${holder.publicCode}。`);
      }
    }
    // 只补空缺字段，不覆盖既有登记；改名走独立的受审计入口。
    await transaction.participant.update({
      where: { id: participant.id },
      data: {
        studentId: participant.studentId ?? member.studentId,
        teamName: participant.teamName ?? member.teamName,
        contact: participant.contact ?? member.contact,
      },
    });
    return { participantId: participant.id, created: false };
  }

  if (resolution === "AUTO") {
    const preview = await previewIdentity(transaction, tournamentId, member);
    if (preview.kind === "MATCH") return { participantId: preview.participant.id, created: false };
    if (preview.kind === "AMBIGUOUS") {
      throw new AppError(409, "identity_ambiguous", `${slotLabel}：${preview.reason}。请选择关联到已有人员或确认新建。`, {
        slot: member.slot,
        candidates: preview.candidates,
      });
    }
    if (preview.kind === "CONFLICT") {
      throw new AppError(409, "identity_conflict", `${slotLabel}：${preview.reason}。请先核对报名信息。`, {
        slot: member.slot,
        candidates: [preview.participant],
      });
    }
  }

  // NEW：确认是不同的人。学号若已被占用，说明其实是同一人，不能新建第二条。
  if (member.studentId) {
    const holder = await transaction.participant.findUnique({
      where: { tournamentId_studentId: { tournamentId, studentId: member.studentId } },
      select: { publicCode: true },
    });
    if (holder) {
      throw new AppError(409, "identity_conflict", `${slotLabel}的学号 ${member.studentId} 已属于 ${holder.publicCode}，不能新建为另一人。`);
    }
  }
  const publicCode = await allocateParticipantCode(transaction, tournamentId);
  const participant = await transaction.participant.create({
    data: {
      tournamentId,
      publicCode,
      displayName: member.displayName,
      studentId: member.studentId,
      teamName: member.teamName,
      contact: member.contact,
    },
    select: { id: true },
  });
  return { participantId: participant.id, created: true };
}

const reviewSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("APPROVE"),
    expectedVersion: z.number().int().nonnegative(),
    resolutions: z.record(z.string(), resolutionSchema).optional(),
  }),
  z.object({ action: z.literal("REJECT"), expectedVersion: z.number().int().nonnegative(), reason: z.string() }),
  z.object({ action: z.literal("WITHDRAW"), expectedVersion: z.number().int().nonnegative(), reason: z.string() }),
]);

export type ReviewInput = z.input<typeof reviewSchema>;

async function loadRegistrationForReview(transaction: Tx, tournamentId: string, registrationId: string, expectedVersion: number) {
  const registration = await transaction.registration.findFirst({
    where: { id: registrationId, tournamentId },
    select: {
      id: true,
      status: true,
      version: true,
      referenceCode: true,
      entryId: true,
      competition: { select: { id: true, code: true, entryType: true } },
      members: {
        select: { slot: true, displayName: true, studentId: true, teamName: true, contact: true },
        orderBy: { slot: "asc" },
      },
    },
  });
  if (!registration) throw new AppError(404, "registration_not_found", "报名不存在。");
  if (registration.version !== expectedVersion) {
    throw new AppError(409, "version_conflict", "该报名已被他人处理，请刷新后重试。");
  }
  return registration;
}

async function bumpRegistration(
  transaction: Tx,
  registration: { id: string; version: number },
  data: Prisma.RegistrationUncheckedUpdateManyInput,
) {
  const updated = await transaction.registration.updateMany({
    where: { id: registration.id, version: registration.version },
    data: { ...data, version: registration.version + 1 },
  });
  if (updated.count !== 1) throw new AppError(409, "version_conflict", "该报名已被他人处理，请刷新后重试。");
}

/**
 * 审核一份报名。所有分支都带 `expectedVersion`，并在赛事行锁内执行：
 * 通过时解析身份、生成 Entry；驳回与撤回必须写原因；撤回已通过的报名会删除尚未进入编排的 Entry。
 */
export async function reviewRegistration(actorUserId: string, slug: string, registrationId: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  const parsed = reviewSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "审核请求格式无效。");
  const input = parsed.data;

  try {
    return await prisma.$transaction(async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const current = await transaction.tournament.findUniqueOrThrow({ where: { id: tournament.id }, select: { phase: true } });
      const registration = await loadRegistrationForReview(transaction, tournament.id, registrationId, input.expectedVersion);
      const reviewedAt = new Date();

      if (input.action === "REJECT") {
        if (registration.status !== "PENDING") throw new AppError(409, "invalid_status", "只能驳回待审核的报名。");
        const reason = normalizeReason(input.reason);
        if (!reason) throw new AppError(400, "reason_required", "驳回必须填写原因（200 字以内）。");
        await bumpRegistration(transaction, registration, {
          status: "REJECTED",
          reviewReason: reason,
          reviewedByUserId: actorUserId,
          reviewedAt,
        });
        await audit(transaction, tournament.id, actorUserId, "REGISTRATION_REJECTED", registration.id, {
          referenceCode: registration.referenceCode,
          reason,
        });
        return { status: "REJECTED" as const, version: registration.version + 1, entryCode: null };
      }

      if (input.action === "WITHDRAW") {
        if (registration.status !== "PENDING" && registration.status !== "APPROVED") {
          throw new AppError(409, "invalid_status", "只能撤回待审核或已通过的报名。");
        }
        const reason = normalizeReason(input.reason);
        if (!reason) throw new AppError(400, "reason_required", "撤回必须填写原因（200 字以内）。");
        await assertCompetitionEditable(transaction, current.phase, registration.competition.id);
        let removedEntryCode: string | null = null;
        if (registration.entryId) {
          const entry = await transaction.entry.findUniqueOrThrow({
            where: { id: registration.entryId },
            select: { code: true, frozenAt: true, _count: { select: { matchesAsA: true, matchesAsB: true } } },
          });
          if (entry.frozenAt || entry._count.matchesAsA + entry._count.matchesAsB > 0) {
            throw new AppError(409, "entry_locked", "该报名单位已进入编排，不能直接撤回。");
          }
          removedEntryCode = entry.code;
        }
        // 先解除关联再删 Entry（外键为语句末检查的 NO ACTION）。
        await bumpRegistration(transaction, registration, {
          status: "WITHDRAWN",
          entryId: null,
          reviewReason: reason,
          reviewedByUserId: actorUserId,
          reviewedAt,
        });
        if (registration.entryId) await transaction.entry.delete({ where: { id: registration.entryId } });
        await audit(transaction, tournament.id, actorUserId, "REGISTRATION_WITHDRAWN", registration.id, {
          referenceCode: registration.referenceCode,
          previousStatus: registration.status,
          removedEntryCode,
          reason,
        });
        return { status: "WITHDRAWN" as const, version: registration.version + 1, entryCode: null };
      }

      // APPROVE
      if (registration.status !== "PENDING") throw new AppError(409, "invalid_status", "只能通过待审核的报名。");
      await assertCompetitionEditable(transaction, current.phase, registration.competition.id);
      const resolutions = input.resolutions ?? {};
      const resolved: { slot: number; participantId: string; created: boolean }[] = [];
      for (const member of registration.members) {
        const decision = (resolutions[String(member.slot)] ?? "AUTO") as IdentityResolution;
        resolved.push({ slot: member.slot, ...(await resolveMember(transaction, tournament.id, member, decision)) });
      }
      if (new Set(resolved.map((item) => item.participantId)).size !== resolved.length) {
        throw new AppError(409, "duplicate_member", "两个成员位被判定为同一人，同一人不能与自己组队。");
      }
      const alreadyEntered = await transaction.entryMember.findFirst({
        where: {
          competitionId: registration.competition.id,
          participantId: { in: resolved.map((item) => item.participantId) },
        },
        select: { entry: { select: { code: true } }, participant: { select: { publicCode: true, displayName: true } } },
      });
      if (alreadyEntered) {
        throw new AppError(
          409,
          "already_entered",
          `${alreadyEntered.participant.publicCode} ${alreadyEntered.participant.displayName} 已是本项目报名单位 ${alreadyEntered.entry.code} 的成员，同一人在同一项目只能报一次。`,
        );
      }

      const participants = await transaction.participant.findMany({
        where: { id: { in: resolved.map((item) => item.participantId) } },
        select: { id: true, displayName: true },
      });
      const nameById = new Map(participants.map((participant) => [participant.id, participant.displayName]));
      const code = await allocateEntryCode(transaction, registration.competition);
      const entry = await transaction.entry.create({
        data: {
          competitionId: registration.competition.id,
          code,
          displayName: entryDisplayName(resolved.map((item) => nameById.get(item.participantId) ?? "")),
          entryType: registration.competition.entryType,
          members: {
            create: resolved.map((item) => ({
              slot: item.slot,
              competitionId: registration.competition.id,
              participantId: item.participantId,
            })),
          },
        },
        select: { id: true, code: true },
      });
      await bumpRegistration(transaction, registration, {
        status: "APPROVED",
        entryId: entry.id,
        reviewReason: null,
        reviewedByUserId: actorUserId,
        reviewedAt,
      });
      for (const item of resolved) {
        await transaction.registrationMember.update({
          where: { registrationId_slot: { registrationId: registration.id, slot: item.slot } },
          data: { participantId: item.participantId },
        });
      }
      await audit(transaction, tournament.id, actorUserId, "REGISTRATION_APPROVED", registration.id, {
        referenceCode: registration.referenceCode,
        entryCode: entry.code,
        participants: resolved.map((item) => ({ slot: item.slot, participantId: item.participantId, created: item.created })),
      });
      return { status: "APPROVED" as const, version: registration.version + 1, entryCode: entry.code };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "already_entered", "成员已在本项目另一报名单位中，或学号已被占用。");
    }
    throw error;
  }
}

const batchSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), expectedVersion: z.number().int().nonnegative() })).min(1).max(100),
});

/**
 * 批量通过：逐份独立事务，一份失败不影响其他份，也不会留下半份。
 * 需要人工确认身份的报名原样保留为待审核，并在结果中说明原因。
 */
export async function batchApproveRegistrations(actorUserId: string, slug: string, rawInput: unknown) {
  await requireManagedTournament(actorUserId, slug);
  const parsed = batchSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "批量审核请求格式无效（一次最多 100 份）。");
  const results: { id: string; ok: boolean; code?: string; message?: string; entryCode?: string | null }[] = [];
  for (const item of parsed.data.items) {
    try {
      const outcome = await reviewRegistration(actorUserId, slug, item.id, {
        action: "APPROVE",
        expectedVersion: item.expectedVersion,
      });
      results.push({ id: item.id, ok: true, entryCode: outcome.entryCode });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      results.push({ id: item.id, ok: false, code: error.code, message: error.message });
    }
  }
  return { results };
}

const renameSchema = z.object({ displayName: z.string(), reason: z.string() });

/**
 * 更正姓名（同一人，身份不变）。与「替换参赛人」严格区分：替换会改变 participantId，
 * 在 4-A 只能通过撤回并重新报名完成，编排冻结后不允许。改名任何阶段都留审计。
 */
export async function renameParticipant(actorUserId: string, slug: string, publicCode: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  const parsed = renameSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "改名请求格式无效。");
  const { member, errors } = validateMember({ displayName: parsed.data.displayName });
  if (!member) throw new AppError(400, "invalid_input", errors.join("；"));
  const reason = normalizeReason(parsed.data.reason);
  if (!reason) throw new AppError(400, "reason_required", "更正姓名必须填写原因（200 字以内）。");

  return prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, tournament.id);
    const participant = await transaction.participant.findUnique({
      where: { tournamentId_publicCode: { tournamentId: tournament.id, publicCode } },
      select: { id: true, displayName: true, memberships: { select: { entryId: true } } },
    });
    if (!participant) throw new AppError(404, "participant_not_found", "人员不存在。");
    if (participant.displayName === member.displayName) {
      throw new AppError(409, "name_unchanged", "新姓名与原姓名相同。");
    }
    await transaction.participant.update({ where: { id: participant.id }, data: { displayName: member.displayName } });
    for (const { entryId } of participant.memberships) {
      const members = await transaction.entryMember.findMany({
        where: { entryId },
        select: { participant: { select: { displayName: true } } },
        orderBy: { slot: "asc" },
      });
      await transaction.entry.update({
        where: { id: entryId },
        data: { displayName: entryDisplayName(members.map((row) => row.participant.displayName)) },
      });
    }
    await audit(transaction, tournament.id, actorUserId, "PARTICIPANT_RENAMED", participant.id, {
      publicCode,
      from: participant.displayName,
      to: member.displayName,
      reason,
    });
    return { publicCode, displayName: member.displayName };
  });
}

async function audit(
  transaction: Tx,
  tournamentId: string,
  actorUserId: string,
  action: string,
  targetId: string,
  metadata: Prisma.InputJsonValue,
) {
  await transaction.auditLog.create({
    data: {
      tournamentId,
      actorUserId,
      action,
      targetType: action.startsWith("PARTICIPANT") ? "Participant" : "Registration",
      targetId,
      outcome: "SUCCESS",
      metadata,
    },
  });
}

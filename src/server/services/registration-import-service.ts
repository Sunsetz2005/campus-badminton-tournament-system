import { createHash } from "node:crypto";

import { prisma } from "@/db/client";
import { parseCsv, toCsv } from "@/domain/registration/csv";
import { IMPORT_HEADERS, IMPORT_LIMITS, planImport, type ImportCompetition, type ImportPlan } from "@/domain/registration/import-plan";
import { nameSetKey } from "@/domain/registration/registration-rules";
import { requireManagedTournament } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import {
  insertRegistration,
  lockedCompetitionIds,
  lockTournamentRow,
  mapRegistrationWriteError,
  REGISTRATION_EDITABLE_PHASES,
} from "@/server/services/registration-service";
import type { Prisma } from "@/generated/prisma/client";

/**
 * CSV 批量导入：先预览、再确认。
 *
 * - 上传原文件不落盘、不入库，只保存内容摘要与计数，含个人信息的原件不会出现在任何公开目录。
 * - 单元格只当文本，从不求值；公式样式的内容整行判错。
 * - 确认时在赛事行锁内重新计算一次计划：内容摘要或计数与预览不一致就拒绝，全部写入在一个事务内，失败不留半份。
 * - 同一份内容（摘要相同）只能导入一次；与已有报名重复的行在预览中标为「重复」并跳过，不会重复建人。
 */

export function decodeImportBytes(bytes: Uint8Array) {
  if (bytes.byteLength === 0) throw new AppError(400, "import_empty", "导入文件为空。");
  if (bytes.byteLength > IMPORT_LIMITS.maxBytes) {
    throw new AppError(413, "import_too_large", `导入文件超过 ${IMPORT_LIMITS.maxBytes / 1024} KiB 上限。`);
  }
  // 常见的 Excel 导出有两种：「CSV UTF-8」和中文系统默认的 GB18030/GBK。
  for (const encoding of ["utf-8", "gb18030"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // 尝试下一种编码。
    }
  }
  throw new AppError(400, "import_encoding", "无法识别文件编码，请在表格软件中另存为「CSV UTF-8」。");
}

export function importContentHash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadImportContext(client: Prisma.TransactionClient | typeof prisma, tournamentId: string, phase: Parameters<typeof lockedCompetitionIds>[1]) {
  const competitions = await client.competition.findMany({
    where: { tournamentId },
    select: { id: true, code: true, name: true, entryType: true },
  });
  const locked = await lockedCompetitionIds(client as Prisma.TransactionClient, phase, competitions.map((item) => item.id));
  const active = await client.registration.findMany({
    where: { tournamentId, status: { in: ["PENDING", "APPROVED"] } },
    select: {
      competitionId: true,
      referenceCode: true,
      dedupeKey: true,
      members: { select: { displayName: true, studentId: true } },
    },
  });
  const enteredStudentIds = await client.entryMember.findMany({
    where: { competition: { tournamentId }, participant: { studentId: { not: null } } },
    select: { competitionId: true, entry: { select: { code: true } }, participant: { select: { studentId: true } } },
  });

  const activeDedupeKeys = new Map<string, string>();
  const activeStudentIds = new Map<string, string>();
  const activeNameSets = new Map<string, string>();
  for (const registration of active) {
    if (registration.dedupeKey) activeDedupeKeys.set(`${registration.competitionId}|${registration.dedupeKey}`, registration.referenceCode);
    for (const member of registration.members) {
      if (member.studentId) activeStudentIds.set(`${registration.competitionId}|${member.studentId}`, registration.referenceCode);
    }
    activeNameSets.set(`${registration.competitionId}|${nameSetKey(registration.members)}`, registration.referenceCode);
  }
  for (const row of enteredStudentIds) {
    const key = `${row.competitionId}|${row.participant.studentId}`;
    if (!activeStudentIds.has(key)) activeStudentIds.set(key, row.entry.code);
  }

  const competitionMap = new Map<string, ImportCompetition & { locked: boolean }>(
    competitions.map((item) => [item.code, { ...item, locked: locked.has(item.id) }]),
  );
  return { competitions: competitionMap, activeDedupeKeys, activeStudentIds, activeNameSets };
}

function planFromBytes(bytes: Uint8Array, context: Awaited<ReturnType<typeof loadImportContext>>): ImportPlan {
  const text = decodeImportBytes(bytes);
  const parsed = parseCsv(text, { maxRecords: IMPORT_LIMITS.maxDataRows + 1, maxColumns: IMPORT_LIMITS.maxColumns });
  if (!parsed.ok) {
    return { headerError: parsed.message, rows: [], counts: { total: 0, new: 0, duplicate: 0, error: 0 }, canCommit: false };
  }
  const plan = planImport(parsed.records, context);
  // 已开赛/已编排的项目不再接受新增。放在纯计划之外，因为「锁定」来自数据库状态。
  for (const row of plan.rows) {
    const competition = context.competitions.get(row.competitionCode);
    if (row.status !== "ERROR" && competition?.locked) {
      row.status = "ERROR";
      row.messages.push(`项目 ${competition.code} 已开赛或已完成编排，不能再导入报名`);
    }
  }
  plan.counts = {
    total: plan.rows.length,
    new: plan.rows.filter((row) => row.status === "NEW").length,
    duplicate: plan.rows.filter((row) => row.status === "DUPLICATE").length,
    error: plan.rows.filter((row) => row.status === "ERROR").length,
  };
  plan.canCommit = !plan.headerError && plan.counts.error === 0 && plan.counts.new > 0;
  return plan;
}

/** 预览只返回审核需要的内容；联系方式在预览中打码，不回显完整值。 */
function redactPlan(plan: ImportPlan) {
  return {
    ...plan,
    rows: plan.rows.map((row) => ({
      ...row,
      dedupeKey: undefined,
      competitionId: undefined,
      members: row.members.map((member) => ({ ...member, contact: member.contact ? maskContact(member.contact) : null })),
    })),
  };
}

export function maskContact(value: string) {
  const characters = [...value];
  if (characters.length <= 4) return "•".repeat(characters.length);
  return `${characters.slice(0, 3).join("")}${"•".repeat(characters.length - 5)}${characters.slice(-2).join("")}`;
}

function assertImportPhase(phase: Parameters<typeof lockedCompetitionIds>[1]) {
  if (!REGISTRATION_EDITABLE_PHASES.includes(phase)) {
    throw new AppError(409, "tournament_locked", "赛事已开赛或结束，不能再导入报名。");
  }
}

export async function previewRegistrationImport(actorUserId: string, slug: string, bytes: Uint8Array) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  assertImportPhase(tournament.phase);
  const contentHash = importContentHash(bytes);
  const context = await loadImportContext(prisma, tournament.id, tournament.phase);
  const plan = planFromBytes(bytes, context);
  const alreadyImported = await prisma.registrationImportBatch.findUnique({
    where: { tournamentId_contentHash: { tournamentId: tournament.id, contentHash } },
    select: { createdAt: true },
  });
  return {
    contentHash,
    alreadyImported: Boolean(alreadyImported),
    ...redactPlan(plan),
    canCommit: plan.canCommit && !alreadyImported,
  };
}

export interface CommitImportExpectation {
  contentHash: string;
  newCount: number;
  duplicateCount: number;
}

export async function commitRegistrationImport(
  actorUserId: string,
  slug: string,
  bytes: Uint8Array,
  expected: CommitImportExpectation,
) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  assertImportPhase(tournament.phase);
  const contentHash = importContentHash(bytes);
  if (contentHash !== expected.contentHash) {
    throw new AppError(409, "import_preview_stale", "文件内容与预览时不一致，请重新预览。");
  }

  try {
    return await prisma.$transaction(
      async (transaction) => {
        await lockTournamentRow(transaction, tournament.id);
        const phase = (await transaction.tournament.findUniqueOrThrow({ where: { id: tournament.id }, select: { phase: true } })).phase;
        assertImportPhase(phase);
        const existingBatch = await transaction.registrationImportBatch.findUnique({
          where: { tournamentId_contentHash: { tournamentId: tournament.id, contentHash } },
          select: { id: true },
        });
        if (existingBatch) throw new AppError(409, "import_already_committed", "这份文件已经导入过，不会重复导入。");

        const context = await loadImportContext(transaction, tournament.id, phase);
        const plan = planFromBytes(bytes, context);
        if (plan.headerError || plan.counts.error > 0) {
          throw new AppError(422, "import_has_errors", "文件仍有错误行，未导入任何数据。请重新预览。");
        }
        if (plan.counts.new !== expected.newCount || plan.counts.duplicate !== expected.duplicateCount) {
          throw new AppError(409, "import_preview_stale", "报名数据在预览后发生了变化，请重新预览后再确认。");
        }
        if (plan.counts.new === 0) throw new AppError(422, "import_nothing_new", "没有可导入的新报名。");

        const batch = await transaction.registrationImportBatch.create({
          data: {
            tournamentId: tournament.id,
            contentHash,
            rowCount: plan.counts.total,
            createdCount: plan.counts.new,
            skippedCount: plan.counts.duplicate,
            createdByUserId: actorUserId,
          },
          select: { id: true },
        });
        const created: string[] = [];
        for (const row of plan.rows) {
          if (row.status !== "NEW") continue;
          const competition = context.competitions.get(row.competitionCode);
          if (!competition) throw new AppError(422, "import_has_errors", `第 ${row.line} 行项目无效。`);
          const registration = await insertRegistration(transaction, {
            tournamentId: tournament.id,
            competition,
            members: row.members,
            source: "IMPORT",
            note: row.note,
            submittedByUserId: actorUserId,
            importBatchId: batch.id,
            importRowNumber: row.line,
          });
          created.push(registration.referenceCode);
        }
        await transaction.auditLog.create({
          data: {
            tournamentId: tournament.id,
            actorUserId,
            action: "REGISTRATION_IMPORT_COMMITTED",
            targetType: "RegistrationImportBatch",
            targetId: batch.id,
            outcome: "SUCCESS",
            metadata: { contentHash, rowCount: plan.counts.total, created: created.length, skipped: plan.counts.duplicate },
          },
        });
        return { batchId: batch.id, created: created.length, skipped: plan.counts.duplicate, referenceCodes: created };
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    return mapRegistrationWriteError(error);
  }
}

/** 真实模板：表头 + 本赛事项目代码说明（说明写在单独的文件名里，模板本身只有表头，不会误导入示例行）。 */
export async function registrationImportTemplate(actorUserId: string, slug: string) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  return { filename: `${tournament.slug}-registration-template.csv`, body: toCsv([[...IMPORT_HEADERS]]) };
}

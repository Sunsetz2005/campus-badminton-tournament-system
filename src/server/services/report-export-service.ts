import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { Prisma, type ReportEdition, type ReportKind, type TournamentRole } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { COMPETITION_KIND_LABEL } from "@/domain/registration/registration-rules";
import { GENDER_LABEL, RUBBER_LABEL, type RubberKind } from "@/domain/registration/team-roster";
import { utcToZonedLocal } from "@/domain/time/zoned-time";
import { dataRevision, type CapturedSnapshot, type ReportEditionValue } from "@/reports/report-model";
import { bookletFooterTemplate, renderBookletHtml } from "@/reports/booklet-html";
import { buildReportTables, MOCK_NOTICE, reportSubtitle, type ReportMeta } from "@/reports/report-tables";
import { buildXlsx, XLSX_MAX_ROWS, type XlsxSheet } from "@/reports/xlsx";
import { requireManagedTournament } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import { inspectPdf, renderPdf } from "@/server/services/pdf-renderer";
import { captureReportSnapshot, hashReportSnapshot } from "@/server/services/report-snapshot-service";

type Tx = Prisma.TransactionClient;

/** 单个文件的大小上限（数据库 CHECK 兜底 16 MiB）。 */
export const REPORT_MAX_BYTES = 15 * 1024 * 1024;

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_TYPE = "application/pdf";

export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  REGISTRATIONS_INTERNAL: "内部报名名单",
  DATA_WORKBOOK: "赛事数据表",
  BOOKLET_PDF: "成绩册",
};

const KIND_FILE_SLUG: Record<ReportKind, string> = {
  REGISTRATIONS_INTERNAL: "registrations-internal",
  DATA_WORKBOOK: "data",
  BOOKLET_PDF: "booklet",
};

/**
 * 权限：
 * - 内部报名名单含学号与联系方式，只有赛事管理员与编排员能生成和下载；
 * - 对外版本的草稿：管理员、编排员与裁判长；
 * - 正式版：与名次榜单发布相同，只有管理员与裁判长。
 */
export const REPORT_VIEW_ROLES: TournamentRole[] = ["ADMIN", "ORGANIZER", "CHIEF_REFEREE"];
const INTERNAL_ROLES: TournamentRole[] = ["ADMIN", "ORGANIZER"];
const OFFICIAL_ROLES: TournamentRole[] = ["ADMIN", "CHIEF_REFEREE"];

function rolesFor(kind: ReportKind, edition: ReportEdition | null): TournamentRole[] {
  if (kind === "REGISTRATIONS_INTERNAL") return INTERNAL_ROLES;
  return edition === "OFFICIAL" ? OFFICIAL_ROLES : REPORT_VIEW_ROLES;
}

function canDownload(roles: ReadonlySet<TournamentRole>, kind: ReportKind) {
  return (kind === "REGISTRATIONS_INTERNAL" ? INTERNAL_ROLES : REPORT_VIEW_ROLES).some((role) => roles.has(role));
}

/** 一个账号在同一赛事可以兼有多个角色（例如管理员兼裁判长），权限按全部角色判断。 */
export async function tournamentRoles(userId: string, tournamentId: string) {
  const rows = await prisma.roleAssignment.findMany({ where: { userId, tournamentId }, select: { role: true } });
  return new Set(rows.map((row) => row.role));
}

// ---------------------------------------------------------------------------
// 文件渲染
// ---------------------------------------------------------------------------

function renderDataWorkbook(captured: CapturedSnapshot, version: number | null) {
  const meta: ReportMeta = { capturedAt: captured.capturedAt, snapshotHash: captured.snapshotHash, version };
  const subtitle = reportSubtitle(captured.snapshot, meta);
  const tables = buildReportTables(captured.snapshot, meta);
  const sheets: XlsxSheet[] = tables.map((table) => ({
    name: table.title,
    title: `${captured.snapshot.tournament.name} · ${table.title}`,
    subtitle,
    columns: table.columns,
    rows: table.rows.length ? table.rows : [[table.empty]],
    notes: table.notes,
  }));
  return buildXlsx({ title: `${captured.snapshot.tournament.name} 赛事数据表`, createdAt: captured.capturedAt, sheets });
}

const registrationSelect = {
  referenceCode: true,
  status: true,
  source: true,
  note: true,
  reviewReason: true,
  createdAt: true,
  reviewedAt: true,
  competition: { select: { code: true, name: true, kind: true } },
  team: { select: { code: true, name: true } },
  entry: { select: { code: true } },
  members: {
    orderBy: { slot: "asc" },
    select: {
      slot: true,
      displayName: true,
      studentId: true,
      gender: true,
      contact: true,
      teamName: true,
      rubberKinds: true,
      participant: { select: { publicCode: true } },
    },
  },
} satisfies Prisma.RegistrationSelect;

type RegistrationRow = Prisma.RegistrationGetPayload<{ select: typeof registrationSelect }>;

const STATUS_LABEL = { PENDING: "待审核", APPROVED: "已通过", REJECTED: "已驳回", WITHDRAWN: "已撤回" } as const;
const SOURCE_LABEL = { MANUAL: "后台录入", IMPORT: "CSV 导入", INVITE: "邀请链接", TEAM_MANAGER: "队伍负责人" } as const;

async function loadInternalRegistrations(tx: Tx, tournamentId: string) {
  const registrations = await tx.registration.findMany({
    where: { tournamentId },
    orderBy: [{ competition: { code: "asc" } }, { createdAt: "asc" }],
    select: registrationSelect,
  });
  // 由种子或历史数据直接建立、没有报名记录的报名单位，同样列出其成员（含内部字段）。
  const entries = await tx.entry.findMany({
    where: { competition: { tournamentId }, registration: null },
    orderBy: [{ competition: { code: "asc" } }, { code: "asc" }],
    select: {
      code: true,
      displayName: true,
      competition: { select: { name: true } },
      members: {
        orderBy: { slot: "asc" },
        select: { slot: true, participant: { select: { publicCode: true, displayName: true, studentId: true, gender: true, contact: true, teamName: true } } },
      },
    },
  });
  return { registrations, entries };
}

function renderInternalRegistrations(
  captured: CapturedSnapshot & { extra: Awaited<ReturnType<typeof loadInternalRegistrations>> },
  version: number | null,
  timeZone: string,
) {
  const meta: ReportMeta = { capturedAt: captured.capturedAt, snapshotHash: captured.snapshotHash, version };
  const at = (value: Date | null) => (value ? utcToZonedLocal(value, timeZone).replace("T", " ") : "");
  const subtitle = `内部资料：含学号与联系方式，仅供赛事工作人员审核使用，不得公开或外传 · ${reportSubtitle(captured.snapshot, meta).replace(/^(正式版|草稿)( · )?/, "")}`;
  const rows = captured.extra.registrations.flatMap((registration: RegistrationRow) =>
    registration.members.map((member) => [
      registration.competition.name,
      registration.referenceCode,
      STATUS_LABEL[registration.status],
      SOURCE_LABEL[registration.source],
      registration.team?.name ?? "",
      registration.entry?.code ?? "",
      member.slot,
      member.displayName,
      member.participant?.publicCode ?? "",
      member.studentId ?? "",
      member.gender ? GENDER_LABEL[member.gender] : "",
      member.contact ?? "",
      member.teamName ?? "",
      member.rubberKinds.map((kind) => RUBBER_LABEL[kind as RubberKind] ?? COMPETITION_KIND_LABEL[kind as keyof typeof COMPETITION_KIND_LABEL] ?? kind).join("、"),
      at(registration.createdAt),
      at(registration.reviewedAt),
      [registration.note, registration.reviewReason].filter(Boolean).join("；"),
    ]),
  );
  const entryRows = captured.extra.entries.flatMap((entry) =>
    entry.members.map((member) => [
      entry.competition.name,
      entry.code,
      entry.displayName,
      member.slot,
      member.participant.displayName,
      member.participant.publicCode,
      member.participant.studentId ?? "",
      member.participant.gender ? GENDER_LABEL[member.participant.gender] : "",
      member.participant.contact ?? "",
      member.participant.teamName ?? "",
    ]),
  );
  const name = captured.snapshot.tournament.name;
  const sheets: XlsxSheet[] = [
    {
      name: "报名记录",
      title: `${name} · 内部报名名单`,
      subtitle,
      columns: [
        { header: "项目", width: 14 },
        { header: "报名编号", width: 18 },
        { header: "状态", width: 8 },
        { header: "来源", width: 10 },
        { header: "队伍", width: 16 },
        { header: "报名单位编号", width: 12 },
        { header: "序号", width: 6 },
        { header: "姓名", width: 16 },
        { header: "公开编号", width: 10 },
        { header: "学号", width: 14 },
        { header: "性别", width: 6 },
        { header: "联系方式", width: 18 },
        { header: "代表队", width: 18 },
        { header: "报项", width: 18 },
        { header: "提交时间", width: 17 },
        { header: "审核时间", width: 17 },
        { header: "备注/审核意见", width: 30 },
      ],
      rows: rows.length ? rows : [["暂无报名记录。"]],
      notes: [MOCK_NOTICE, `时间为赛事时区 ${timeZone}。`],
    },
    {
      name: "无报名记录的报名单位",
      title: `${name} · 直接建立的报名单位（内部）`,
      subtitle,
      columns: [
        { header: "项目", width: 14 },
        { header: "编号", width: 12 },
        { header: "名称", width: 22 },
        { header: "序号", width: 6 },
        { header: "姓名", width: 16 },
        { header: "公开编号", width: 10 },
        { header: "学号", width: 14 },
        { header: "性别", width: 6 },
        { header: "联系方式", width: 18 },
        { header: "代表队", width: 18 },
      ],
      rows: entryRows.length ? entryRows : [["没有。"]],
      notes: ["由模拟种子等途径直接建立、没有报名申请记录的报名单位。"],
    },
  ];
  return buildXlsx({ title: `${name} 内部报名名单`, createdAt: captured.capturedAt, sheets });
}

// ---------------------------------------------------------------------------
// 生成与存档
// ---------------------------------------------------------------------------

const generateSchema = z.object({
  kind: z.enum(["REGISTRATIONS_INTERNAL", "DATA_WORKBOOK", "BOOKLET_PDF"]),
  edition: z.enum(["DRAFT", "OFFICIAL"]).nullish(),
});

function fileNames(slug: string, tournamentName: string, kind: ReportKind, edition: ReportEdition | null, version: number, extension: string) {
  const editionSlug = edition ? `-${edition.toLowerCase()}` : "";
  const editionText = edition === "OFFICIAL" ? "-正式版" : edition === "DRAFT" ? "-草稿" : "";
  return {
    fileName: `${slug}-${KIND_FILE_SLUG[kind]}${editionSlug}-v${version}.${extension}`,
    displayName: `${tournamentName}-${REPORT_KIND_LABEL[kind]}${editionText}-第${version}版.${extension}`,
  };
}

export interface GeneratedFile {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

/** 已生成的文件交给这里存档：分配版本、处理「已被替代」、写审计。同一数据的正式版不重复生成。 */
export async function storeReportExport(
  actorUserId: string,
  tournament: { id: string; slug: string; name: string },
  kind: ReportKind,
  edition: ReportEdition | null,
  captured: CapturedSnapshot,
  render: (version: number) => GeneratedFile | Promise<GeneratedFile>,
  sources: Record<string, unknown>,
) {
  return prisma.$transaction(
    async (tx) => {
      // 同一赛事的导出串行化（版本号分配与「当前正式版」替代）；不占用赛事行锁，渲染 PDF 期间不阻塞报名等其他写入。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`report-export:${tournament.id}`}, 0))`;
      const latest = await tx.reportExport.findFirst({
        where: { tournamentId: tournament.id, kind },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const current =
        edition === "OFFICIAL"
          ? await tx.reportExport.findFirst({
              where: { tournamentId: tournament.id, kind, edition: "OFFICIAL", supersededAt: null },
              select: { id: true, version: true, snapshotHash: true },
            })
          : null;
      if (current && current.snapshotHash === captured.snapshotHash) {
        throw new AppError(409, "report_unchanged", `数据自第 ${current.version} 版正式版生成以来没有变化，无需重新生成，可直接下载该版本。`);
      }
      const version = (latest?.version ?? 0) + 1;
      const file = await render(version);
      if (file.bytes.length > REPORT_MAX_BYTES) {
        throw new AppError(413, "report_too_large", `生成的文件约 ${(file.bytes.length / 1024 / 1024).toFixed(1)} MiB，超过 ${REPORT_MAX_BYTES / 1024 / 1024} MiB 上限。`);
      }
      const names = fileNames(tournament.slug, tournament.name, kind, edition, version, file.extension);
      const id = randomUUID();
      const now = new Date();
      if (current) {
        await tx.reportExport.update({ where: { id: current.id }, data: { supersededAt: now, supersededByExportId: id } });
      }
      const created = await tx.reportExport.create({
        data: {
          id,
          tournamentId: tournament.id,
          kind,
          edition,
          version,
          snapshotHash: captured.snapshotHash,
          capturedAt: captured.capturedAt,
          sources: sources as Prisma.InputJsonValue,
          fileName: names.fileName,
          contentType: file.contentType,
          byteSize: file.bytes.length,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
          content: new Uint8Array(file.bytes),
          createdByUserId: actorUserId,
        },
        select: { id: true, version: true, fileName: true, byteSize: true, sha256: true, snapshotHash: true },
      });
      await tx.auditLog.create({
        data: {
          tournamentId: tournament.id,
          actorUserId,
          action: "REPORT_EXPORTED",
          targetType: "ReportExport",
          targetId: created.id,
          outcome: "SUCCESS",
          metadata: {
            kind,
            edition,
            version,
            dataRevision: dataRevision(captured.snapshotHash),
            sha256: created.sha256,
            supersededVersion: current?.version ?? null,
          },
        },
      });
      return { ...created, displayName: names.displayName, supersededVersion: current?.version ?? null };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

async function renderBooklet(captured: CapturedSnapshot, version: number): Promise<GeneratedFile> {
  const meta: ReportMeta = { capturedAt: captured.capturedAt, snapshotHash: captured.snapshotHash, version };
  const pdf = await renderPdf(renderBookletHtml(captured.snapshot, meta), bookletFooterTemplate(captured.snapshot, meta));
  inspectPdf(pdf);
  return { bytes: pdf, contentType: PDF_TYPE, extension: "pdf" };
}

/** 生成一份导出文件（Excel 或 PDF 成绩册）并存档。 */
export async function generateReportExport(actorUserId: string, slug: string, rawInput: unknown) {
  const parsed = generateSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "请求格式无效。");
  const kind = parsed.data.kind;
  const edition: ReportEdition | null = kind === "REGISTRATIONS_INTERNAL" ? null : (parsed.data.edition ?? "DRAFT");
  const { tournament } = await requireManagedTournament(actorUserId, slug, rolesFor(kind, edition));
  const snapshotEdition: ReportEditionValue = edition ?? "DRAFT";

  if (kind === "REGISTRATIONS_INTERNAL") {
    const loaded = await captureReportSnapshot(tournament.id, snapshotEdition, (tx) => loadInternalRegistrations(tx, tournament.id));
    // 内部名单的数据修订号按报名数据本身计算（对外快照不含这些字段）。
    const captured = { ...loaded, snapshotHash: hashReportSnapshot(JSON.parse(JSON.stringify(loaded.extra))) };
    const rowCount = captured.extra.registrations.reduce((sum, item) => sum + item.members.length, 0);
    if (rowCount > XLSX_MAX_ROWS) throw new AppError(413, "report_too_large", `报名记录共 ${rowCount} 行，超过单表 ${XLSX_MAX_ROWS} 行的导出上限。`);
    return storeReportExport(
      actorUserId,
      tournament,
      kind,
      null,
      captured,
      (version) => ({ bytes: renderInternalRegistrations(captured, version, captured.snapshot.tournament.timezone), contentType: XLSX_TYPE, extension: "xlsx" }),
      { registrations: captured.extra.registrations.length },
    );
  }

  const captured = await captureReportSnapshot(tournament.id, snapshotEdition);
  if (kind === "BOOKLET_PDF") {
    return storeReportExport(actorUserId, tournament, kind, edition, captured, (version) => renderBooklet(captured, version), { standings: captured.snapshot.standings });
  }
  return storeReportExport(
    actorUserId,
    tournament,
    kind,
    edition,
    captured,
    (version) => {
      try {
        return { bytes: renderDataWorkbook(captured, version), contentType: XLSX_TYPE, extension: "xlsx" };
      } catch (error) {
        if (error instanceof RangeError) throw new AppError(413, "report_too_large", error.message);
        throw error;
      }
    },
    { standings: captured.snapshot.standings },
  );
}

// ---------------------------------------------------------------------------
// 列表与下载
// ---------------------------------------------------------------------------

export interface ReportExportSummary {
  id: string;
  kind: ReportKind;
  edition: ReportEdition | null;
  version: number;
  dataRevision: string;
  capturedAt: string;
  createdAt: string;
  createdBy: string | null;
  fileName: string;
  byteSize: number;
  sha256: string;
  supersededAt: string | null;
  supersededByVersion: number | null;
}

export async function listReportExports(tournamentId: string, roles: ReadonlySet<TournamentRole>): Promise<ReportExportSummary[]> {
  const rows = await prisma.reportExport.findMany({
    where: { tournamentId },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      kind: true,
      edition: true,
      version: true,
      snapshotHash: true,
      capturedAt: true,
      createdAt: true,
      fileName: true,
      byteSize: true,
      sha256: true,
      supersededAt: true,
      supersededByExportId: true,
      createdBy: { select: { name: true } },
    },
  });
  const versions = new Map(rows.map((row) => [row.id, row.version]));
  return rows
    .filter((row) => canDownload(roles, row.kind))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      edition: row.edition,
      version: row.version,
      dataRevision: dataRevision(row.snapshotHash),
      capturedAt: row.capturedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy?.name ?? null,
      fileName: row.fileName,
      byteSize: row.byteSize,
      sha256: row.sha256,
      supersededAt: row.supersededAt?.toISOString() ?? null,
      supersededByVersion: row.supersededByExportId ? (versions.get(row.supersededByExportId) ?? null) : null,
    }));
}

/** 管理端下载：按文件种类再次校验角色；ID 必须属于该赛事，否则一律 404。 */
export async function getReportExportFile(actorUserId: string, slug: string, exportId: string) {
  if (!z.string().uuid().safeParse(exportId).success) throw new AppError(404, "report_not_found", "文件不存在。");
  const { tournament } = await requireManagedTournament(actorUserId, slug, REPORT_VIEW_ROLES);
  const row = await prisma.reportExport.findFirst({
    where: { id: exportId, tournamentId: tournament.id },
    select: { kind: true, edition: true, version: true, fileName: true, contentType: true, content: true, sha256: true },
  });
  if (!row) throw new AppError(404, "report_not_found", "文件不存在。");
  if (!canDownload(await tournamentRoles(actorUserId, tournament.id), row.kind)) throw new AppError(403, "report_forbidden", "你没有下载该文件的权限。");
  const extension = row.fileName.split(".").pop() ?? "bin";
  return {
    ...row,
    content: Buffer.from(row.content),
    displayName: fileNames(tournament.slug, tournament.name, row.kind, row.edition, row.version, extension).displayName,
  };
}

/** `Content-Disposition`：ASCII 文件名兜底，中文名按 RFC 5987 编码，不拼接任何未经处理的用户输入。 */
export function contentDisposition(fileName: string, displayName: string) {
  const encoded = encodeURIComponent(displayName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fileName}"; filename*=UTF-8''${encoded}`;
}

/** 页面用：当前数据的修订号（草稿、正式两种口径），用于提示「数据已变化，请重新生成」。 */
export async function currentDataRevisions(tournamentId: string) {
  const result: Record<ReportEditionValue, { revision: string | null; error: string | null }> = {
    DRAFT: { revision: null, error: null },
    OFFICIAL: { revision: null, error: null },
  };
  for (const edition of ["DRAFT", "OFFICIAL"] as const) {
    try {
      const captured = await captureReportSnapshot(tournamentId, edition);
      result[edition].revision = dataRevision(captured.snapshotHash);
    } catch (error) {
      if (error instanceof AppError) result[edition].error = error.message;
      else throw error;
    }
  }
  return result;
}

import type { ReportKind } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { dataRevision, type ReportSnapshot } from "@/reports/report-model";
import { AppError } from "@/server/services/errors";
import { isPublicTournamentSlug } from "@/server/services/public-tournament-service";
import { captureReportSnapshot } from "@/server/services/report-snapshot-service";

/**
 * 公开端的成绩与成绩册：只对已发布赛事开放。
 *
 * - 「对阵与名次」页读取正式口径的快照：只显示经裁判长复核锁定的结果、已确认的小组名次与已发布的名次榜单；
 *   榜单发布后若又有更正尚未重新发布，照常显示最后发布的版本并标记「更正处理中」；
 * - 下载只提供**当前**正式版文件（未被替代的那一份），内容就是管理端存档的原文件，不在公开请求里重新生成。
 * 快照本身只含对外字段（见 `report-model.ts`），公开端与导出文件共用同一份白名单。
 */

async function publishedTournamentId(slug: string) {
  if (!isPublicTournamentSlug(slug)) return null;
  const tournament = await prisma.tournament.findFirst({ where: { slug, status: "PUBLISHED" }, select: { id: true } });
  return tournament?.id ?? null;
}

export interface PublicResultsView {
  snapshot: ReportSnapshot;
  capturedAt: string;
  dataRevision: string;
}

export async function getPublicResults(slug: string): Promise<PublicResultsView> {
  const tournamentId = await publishedTournamentId(slug);
  if (!tournamentId) throw new AppError(404, "tournament_not_found", "公开赛事不存在或尚未发布。");
  const captured = await captureReportSnapshot(tournamentId, "OFFICIAL", undefined, { strictStandings: false });
  return { snapshot: captured.snapshot, capturedAt: captured.capturedAt.toISOString(), dataRevision: dataRevision(captured.snapshotHash) };
}

export const PUBLIC_REPORT_KINDS = {
  booklet: "BOOKLET_PDF",
  data: "DATA_WORKBOOK",
} as const satisfies Record<string, ReportKind>;

export type PublicReportKey = keyof typeof PUBLIC_REPORT_KINDS;

export function isPublicReportKey(value: string): value is PublicReportKey {
  return Object.hasOwn(PUBLIC_REPORT_KINDS, value);
}

export interface PublicReportFile {
  key: PublicReportKey;
  version: number;
  dataRevision: string;
  capturedAt: string;
  byteSize: number;
  sha256: string;
}

/** 当前正式版文件的目录（不含内容）。内部报名名单永远不会出现在这里。 */
export async function listPublicReportFiles(slug: string): Promise<PublicReportFile[]> {
  const tournamentId = await publishedTournamentId(slug);
  if (!tournamentId) throw new AppError(404, "tournament_not_found", "公开赛事不存在或尚未发布。");
  const rows = await prisma.reportExport.findMany({
    where: { tournamentId, edition: "OFFICIAL", supersededAt: null, kind: { in: Object.values(PUBLIC_REPORT_KINDS) } },
    select: { kind: true, version: true, snapshotHash: true, capturedAt: true, byteSize: true, sha256: true },
  });
  const keyOf = Object.fromEntries(Object.entries(PUBLIC_REPORT_KINDS).map(([key, kind]) => [kind, key])) as Record<ReportKind, PublicReportKey>;
  return rows
    .map((row) => ({
      key: keyOf[row.kind],
      version: row.version,
      dataRevision: dataRevision(row.snapshotHash),
      capturedAt: row.capturedAt.toISOString(),
      byteSize: row.byteSize,
      sha256: row.sha256,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** 下载当前正式版文件；草稿、已被替代的旧版与内部名单一律 404。 */
export async function getPublicReportFile(slug: string, key: string) {
  if (!isPublicReportKey(key)) throw new AppError(404, "report_not_found", "文件不存在。");
  const tournamentId = await publishedTournamentId(slug);
  if (!tournamentId) throw new AppError(404, "report_not_found", "文件不存在。");
  const row = await prisma.reportExport.findFirst({
    where: { tournamentId, kind: PUBLIC_REPORT_KINDS[key], edition: "OFFICIAL", supersededAt: null },
    select: { fileName: true, contentType: true, content: true, sha256: true, version: true, tournament: { select: { name: true } } },
  });
  if (!row) throw new AppError(404, "report_not_found", "该赛事尚未发布正式版文件。");
  const extension = row.fileName.split(".").pop() ?? "bin";
  const label = key === "booklet" ? "成绩册" : "赛事数据表";
  return {
    fileName: row.fileName,
    displayName: `${row.tournament.name}-${label}-正式版-第${row.version}版.${extension}`,
    contentType: row.contentType,
    content: Buffer.from(row.content),
    sha256: row.sha256,
  };
}

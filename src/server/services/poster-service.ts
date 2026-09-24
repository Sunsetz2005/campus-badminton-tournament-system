import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/db/client";
import { requireTournamentRole } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";

/** 2 MiB。校园赛事海报远小于此，上限主要用于挡住误传与滥用。 */
export const MAX_POSTER_BYTES = 2 * 1024 * 1024;

/**
 * 只接受三种位图格式，并且**以魔数字节为准**。
 * 客户端声明的 content-type 和上传文件名一律不被信任。
 */
const SIGNATURES = [
  { extension: "png", test: (bytes: Uint8Array) => hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { extension: "jpg", test: (bytes: Uint8Array) => hasPrefix(bytes, [0xff, 0xd8, 0xff]) },
  {
    extension: "webp",
    test: (bytes: Uint8Array) =>
      hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytes.length > 11 &&
      hasPrefix(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
] as const;

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]) {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

export function detectPosterExtension(bytes: Uint8Array): string | null {
  return SIGNATURES.find((signature) => signature.test(bytes))?.extension ?? null;
}

export function posterDirectory() {
  return path.join(process.cwd(), "public", "posters");
}

export interface UploadPosterResult {
  posterPath: string;
}

/**
 * 上传赛事海报。
 *
 * 文件名由服务端重新生成，绝不采用上传名，因此不存在路径穿越或覆盖既有文件的可能；
 * 数据库上的 `tournaments_poster_path_check` 是第二道兜底。
 */
export async function uploadTournamentPoster(
  actorUserId: string,
  slug: string,
  file: { bytes: Uint8Array; alt?: string | null },
): Promise<UploadPosterResult> {
  const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
  if (!tournament) throw new AppError(404, "tournament_not_found", "赛事不存在。");
  await requireTournamentRole(actorUserId, tournament.id, ["ADMIN", "ORGANIZER"]);

  if (file.bytes.byteLength === 0) throw new AppError(400, "poster_empty", "海报文件为空。");
  if (file.bytes.byteLength > MAX_POSTER_BYTES) {
    throw new AppError(413, "poster_too_large", "海报文件超过 2 MiB 上限。");
  }
  const extension = detectPosterExtension(file.bytes);
  if (!extension) {
    throw new AppError(415, "poster_unsupported_type", "海报只支持 PNG、JPEG 或 WebP 图片。");
  }

  const posterPath = `${randomUUID()}.${extension}`;
  const directory = posterDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, posterPath), file.bytes, { flag: "wx" });

  await prisma.$transaction(async (transaction) => {
    await transaction.tournament.update({
      where: { id: tournament.id },
      data: { posterPath, posterAlt: file.alt?.trim() || null },
    });
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "TOURNAMENT_POSTER_UPLOADED",
        targetType: "Tournament",
        targetId: tournament.id,
        outcome: "SUCCESS",
        metadata: { posterPath, bytes: file.bytes.byteLength, extension },
      },
    });
  });

  return { posterPath };
}

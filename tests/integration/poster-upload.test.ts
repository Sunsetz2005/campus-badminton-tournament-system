import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import {
  detectPosterExtension,
  MAX_POSTER_BYTES,
  posterDirectory,
  uploadTournamentPoster,
} from "@/server/services/poster-service";

const SLUG = "phase-1-demo";

/** 最小合法位图；只需要足以通过魔数嗅探。 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
/** 伪装成图片的可执行脚本：声明类型无论写什么都必须被拒。 */
const SCRIPT = new TextEncoder().encode("<?php system($_GET['c']); ?>");

const uploaded: string[] = [];

describe("赛事海报上传", () => {
  let adminId = "";
  let refereeId = "";
  let originalPoster: { posterPath: string | null; posterAlt: string | null } = { posterPath: null, posterAlt: null };

  beforeAll(async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" },
      select: { id: true },
    });
    const referee = await prisma.user.findUniqueOrThrow({
      where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" },
      select: { id: true },
    });
    adminId = admin.id;
    refereeId = referee.id;
    originalPoster = await prisma.tournament.findUniqueOrThrow({
      where: { slug: SLUG },
      select: { posterPath: true, posterAlt: true },
    });
  });

  afterEach(async () => {
    while (uploaded.length) {
      const name = uploaded.pop();
      if (name) await rm(path.join(posterDirectory(), name), { force: true });
    }
    await prisma.tournament.update({ where: { slug: SLUG }, data: originalPoster });
  });

  it("按魔数字节而不是声明类型识别格式", () => {
    expect(detectPosterExtension(PNG)).toBe("png");
    expect(detectPosterExtension(JPEG)).toBe("jpg");
    expect(detectPosterExtension(WEBP)).toBe("webp");
    expect(detectPosterExtension(SCRIPT)).toBeNull();
    expect(detectPosterExtension(new Uint8Array())).toBeNull();
  });

  it("管理员上传后写入随机文件名，并留下审计记录", async () => {
    const before = await prisma.auditLog.count({ where: { action: "TOURNAMENT_POSTER_UPLOADED" } });
    const result = await uploadTournamentPoster(adminId, SLUG, { bytes: PNG, alt: "  模拟赛事海报  " });
    uploaded.push(result.posterPath);

    // 文件名完全由服务端生成，不含任何来自调用方的成分。
    expect(result.posterPath).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(await readdir(posterDirectory())).toContain(result.posterPath);

    const tournament = await prisma.tournament.findUniqueOrThrow({
      where: { slug: SLUG },
      select: { posterPath: true, posterAlt: true },
    });
    expect(tournament.posterPath).toBe(result.posterPath);
    expect(tournament.posterAlt).toBe("模拟赛事海报");
    await expect(prisma.auditLog.count({ where: { action: "TOURNAMENT_POSTER_UPLOADED" } })).resolves.toBe(before + 1);
  });

  it("拒绝伪装成图片的非图片内容", async () => {
    await expect(uploadTournamentPoster(adminId, SLUG, { bytes: SCRIPT })).rejects.toMatchObject({
      status: 415,
      code: "poster_unsupported_type",
    });
    expect(await readdir(posterDirectory())).toEqual([".gitkeep"]);
  });

  it("拒绝空文件和超过上限的文件", async () => {
    await expect(uploadTournamentPoster(adminId, SLUG, { bytes: new Uint8Array() })).rejects.toMatchObject({
      status: 400,
      code: "poster_empty",
    });
    const oversized = new Uint8Array(MAX_POSTER_BYTES + 1);
    oversized.set(PNG);
    await expect(uploadTournamentPoster(adminId, SLUG, { bytes: oversized })).rejects.toMatchObject({
      status: 413,
      code: "poster_too_large",
    });
  });

  it("裁判没有赛事管理角色，不能上传海报", async () => {
    await expect(uploadTournamentPoster(refereeId, SLUG, { bytes: PNG })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(await readdir(posterDirectory())).toEqual([".gitkeep"]);
  });

  it("赛事不存在时不写入任何文件", async () => {
    await expect(uploadTournamentPoster(adminId, "no-such-tournament", { bytes: PNG })).rejects.toMatchObject({
      status: 404,
      code: "tournament_not_found",
    });
    expect(await readdir(posterDirectory())).toEqual([".gitkeep"]);
  });

  it("数据库约束挡住任何绕过服务层写入的非法海报路径", async () => {
    for (const invalid of ["../secret.png", "a.svg", "A.png", "x".repeat(70) + ".png"]) {
      await expect(
        prisma.tournament.update({ where: { slug: SLUG }, data: { posterPath: invalid } }),
      ).rejects.toThrow();
    }
  });
});

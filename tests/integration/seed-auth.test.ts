import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";

const execFileAsync = promisify(execFile);
const originalPassword = process.env.DEMO_REFEREE_PASSWORD!;
const rotatedPassword = "RotatedTestPassword!2026";

async function runSeed(password: string) {
  await execFileAsync("pnpm", ["exec", "tsx", "prisma/seed.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_REFEREE_PASSWORD: password },
    timeout: 30_000,
  });
}

async function refereeCredential() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL } });
  return prisma.account.findUniqueOrThrow({
    where: { providerId_accountId: { providerId: "credential", accountId: user.id } },
  });
}

describe("模拟身份种子口令轮换", () => {
  beforeAll(() => assertTestDatabaseUrl(process.env.DATABASE_URL));

  afterAll(async () => {
    await runSeed(originalPassword);
  });

  it("重跑种子后使用新口令并拒绝旧口令", async () => {
    const before = await prisma.account.count({ where: { providerId: "credential" } });
    await runSeed(rotatedPassword);
    const account = await refereeCredential();
    expect(account.password).toBeTruthy();
    await expect(verifyPassword({ hash: account.password!, password: rotatedPassword })).resolves.toBe(true);
    await expect(verifyPassword({ hash: account.password!, password: originalPassword })).resolves.toBe(false);
    await expect(prisma.account.count({ where: { providerId: "credential" } })).resolves.toBe(before);
  }, 40_000);
});

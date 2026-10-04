import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { auth } from "@/server/auth/auth";
import { assertTestDatabaseUrl } from "@/db/database-safety";

const execFileAsync = promisify(execFile);
const originalPassword = process.env.DEMO_REFEREE_PASSWORD!;
const rotatedPassword = "RotatedTestPassword!2026";

async function runSeed(password: string, extraEnv: Record<string, string> = {}) {
  await execFileAsync("pnpm", ["exec", "tsx", "prisma/seed.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DEMO_REFEREE_PASSWORD: password, ...extraEnv },
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

  // 只统计种子身份：其他并行用例会临时开通队伍负责人账号（provisionedForTournamentId 非空）。
  const credentialScope = { providerId: "credential", user: { provisionedForTournamentId: null } };

  it("重跑种子后使用新口令并拒绝旧口令", async () => {
    const before = await prisma.account.count({ where: credentialScope });
    await runSeed(rotatedPassword);
    const account = await refereeCredential();
    expect(account.password).toBeTruthy();
    await expect(verifyPassword({ hash: account.password!, password: rotatedPassword })).resolves.toBe(true);
    await expect(verifyPassword({ hash: account.password!, password: originalPassword })).resolves.toBe(false);
    await expect(prisma.account.count({ where: credentialScope })).resolves.toBe(before);
  }, 40_000);

  it("可选用户名与模拟领队：用户名登录成功，邮箱登录仍可用", async () => {
    const managerEmail = "seed-team-manager@example.test";
    const managerPassword = "SeedManagerPassword!2026";
    await runSeed(originalPassword, {
      DEMO_REFEREE_USERNAME: "SeedReferee",
      DEMO_TEAM_MANAGER_EMAIL: managerEmail,
      DEMO_TEAM_MANAGER_PASSWORD: managerPassword,
      DEMO_TEAM_MANAGER_USERNAME: "seedlingdui",
    });

    const referee = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL } });
    expect(referee.username).toBe("seedreferee");
    const byUsername = await auth.api.signInUsername({ body: { username: "SeedReferee", password: originalPassword } });
    expect(byUsername?.user.id).toBe(referee.id);
    const byEmail = await auth.api.signInEmail({ body: { email: process.env.DEMO_REFEREE_EMAIL!, password: originalPassword } });
    expect(byEmail.user.id).toBe(referee.id);
    await expect(auth.api.signInUsername({ body: { username: "seedreferee", password: "wrong-password-2026" } })).rejects.toThrow();

    const manager = await prisma.user.findUniqueOrThrow({
      where: { email: managerEmail },
      include: { teamManagerships: { include: { team: true, tournament: true } } },
    });
    expect(manager.mustChangePassword).toBe(false);
    expect(manager.teamManagerships.map((m) => [m.tournament.slug, m.team.code])).toEqual([["sunshine-league-2026", "T01"]]);
    const managerLogin = await auth.api.signInUsername({ body: { username: "seedlingdui", password: managerPassword } });
    expect(managerLogin?.user.id).toBe(manager.id);
  }, 60_000);
});

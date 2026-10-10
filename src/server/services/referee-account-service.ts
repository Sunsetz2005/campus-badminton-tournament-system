import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import { Prisma, type RefereeMode } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { requireManagedTournament } from "@/server/auth/authorization";
import { generateInitialPassword } from "@/server/auth/initial-password";
import { AppError } from "@/server/services/errors";

type Tx = Prisma.TransactionClient;

async function audit(client: Tx, tournamentId: string, actorUserId: string, action: string, targetId: string, metadata?: Prisma.InputJsonValue) {
  await client.auditLog.create({
    data: { tournamentId, actorUserId, action, targetType: "User", targetId, outcome: "SUCCESS", metadata },
  });
}

export const REFEREE_MODE_LABEL: Record<RefereeMode, string> = {
  SHARED_ACCOUNT: "共用裁判账号",
  PER_MATCH: "逐场指派主裁判",
};

export interface RefereeAccountView {
  id: string;
  name: string;
  username: string | null;
  status: string;
  /** 由本赛事开通的专用账号才允许在这里重置口令或停用。 */
  managedHere: boolean;
}

export async function listRefereeAccounts(tournamentId: string): Promise<RefereeAccountView[]> {
  const roles = await prisma.roleAssignment.findMany({
    where: { tournamentId, role: "REFEREE" },
    select: { user: { select: { id: true, name: true, displayUsername: true, username: true, status: true, provisionedForTournamentId: true } } },
    orderBy: { createdAt: "asc" },
  });
  return roles.map(({ user }) => ({
    id: user.id,
    name: user.name,
    username: user.displayUsername ?? user.username,
    status: user.status,
    managedHere: user.provisionedForTournamentId === tournamentId,
  }));
}

const modeSchema = z.object({ refereeMode: z.enum(["SHARED_ACCOUNT", "PER_MATCH"]) });

/** 切换执裁方式。只影响此后的权限判定；已有的逐场指派保留，切回逐场指派时继续生效。 */
export async function updateRefereeMode(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const parsed = modeSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "执裁方式无效。");
  const { refereeMode } = parsed.data;
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.tournament.findUniqueOrThrow({ where: { id: tournament.id }, select: { refereeMode: true } });
    if (current.refereeMode === refereeMode) return;
    await transaction.tournament.update({ where: { id: tournament.id }, data: { refereeMode } });
    await transaction.auditLog.create({
      data: {
        tournamentId: tournament.id,
        actorUserId,
        action: "REFEREE_MODE_CHANGED",
        targetType: "Tournament",
        targetId: tournament.id,
        outcome: "SUCCESS",
        metadata: { from: current.refereeMode, to: refereeMode },
      },
    });
  });
  return { refereeMode };
}

const accountSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.]{3,30}$/, "登录用户名只能由字母、数字、下划线和点组成，长度 3—30"),
  name: z
    .string()
    .transform((value) => value.normalize("NFKC").trim().replace(/\s+/g, " "))
    .refine((value) => [...value].length >= 1 && [...value].length <= 40, "显示名称应为 1—40 个字符"),
  /** 留空则由系统生成；自定义口令便于现场多名裁判在手机上输入。 */
  password: z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined))
    .pipe(z.string().min(8, "口令至少 8 位").max(64, "口令最多 64 位").optional()),
});

/**
 * 开通本赛事的裁判员账号（共用账号模式下全体裁判用同一个账号登录）。
 * 口令只在本次响应返回一次、库里只存哈希；共用账号不要求首次登录改口令，否则第一位登录的裁判会把其他人锁在门外。
 */
export async function createRefereeAccount(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const parsed = accountSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", parsed.error.issues[0]?.message ?? "裁判账号信息无效。");
  const { username, name } = parsed.data;
  const password = parsed.data.password ?? generateInitialPassword();
  const passwordHash = await hashPassword(password);
  // 邮箱是账号表的必填唯一键；裁判账号只用用户名登录，这里放一个不可投递的内部地址。
  const email = `referee-${randomUUID()}@accounts.invalid`;
  try {
    const user = await prisma.$transaction(async (transaction) => {
      const created = await transaction.user.create({
        data: {
          email,
          name,
          username: username.toLowerCase(),
          displayUsername: username,
          emailVerified: true,
          provisionedForTournamentId: tournament.id,
        },
        select: { id: true },
      });
      await transaction.account.create({
        data: { providerId: "credential", accountId: created.id, userId: created.id, password: passwordHash },
      });
      await transaction.roleAssignment.create({ data: { userId: created.id, tournamentId: tournament.id, role: "REFEREE" } });
      // 审计只记用户名，从不记录口令。
      await audit(transaction, tournament.id, actorUserId, "REFEREE_ACCOUNT_CREATED", created.id, { username, customPassword: Boolean(parsed.data.password) });
      return created;
    });
    return { userId: user.id, username, password: parsed.data.password ? null : password };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "username_taken", "该登录用户名已被占用，请换一个。");
    }
    throw error;
  }
}

/** 只允许管理「由本赛事开通、且只在本赛事担任裁判员」的账号，防止借此接管管理员、负责人或其他赛事的账号。 */
async function loadManagedReferee(tournamentId: string, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      systemRole: true,
      displayUsername: true,
      username: true,
      provisionedForTournamentId: true,
      roleAssignments: { select: { tournamentId: true, role: true } },
      _count: { select: { teamManagerships: true } },
    },
  });
  if (!user || !user.roleAssignments.some((item) => item.tournamentId === tournamentId && item.role === "REFEREE")) {
    throw new AppError(404, "referee_not_found", "该账号不是本赛事的裁判员。");
  }
  const onlyRefereeHere = user.roleAssignments.every((item) => item.tournamentId === tournamentId && item.role === "REFEREE");
  if (user.provisionedForTournamentId !== tournamentId || user.systemRole !== "USER" || !onlyRefereeHere || user._count.teamManagerships > 0) {
    throw new AppError(403, "referee_not_managed", "只能管理由本赛事开通、且只担任本赛事裁判员的账号。");
  }
  return { ...user, label: user.displayUsername ?? user.username ?? user.id };
}

const resetSchema = z.object({ password: accountSchema.shape.password });

/** 重置口令：旧口令可能已外泄，该账号的全部登录会话立即失效（已取得的计分控制随租约到期或在下一条命令时失效）。 */
export async function resetRefereePassword(actorUserId: string, slug: string, userId: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const user = await loadManagedReferee(tournament.id, userId);
  if (user.status !== "ACTIVE") throw new AppError(409, "account_disabled", "账号已停用。");
  const parsed = resetSchema.safeParse(rawInput ?? {});
  if (!parsed.success) throw new AppError(400, "invalid_input", parsed.error.issues[0]?.message ?? "口令无效。");
  const password = parsed.data.password ?? generateInitialPassword();
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.account.updateMany({ where: { userId: user.id, providerId: "credential" }, data: { password: passwordHash } });
    if (updated.count !== 1) throw new AppError(409, "credential_missing", "该账号没有口令登录方式。");
    await transaction.session.deleteMany({ where: { userId: user.id } });
    await audit(transaction, tournament.id, actorUserId, "REFEREE_PASSWORD_RESET", user.id, { username: user.label });
  });
  return { username: user.label, password: parsed.data.password ? null : password };
}

/** 停用裁判账号：撤销裁判员角色、停用账号并注销会话；正在进行的计分在下一条命令时被拒绝。 */
export async function disableRefereeAccount(actorUserId: string, slug: string, userId: string) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const user = await loadManagedReferee(tournament.id, userId);
  const now = new Date();
  await prisma.$transaction(async (transaction) => {
    await transaction.roleAssignment.deleteMany({ where: { userId: user.id, tournamentId: tournament.id, role: "REFEREE" } });
    await transaction.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
    await transaction.session.deleteMany({ where: { userId: user.id } });
    await transaction.scoringSession.updateMany({
      where: { userId: user.id, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: now, revokedReason: "REFEREE_ACCOUNT_DISABLED" },
    });
    await audit(transaction, tournament.id, actorUserId, "REFEREE_ACCOUNT_DISABLED", user.id, { username: user.label });
  });
  return { ok: true };
}

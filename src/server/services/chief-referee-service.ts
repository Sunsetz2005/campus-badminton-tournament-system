import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { runTransaction } from "@/server/services/transaction";
import { requireManagedTournament } from "@/server/auth/authorization";
import { generateInitialPassword } from "@/server/auth/initial-password";
import { AppError } from "@/server/services/errors";

type Tx = Prisma.TransactionClient;

async function audit(client: Tx, tournamentId: string, actorUserId: string, action: string, targetId: string, metadata?: Prisma.InputJsonValue) {
  await client.auditLog.create({
    data: { tournamentId, actorUserId, action, targetType: "User", targetId, outcome: "SUCCESS", metadata },
  });
}

export interface ChiefRefereeView {
  id: string;
  name: string;
  username: string | null;
  status: string;
  /** 由本赛事开通、等待首次登录修改初始口令。 */
  mustChangePassword: boolean;
  /** 同时是本赛事管理员：可以授予自己，但复核时仍须另一位裁判长。 */
  isAdmin: boolean;
}

export async function listChiefReferees(tournamentId: string): Promise<ChiefRefereeView[]> {
  const roles = await prisma.roleAssignment.findMany({
    where: { tournamentId, role: "CHIEF_REFEREE" },
    select: {
      user: {
        select: {
          id: true,
          name: true,
          displayUsername: true,
          username: true,
          status: true,
          mustChangePassword: true,
          roleAssignments: { where: { tournamentId, role: "ADMIN" }, select: { id: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return roles.map(({ user }) => ({
    id: user.id,
    name: user.name,
    username: user.displayUsername ?? user.username,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    isAdmin: user.roleAssignments.length > 0,
  }));
}

/** 已有账号用 userId 指定，或用登录用户名 / 邮箱查找。 */
const grantSchema = z.union([
  z.object({ userId: z.string().uuid("账号编号无效") }),
  z.object({ login: z.string().trim().min(1, "请填写登录用户名或邮箱").max(254) }),
]);

async function findGrantee(input: z.infer<typeof grantSchema>) {
  const select = { id: true, name: true, status: true, platformReferee: true, displayUsername: true, username: true, email: true } as const;
  if ("userId" in input) return prisma.user.findUnique({ where: { id: input.userId }, select });
  return prisma.user.findFirst({
    where: { OR: [{ username: input.login.toLowerCase() }, { email: { equals: input.login, mode: "insensitive" } }] },
    select,
  });
}

/**
 * 把已有账号授予本赛事裁判长。幂等：已是裁判长时不重复写入，返回 granted=false。
 * 平台共用裁判账号所有裁判都能登录，授予它裁判长会让「另一位裁判长独立复核」失去意义，一律拒绝。
 */
export async function grantChiefReferee(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const parsed = grantSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", parsed.error.issues[0]?.message ?? "请指定要授予裁判长的账号。");
  const user = await findGrantee(parsed.data);
  if (!user) throw new AppError(404, "user_not_found", "找不到该账号。裁判长必须使用已开通的账号，也可以在下方为本赛事开通新账号。");
  if (user.status !== "ACTIVE") throw new AppError(409, "account_disabled", "该账号已停用，不能授予裁判长。");
  if (user.platformReferee) {
    throw new AppError(409, "platform_referee_not_allowed", "平台共用裁判账号所有裁判都能登录，不能担任裁判长；请为裁判长使用个人账号。");
  }
  const label = user.displayUsername ?? user.username ?? user.email;
  const granted = await runTransaction(async (transaction) => {
    const created = await transaction.roleAssignment.createMany({
      data: [{ userId: user.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" }],
      skipDuplicates: true,
    });
    if (created.count === 0) return false;
    await audit(transaction, tournament.id, actorUserId, "CHIEF_REFEREE_GRANTED", user.id, { account: label });
    return true;
  });
  return { userId: user.id, name: user.name, username: user.displayUsername ?? user.username, granted };
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
});

/**
 * 为本赛事开通一个裁判长个人账号并授予裁判长。
 * 与队伍负责人一致：初始口令由系统生成、只在本次响应返回一次，库里只存哈希，首次登录提示修改。
 */
export async function createChiefRefereeAccount(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const parsed = accountSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", parsed.error.issues[0]?.message ?? "裁判长账号信息无效。");
  const { username, name } = parsed.data;
  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  // 邮箱是账号表的必填唯一键；裁判长账号只用用户名登录，这里放一个不可投递的内部地址。
  const email = `chief-referee-${randomUUID()}@accounts.invalid`;
  try {
    const user = await runTransaction(async (transaction) => {
      const created = await transaction.user.create({
        data: {
          email,
          name,
          username: username.toLowerCase(),
          displayUsername: username,
          emailVerified: true,
          mustChangePassword: true,
          provisionedForTournamentId: tournament.id,
        },
        select: { id: true },
      });
      await transaction.account.create({
        data: { providerId: "credential", accountId: created.id, userId: created.id, password: passwordHash },
      });
      await transaction.roleAssignment.create({ data: { userId: created.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" } });
      // 审计只记用户名，从不记录口令。
      await audit(transaction, tournament.id, actorUserId, "CHIEF_REFEREE_ACCOUNT_CREATED", created.id, { username });
      return created;
    });
    return { userId: user.id, username, name, initialPassword };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "username_taken", "该登录用户名已被占用，请换一个。");
    }
    throw error;
  }
}

/**
 * 撤销本赛事裁判长。同一事务吊销该账号在本赛事以裁判长身份持有的控制会话，
 * 与 assertControllerAuthority 的「角色已被撤销」一致，失去权限的设备不再占住控制权。
 * 账号本身、其他角色和其他赛事不受影响。幂等：本来就不是裁判长时返回 revoked=false。
 */
export async function revokeChiefReferee(actorUserId: string, slug: string, userId: string) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  if (!z.string().uuid().safeParse(userId).success) throw new AppError(404, "user_not_found", "找不到该账号。");
  const now = new Date();
  return runTransaction(async (transaction) => {
    const removed = await transaction.roleAssignment.deleteMany({ where: { userId, tournamentId: tournament.id, role: "CHIEF_REFEREE" } });
    if (removed.count === 0) return { userId, revoked: false, revokedSessionIds: [] as string[] };
    const sessions = await transaction.scoringSession.findMany({
      where: { userId, actingRole: "CHIEF_REFEREE", status: "ACTIVE", match: { stage: { competition: { tournamentId: tournament.id } } } },
      select: { id: true },
    });
    const revokedSessionIds = sessions.map((session) => session.id);
    if (revokedSessionIds.length > 0) {
      await transaction.scoringSession.updateMany({
        where: { id: { in: revokedSessionIds }, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now, revokedReason: "CHIEF_REFEREE_REVOKED" },
      });
    }
    await audit(transaction, tournament.id, actorUserId, "CHIEF_REFEREE_REVOKED", userId, { revokedSessionIds });
    return { userId, revoked: true, revokedSessionIds };
  });
}

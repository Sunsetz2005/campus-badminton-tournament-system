import { z } from "zod";

import { prisma } from "@/db/client";
import { auth } from "@/server/auth/auth";
import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { AppError } from "@/server/services/errors";

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12, "新口令至少 12 位").max(128, "新口令最多 128 位"),
});

/**
 * 修改本人口令。口令校验与哈希交给 Better Auth；成功后注销该账号的其他会话，
 * 并清除「首次登录必须修改」标记。返回需要写回浏览器的 Set-Cookie（当前会话令牌会被轮换）。
 */
export async function changeOwnPassword(requestHeaders: Headers, rawInput: unknown) {
  const user = await requireActiveUser(await getSessionFromHeaders(requestHeaders));
  const parsed = passwordSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", parsed.error.issues[0]?.message ?? "口令格式无效。");
  const { currentPassword, newPassword } = parsed.data;
  if (currentPassword === newPassword) throw new AppError(400, "password_unchanged", "新口令不能与当前口令相同。");

  const response = await auth.api.changePassword({
    body: { currentPassword, newPassword, revokeOtherSessions: true },
    headers: requestHeaders,
    asResponse: true,
  });
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new AppError(400, "invalid_password", "当前口令不正确。");
    }
    throw new AppError(502, "password_change_failed", "暂时无法修改口令，请稍后重试。");
  }
  await prisma.$transaction(async (transaction) => {
    await transaction.user.update({ where: { id: user.id }, data: { mustChangePassword: false } });
    await transaction.auditLog.create({
      data: { actorUserId: user.id, action: "PASSWORD_CHANGED", targetType: "User", targetId: user.id, outcome: "SUCCESS" },
    });
  });
  return { setCookies: response.headers.getSetCookie() };
}

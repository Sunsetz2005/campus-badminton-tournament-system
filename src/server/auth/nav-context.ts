import { prisma } from "@/db/client";
import type { AuthSession } from "@/server/auth/auth";
import { getPageSession } from "@/server/auth/session";

/**
 * 导航可见性上下文。
 *
 * **这不是授权。** 隐藏链接只是不给未登录访客展示无意义的入口；
 * `/management` 的 `forbidden()`、`/officiating` 的登录重定向和全部 `/api/**`
 * 的服务端校验才是真正的门禁，且不依赖本文件的任何返回值。
 */
export interface NavContext {
  canManageTournaments: boolean;
  canOfficiate: boolean;
  signedIn: boolean;
  userName: string | null;
}

export const anonymousNavContext: NavContext = {
  canManageTournaments: false,
  canOfficiate: false,
  signedIn: false,
  userName: null,
};

export async function getNavContext(): Promise<NavContext> {
  let session: AuthSession | null = null;
  try {
    session = await getPageSession();
  } catch {
    // 导航不能因为会话读取失败而让整页失败；按未登录渲染即可。
    return anonymousNavContext;
  }
  if (!session) return anonymousNavContext;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, status: true, systemRole: true },
  });
  if (!user || user.status !== "ACTIVE") return anonymousNavContext;

  const roles = await prisma.roleAssignment.findMany({
    where: { userId: session.user.id },
    select: { role: true },
  });
  const roleSet = new Set(roles.map((assignment) => assignment.role));

  return {
    canManageTournaments: roleSet.has("ADMIN") || roleSet.has("ORGANIZER") || user.systemRole === "SYSTEM_ADMIN",
    canOfficiate: roleSet.has("REFEREE") || roleSet.has("CHIEF_REFEREE"),
    signedIn: true,
    userName: user.name,
  };
}

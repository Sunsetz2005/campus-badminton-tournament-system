import { forbidden, notFound, redirect } from "next/navigation";

import type { TournamentRole } from "@/generated/prisma/enums";
import type { AuthSession } from "@/server/auth/auth";
import { requireActiveUser, requireManagedTournament, TOURNAMENT_MANAGER_ROLES } from "@/server/auth/authorization";
import { getPageSession } from "@/server/auth/session";
import { AppError } from "@/server/services/errors";

export async function requireActivePageUser(session: AuthSession) {
  try {
    return await requireActiveUser(session);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) forbidden();
    throw error;
  }
}

/**
 * 管理端页面的赛事范围校验。页面层把 AppError 转成 Next 的 notFound()/forbidden()，
 * 因为 AppError 在 Server Component 中抛出只会变成 500。
 */
export async function requireManagedTournamentPage(
  slug: string,
  allowedRoles: TournamentRole[] = TOURNAMENT_MANAGER_ROLES,
) {
  const session = await getPageSession();
  if (!session) redirect(`/login?next=/management/${encodeURIComponent(slug)}`);
  const user = await requireActivePageUser(session);
  try {
    const access = await requireManagedTournament(user.id, slug, allowedRoles);
    return { user, ...access };
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    if (error instanceof AppError && error.status === 403) forbidden();
    throw error;
  }
}

import type { TournamentRole } from "@/generated/prisma/enums";
import { prisma } from "@/db/client";
import type { AuthSession } from "@/server/auth/auth";
import { AppError } from "@/server/services/errors";

export async function requireActiveUser(session: AuthSession | null) {
  if (!session) throw new AppError(401, "unauthenticated", "请先登录后再操作。");
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, status: true },
  });
  if (!user || user.status !== "ACTIVE") {
    throw new AppError(403, "account_disabled", "账号不存在或已停用。");
  }
  return user;
}

export async function requireTournamentRole(
  userId: string,
  tournamentId: string,
  allowedRoles: TournamentRole[],
) {
  const assignment = await prisma.roleAssignment.findFirst({
    where: { userId, tournamentId, role: { in: allowedRoles } },
    select: { id: true, role: true },
  });
  if (!assignment) throw new AppError(403, "forbidden", "你没有该赛事范围内的权限。");
  return assignment;
}

export async function requireAssignedReferee(userId: string, matchCode: string) {
  const match = await prisma.match.findUnique({
    where: { code: matchCode },
    select: {
      id: true,
      code: true,
      version: true,
      controlGeneration: true,
      lifecycleStatus: true,
      stage: { select: { competition: { select: { tournamentId: true } } } },
      officialAssignments: {
        where: { userId, active: true, role: "MAIN_REFEREE" },
        select: { id: true },
      },
    },
  });
  if (!match) throw new AppError(404, "match_not_found", "比赛不存在。");

  const tournamentId = match.stage.competition.tournamentId;
  await requireTournamentRole(userId, tournamentId, ["REFEREE"]);
  if (match.officialAssignments.length === 0) {
    throw new AppError(403, "not_assigned", "你没有被指派执裁这场比赛。");
  }
  return { ...match, tournamentId };
}

export async function getMatchAccess(userId: string, matchCode: string) {
  const match = await prisma.match.findUnique({
    where: { code: matchCode },
    select: {
      id: true,
      code: true,
      version: true,
      controlGeneration: true,
      lifecycleStatus: true,
      stage: { select: { competition: { select: { tournamentId: true } } } },
      officialAssignments: {
        where: { userId, active: true, role: "MAIN_REFEREE" },
        select: { id: true },
      },
    },
  });
  if (!match) throw new AppError(404, "match_not_found", "比赛不存在。");
  const tournamentId = match.stage.competition.tournamentId;
  const roles = await prisma.roleAssignment.findMany({
    where: { userId, tournamentId, role: { in: ["REFEREE", "CHIEF_REFEREE"] } },
    select: { role: true },
  });
  const roleSet = new Set(roles.map((item) => item.role));
  const assignedReferee = roleSet.has("REFEREE") && match.officialAssignments.length > 0;
  const chiefReferee = roleSet.has("CHIEF_REFEREE");
  if (!assignedReferee && !chiefReferee) {
    throw new AppError(403, "forbidden", "你没有读取该比赛执裁状态的权限。");
  }
  return { ...match, tournamentId, assignedReferee, chiefReferee };
}

export async function requireChiefReferee(userId: string, matchCode: string) {
  const access = await getMatchAccess(userId, matchCode);
  if (!access.chiefReferee) {
    throw new AppError(403, "chief_referee_required", "该操作必须使用裁判长权限。");
  }
  return access;
}

/** 平台级角色只允许「新建赛事」，不授予任何既有赛事的访问权。 */
export async function requireSystemAdmin(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { systemRole: true, status: true } });
  if (!user || user.status !== "ACTIVE" || user.systemRole !== "SYSTEM_ADMIN") {
    throw new AppError(403, "system_admin_required", "只有平台管理员可以新建赛事。");
  }
}

export const TOURNAMENT_MANAGER_ROLES: TournamentRole[] = ["ADMIN", "ORGANIZER"];

/**
 * 按 slug 取得赛事并校验赛事范围角色。
 * 报名审核、导入和邀请链接允许 ADMIN/ORGANIZER；赛事设置、阶段推进和发布只允许 ADMIN。
 */
export async function requireManagedTournament(
  userId: string,
  slug: string,
  allowedRoles: TournamentRole[] = TOURNAMENT_MANAGER_ROLES,
) {
  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, phase: true, status: true, timezone: true },
  });
  if (!tournament) throw new AppError(404, "tournament_not_found", "赛事不存在。");
  const assignment = await requireTournamentRole(userId, tournament.id, allowedRoles);
  return { tournament, role: assignment.role };
}

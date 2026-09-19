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

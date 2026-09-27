import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import { Prisma, type TournamentPhase } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { normalizeReason } from "@/domain/registration/registration-rules";
import {
  formatTeamCode,
  teamNameKey,
  validateTeamName,
  validateTeamRoster,
  type TeamFormat,
  type RubberKind,
} from "@/domain/registration/team-roster";
import {
  requireManagedTournament,
  requirePasswordSettled,
  requireTeamManagerAccess,
} from "@/server/auth/authorization";
import { generateInitialPassword } from "@/server/auth/initial-password";
import { AppError } from "@/server/services/errors";
import {
  assertStudentIdsFree,
  insertRegistration,
  lockedCompetitionIds,
  lockTournamentRow,
  mapRegistrationWriteError,
  parseNote,
  REGISTRATION_EDITABLE_PHASES,
} from "@/server/services/registration-service";

type Tx = Prisma.TransactionClient;

async function audit(
  client: Tx,
  tournamentId: string,
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata?: Prisma.InputJsonValue,
) {
  await client.auditLog.create({
    data: { tournamentId, actorUserId, action, targetType, targetId, outcome: "SUCCESS", metadata },
  });
}

// ---------------------------------------------------------------------------
// 队伍（学院）
// ---------------------------------------------------------------------------

/** 新建队伍。管理员与编排员可操作；已开赛后不再新增队伍。 */
export async function createTeam(actorUserId: string, slug: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug);
  if (!REGISTRATION_EDITABLE_PHASES.includes(tournament.phase)) {
    throw new AppError(409, "tournament_locked", "赛事已开赛或结束，不能再新增队伍。");
  }
  const { name, error } = validateTeamName((rawInput as { name?: unknown } | null)?.name);
  if (!name) throw new AppError(400, "invalid_input", `${error}。`);

  try {
    return await prisma.$transaction(async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const existing = await transaction.team.findMany({ where: { tournamentId: tournament.id }, select: { code: true, name: true } });
      const key = teamNameKey(name);
      const clash = existing.find((team) => teamNameKey(team.name) === key);
      if (clash) throw new AppError(409, "team_name_taken", `本赛事已有队伍「${clash.name}」。`);
      const taken = new Set(existing.map((team) => team.code));
      let sequence = existing.length + 1;
      while (taken.has(formatTeamCode(sequence))) sequence += 1;
      const team = await transaction.team.create({
        data: { tournamentId: tournament.id, code: formatTeamCode(sequence), name },
        select: { id: true, code: true, name: true },
      });
      await audit(transaction, tournament.id, actorUserId, "TEAM_CREATED", "Team", team.id, { code: team.code, name });
      return team;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "team_name_taken", "本赛事已有同名队伍。");
    }
    throw error;
  }
}

async function loadTeam(tournamentId: string, teamId: string) {
  const team = await prisma.team.findFirst({ where: { id: teamId, tournamentId }, select: { id: true, code: true, name: true } });
  if (!team) throw new AppError(404, "team_not_found", "队伍不存在。");
  return team;
}

// ---------------------------------------------------------------------------
// 负责人账号（只有赛事管理员可以开通、重置与移除）
// ---------------------------------------------------------------------------

const managerSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email("邮箱格式无效")),
  name: z
    .string()
    .transform((value) => value.normalize("NFKC").trim().replace(/\s+/g, " "))
    .refine((value) => [...value].length >= 1 && [...value].length <= 40, "姓名应为 1—40 个字符"),
});

/**
 * 为队伍开通负责人账号。
 * - 邮箱尚无账号：新建账号并生成一次性初始口令（只在本次响应返回），首次登录必须修改；
 * - 邮箱已有账号：只绑定为本队负责人，不改动其口令，也不返回任何口令。
 * 公众注册始终关闭；账号只能由赛事管理员在这里开通。
 */
export async function provisionTeamManager(actorUserId: string, slug: string, teamId: string, rawInput: unknown) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const team = await loadTeam(tournament.id, teamId);
  const parsed = managerSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", parsed.error.issues[0]?.message ?? "负责人信息无效。");
  const { email, name } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, status: true } });
  if (existing?.status === "DISABLED") {
    throw new AppError(409, "account_disabled", "该邮箱对应的账号已停用，请换一个邮箱或联系平台管理员。");
  }
  const initialPassword = existing ? null : generateInitialPassword();
  const passwordHash = initialPassword ? await hashPassword(initialPassword) : null;

  try {
    const result = await prisma.$transaction(async (transaction) => {
      let userId = existing?.id ?? null;
      if (!userId) {
        const user = await transaction.user.create({
          data: {
            email,
            name,
            emailVerified: true,
            mustChangePassword: true,
            provisionedForTournamentId: tournament.id,
          },
          select: { id: true },
        });
        await transaction.account.create({
          data: { providerId: "credential", accountId: user.id, userId: user.id, password: passwordHash },
        });
        userId = user.id;
      }
      const binding = await transaction.teamManager.create({
        data: { teamId: team.id, tournamentId: tournament.id, userId, createdByUserId: actorUserId },
        select: { id: true },
      });
      // 审计只记邮箱与是否新建，从不记录口令。
      await audit(transaction, tournament.id, actorUserId, "TEAM_MANAGER_ADDED", "TeamManager", binding.id, {
        teamCode: team.code,
        email,
        accountCreated: !existing,
      });
      return { userId };
    });
    return { userId: result.userId, email, accountCreated: !existing, initialPassword };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "already_manager", "该账号已是本队负责人，或邮箱刚被占用，请刷新后重试。");
    }
    throw error;
  }
}

/**
 * 只有「由本赛事开通、且在任何赛事都没有管理/执裁角色、也不是平台管理员」的负责人账号才允许由本赛事管理员重置口令，
 * 防止借重置口令接管他人的管理员或裁判账号。
 */
async function assertResettableManager(tournamentId: string, teamId: string, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      status: true,
      systemRole: true,
      provisionedForTournamentId: true,
      _count: { select: { roleAssignments: true } },
      teamManagerships: { select: { teamId: true } },
    },
  });
  if (!user || !user.teamManagerships.some((item) => item.teamId === teamId)) {
    throw new AppError(404, "manager_not_found", "该账号不是本队负责人。");
  }
  if (user.provisionedForTournamentId !== tournamentId || user.systemRole !== "USER" || user._count.roleAssignments > 0) {
    throw new AppError(403, "manager_not_resettable", "只能重置由本赛事开通、且没有其他赛事角色的负责人账号。");
  }
  return user;
}

export async function resetTeamManagerPassword(actorUserId: string, slug: string, teamId: string, userId: string) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const team = await loadTeam(tournament.id, teamId);
  const user = await assertResettableManager(tournament.id, team.id, userId);
  if (user.status !== "ACTIVE") throw new AppError(409, "account_disabled", "账号已停用。");
  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.account.updateMany({
      where: { userId: user.id, providerId: "credential" },
      data: { password: passwordHash },
    });
    if (updated.count !== 1) throw new AppError(409, "credential_missing", "该账号没有口令登录方式。");
    await transaction.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });
    // 旧口令可能已外泄：让该账号的全部会话立即失效。
    await transaction.session.deleteMany({ where: { userId: user.id } });
    await audit(transaction, tournament.id, actorUserId, "TEAM_MANAGER_PASSWORD_RESET", "User", user.id, {
      teamCode: team.code,
      email: user.email,
    });
  });
  return { email: user.email, initialPassword };
}

/**
 * 解除负责人绑定。若该账号是本赛事开通的专用负责人账号且再无任何绑定或角色，则同时停用并注销会话。
 */
export async function removeTeamManager(actorUserId: string, slug: string, teamId: string, userId: string) {
  const { tournament } = await requireManagedTournament(actorUserId, slug, ["ADMIN"]);
  const team = await loadTeam(tournament.id, teamId);
  return prisma.$transaction(async (transaction) => {
    const binding = await transaction.teamManager.findUnique({
      where: { teamId_userId: { teamId: team.id, userId } },
      select: { id: true, user: { select: { email: true, systemRole: true, provisionedForTournamentId: true } } },
    });
    if (!binding) throw new AppError(404, "manager_not_found", "该账号不是本队负责人。");
    await transaction.teamManager.delete({ where: { id: binding.id } });
    const [remainingBindings, roles] = await Promise.all([
      transaction.teamManager.count({ where: { userId } }),
      transaction.roleAssignment.count({ where: { userId } }),
    ]);
    const disable =
      binding.user.provisionedForTournamentId === tournament.id &&
      binding.user.systemRole === "USER" &&
      remainingBindings === 0 &&
      roles === 0;
    if (disable) {
      await transaction.user.update({ where: { id: userId }, data: { status: "DISABLED" } });
      await transaction.session.deleteMany({ where: { userId } });
    }
    await audit(transaction, tournament.id, actorUserId, "TEAM_MANAGER_REMOVED", "TeamManager", binding.id, {
      teamCode: team.code,
      email: binding.user.email,
      accountDisabled: disable,
    });
    return { accountDisabled: disable };
  });
}

// ---------------------------------------------------------------------------
// 团体名单（负责人提交；管理员可代录）
// ---------------------------------------------------------------------------

export function teamFormatOf(competition: {
  teamRubbers: string[];
  teamRosterMin: number | null;
  teamRosterMax: number | null;
  teamMinMale: number | null;
  teamMinFemale: number | null;
}): TeamFormat {
  if (
    competition.teamRosterMin === null ||
    competition.teamRosterMax === null ||
    competition.teamMinMale === null ||
    competition.teamMinFemale === null
  ) {
    throw new AppError(409, "team_format_missing", "团体项目缺少名单设置。");
  }
  return {
    rubbers: competition.teamRubbers as RubberKind[],
    rosterMin: competition.teamRosterMin,
    rosterMax: competition.teamRosterMax,
    minMale: competition.teamMinMale,
    minFemale: competition.teamMinFemale,
  };
}

const rosterSchema = z.object({
  competitionId: z.string().uuid(),
  members: z.array(z.record(z.string(), z.unknown())).max(40),
  note: z.string().nullish(),
  /** 修改仍待审核的名单时必须带上当前版本，避免覆盖他人的改动。 */
  expectedVersion: z.number().int().nonnegative().nullish(),
});

/** 负责人只能在「报名中」且处于报名时间窗内提交；管理员代录与后台录入一样，开赛前都可以。 */
function assertRosterWindow(
  mode: "TEAM_MANAGER" | "ADMIN",
  tournament: { phase: TournamentPhase; registrationOpensAt: Date | null; registrationClosesAt: Date | null },
  now: Date,
) {
  if (mode === "ADMIN") {
    if (!REGISTRATION_EDITABLE_PHASES.includes(tournament.phase)) {
      throw new AppError(409, "tournament_locked", "赛事已开赛或结束，不能再变更报名。");
    }
    return;
  }
  const open =
    tournament.phase === "REGISTRATION_OPEN" &&
    (!tournament.registrationOpensAt || now >= tournament.registrationOpensAt) &&
    (!tournament.registrationClosesAt || now < tournament.registrationClosesAt);
  if (!open) throw new AppError(409, "registration_closed", "当前不在报名时间内，名单不能提交或修改。");
}

interface RosterActor {
  userId: string;
  mode: "TEAM_MANAGER" | "ADMIN";
}

/**
 * 提交或修改一支队伍在某团体项目的名单。
 * - 没有进行中的名单：新建一份「待审核」报名；
 * - 已有待审核名单：整份替换成员并提升版本（需 expectedVersion）；
 * - 已审核通过：拒绝，由管理员撤回后重新提交（避免悄悄改动已确认的名单）。
 */
export async function submitTeamRoster(actor: RosterActor, slug: string, teamId: string, rawInput: unknown, now = new Date()) {
  let tournament: { id: string; phase: TournamentPhase; registrationOpensAt: Date | null; registrationClosesAt: Date | null };
  if (actor.mode === "TEAM_MANAGER") {
    const access = await requireTeamManagerAccess(actor.userId, slug);
    if (!access.teams.some((team) => team.id === teamId)) {
      throw new AppError(403, "not_team_manager", "你不是该队伍的负责人。");
    }
    await requirePasswordSettled(actor.userId);
    tournament = access.tournament;
  } else {
    const access = await requireManagedTournament(actor.userId, slug);
    const detail = await prisma.tournament.findUniqueOrThrow({
      where: { id: access.tournament.id },
      select: { id: true, phase: true, registrationOpensAt: true, registrationClosesAt: true },
    });
    tournament = detail;
  }
  const team = await loadTeam(tournament.id, teamId);
  assertRosterWindow(actor.mode, tournament, now);

  const parsed = rosterSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "名单格式无效。");
  const competition = await prisma.competition.findFirst({
    where: { id: parsed.data.competitionId, tournamentId: tournament.id },
    select: {
      id: true,
      code: true,
      entryType: true,
      teamRubbers: true,
      teamRosterMin: true,
      teamRosterMax: true,
      teamMinMale: true,
      teamMinFemale: true,
    },
  });
  if (!competition) throw new AppError(404, "competition_not_found", "项目不属于本赛事。");
  if (competition.entryType !== "TEAM") throw new AppError(400, "not_team_competition", "该项目不是团体赛。");
  const { members, errors } = validateTeamRoster(teamFormatOf(competition), parsed.data.members);
  if (!members) throw new AppError(400, "invalid_members", errors.join("；"), { errors });
  const note = parseNote(parsed.data.note);

  try {
    return await prisma.$transaction(async (transaction) => {
      await lockTournamentRow(transaction, tournament.id);
      const current = await transaction.tournament.findUniqueOrThrow({
        where: { id: tournament.id },
        select: { phase: true, registrationOpensAt: true, registrationClosesAt: true },
      });
      assertRosterWindow(actor.mode, current, now);
      const locked = await lockedCompetitionIds(transaction, current.phase, [competition.id]);
      if (locked.has(competition.id)) {
        throw new AppError(409, "competition_locked", "该项目已完成抽签或已开赛，名单不能再变更。");
      }
      const active = await transaction.registration.findFirst({
        where: { competitionId: competition.id, teamId: team.id, status: { in: ["PENDING", "APPROVED"] } },
        select: { id: true, status: true, version: true, referenceCode: true },
      });
      if (active?.status === "APPROVED") {
        throw new AppError(
          409,
          "roster_approved",
          actor.mode === "ADMIN"
            ? `「${team.name}」的名单已审核通过（${active.referenceCode}），如需修改请先撤回该报名。`
            : "名单已审核通过，不能直接修改；如需调整请联系赛事管理员。",
        );
      }
      const studentIds = members.map((member) => member.studentId);

      if (active) {
        if (parsed.data.expectedVersion === null || parsed.data.expectedVersion === undefined) {
          throw new AppError(409, "version_required", "名单已有待审核版本，请刷新后在原名单上修改。");
        }
        if (parsed.data.expectedVersion !== active.version) {
          throw new AppError(409, "version_conflict", "名单已被修改，请刷新后重试。");
        }
        await assertStudentIdsFree(transaction, competition.id, studentIds, active.id);
        await transaction.registrationMember.deleteMany({ where: { registrationId: active.id } });
        await transaction.registrationMember.createMany({
          data: members.map((member, index) => ({
            registrationId: active.id,
            slot: index + 1,
            displayName: member.displayName,
            studentId: member.studentId,
            contact: member.contact,
            gender: member.gender,
            rubberKinds: member.rubberKinds,
          })),
        });
        const updated = await transaction.registration.updateMany({
          where: { id: active.id, version: active.version, status: "PENDING" },
          data: { version: active.version + 1, note, submittedByUserId: actor.userId },
        });
        if (updated.count !== 1) throw new AppError(409, "version_conflict", "名单已被修改，请刷新后重试。");
        await audit(transaction, tournament.id, actor.userId, "TEAM_ROSTER_UPDATED", "Registration", active.id, {
          teamCode: team.code,
          competitionCode: competition.code,
          referenceCode: active.referenceCode,
          memberCount: members.length,
          via: actor.mode,
        });
        return { registrationId: active.id, referenceCode: active.referenceCode, version: active.version + 1, created: false };
      }

      const registration = await insertRegistration(transaction, {
        tournamentId: tournament.id,
        competition: { id: competition.id, entryType: "TEAM" },
        members: members.map((member) => ({ ...member, teamName: null })),
        teamId: team.id,
        source: actor.mode === "ADMIN" ? "MANUAL" : "TEAM_MANAGER",
        note,
        submittedByUserId: actor.userId,
      });
      await audit(transaction, tournament.id, actor.userId, "TEAM_ROSTER_SUBMITTED", "Registration", registration.id, {
        teamCode: team.code,
        competitionCode: competition.code,
        referenceCode: registration.referenceCode,
        memberCount: members.length,
        via: actor.mode,
      });
      return { registrationId: registration.id, referenceCode: registration.referenceCode, version: 0, created: true };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError(409, "duplicate_registration", "该队伍在本项目已有进行中的名单，请刷新后重试。");
    }
    return mapRegistrationWriteError(error);
  }
}

const withdrawSchema = z.object({ expectedVersion: z.number().int().nonnegative(), reason: z.string().nullish() });

/** 负责人撤回本队仍待审核的名单。已通过的名单只能由管理员撤回。 */
export async function withdrawTeamRoster(userId: string, slug: string, registrationId: string, rawInput: unknown) {
  const access = await requireTeamManagerAccess(userId, slug);
  await requirePasswordSettled(userId);
  const parsed = withdrawSchema.safeParse(rawInput);
  if (!parsed.success) throw new AppError(400, "invalid_input", "撤回请求格式无效。");
  const reason = parsed.data.reason ? normalizeReason(parsed.data.reason) : null;
  const teamIds = access.teams.map((team) => team.id);
  return prisma.$transaction(async (transaction) => {
    await lockTournamentRow(transaction, access.tournament.id);
    const registration = await transaction.registration.findFirst({
      where: { id: registrationId, tournamentId: access.tournament.id, teamId: { in: teamIds } },
      select: { id: true, status: true, version: true, referenceCode: true },
    });
    if (!registration) throw new AppError(404, "registration_not_found", "名单不存在。");
    if (registration.status !== "PENDING") throw new AppError(409, "invalid_status", "只能撤回待审核的名单；已通过的名单请联系赛事管理员。");
    const updated = await transaction.registration.updateMany({
      where: { id: registration.id, version: parsed.data.expectedVersion, status: "PENDING" },
      data: {
        status: "WITHDRAWN",
        version: registration.version + 1,
        reviewReason: reason ?? "队伍负责人撤回",
        reviewedByUserId: userId,
        reviewedAt: new Date(),
      },
    });
    if (updated.count !== 1) throw new AppError(409, "version_conflict", "名单已被修改，请刷新后重试。");
    await audit(transaction, access.tournament.id, userId, "TEAM_ROSTER_WITHDRAWN", "Registration", registration.id, {
      referenceCode: registration.referenceCode,
    });
    return { status: "WITHDRAWN" as const };
  });
}

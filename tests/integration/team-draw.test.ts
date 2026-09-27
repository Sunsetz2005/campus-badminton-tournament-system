import { randomBytes } from "node:crypto";

import { verifyPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import { replayDraw, type DrawAdjustment, type DrawEntryInput, type DrawResult, type DrawSettings } from "@/domain/draw/draw-engine";
import type { RubberKind } from "@/domain/registration/team-roster";
import { stableStringify } from "@/domain/rules/match-engine";
import { adjustDrawDraft, generateDrawDraft, publishDraw, revokePublishedDraw } from "@/server/services/draw-service";
import { getAuthoritativeMatchState } from "@/server/services/match-state-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { acquireScoringSession } from "@/server/services/scoring-session-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import {
  createTeam,
  provisionTeamManager,
  removeTeamManager,
  resetTeamManagerPassword,
  submitTeamRoster,
  withdrawTeamRoster,
} from "@/server/services/team-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

const RUN = randomBytes(3).toString("hex");
const createdSlugs: string[] = [];
const createdEmails: string[] = [];
let adminId = "";
let refereeId = "";
let studentSeq = 0;

function slugFor(name: string) {
  const slug = `t4b-${RUN}-${name}`;
  createdSlugs.push(slug);
  return slug;
}

function emailFor(name: string) {
  const email = `mgr-${RUN}-${name}@example.invalid`;
  createdEmails.push(email);
  return email;
}

function nextStudentId() {
  studentSeq += 1;
  return `B${RUN.toUpperCase()}${String(studentSeq).padStart(4, "0")}`;
}

/** 生成一份合规团体名单：默认 3 男 3 女，按性别报全部可报小场（4-D 起报项必填）。 */
function roster(male = 3, female = 3) {
  return [
    ...Array.from({ length: male }, (_, index) => ({
      displayName: `男队员${studentSeq}-${index}`,
      studentId: nextStudentId(),
      gender: "MALE",
      rubberKinds: ["MS", "MD", "XD"] as RubberKind[],
    })),
    ...Array.from({ length: female }, (_, index) => ({
      displayName: `女队员${studentSeq}-${index}`,
      studentId: nextStudentId(),
      gender: "FEMALE",
      rubberKinds: ["WS", "WD", "XD"] as RubberKind[],
    })),
  ];
}

async function newTournament(name: string) {
  const slug = slugFor(name);
  await createTournament(adminId, {
    slug,
    name: `阳光联赛测试 ${name}`,
    startDate: "2026-11-01",
    endDate: "2026-11-03",
    timezone: "Asia/Shanghai",
    namePolicy: "CODES_ONLY",
    rulePreset: "traditional-21",
    competitions: [
      { kind: "TEAM", code: "TEAM", name: "学院团体赛" },
      { kind: "MS", code: "MS", name: "男子单打" },
    ],
  });
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const competitions = await prisma.competition.findMany({ where: { tournamentId: tournament.id }, select: { id: true, code: true } });
  const byCode = Object.fromEntries(competitions.map((item) => [item.code, item.id]));
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
  return { slug, tournamentId: tournament.id, team: byCode.TEAM as string, ms: byCode.MS as string };
}

async function approveRegistration(slug: string, registrationId: string) {
  const current = await prisma.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { version: true } });
  return reviewRegistration(adminId, slug, registrationId, { action: "APPROVE", expectedVersion: current.version });
}

/** 建 n 支队伍并由管理员代录名单、审核通过，返回队伍 ID。 */
async function approvedTeams(slug: string, competitionId: string, count: number, prefix = "学院") {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const team = await createTeam(adminId, slug, { name: `${prefix}${index + 1}` });
    const submitted = await submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, team.id, { competitionId, members: roster() });
    await approveRegistration(slug, submitted.registrationId);
    ids.push(team.id);
  }
  return ids;
}

async function currentDraft(competitionId: string) {
  return prisma.draw.findFirstOrThrow({ where: { competitionId, status: "DRAFT" } });
}

async function closeRegistration(slug: string) {
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
});

afterAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  // 先删本轮开通的负责人账号，再删赛事（赛事删除会把 provisionedForTournamentId 置空）。
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  for (const slug of createdSlugs) {
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) continue;
    const matchWhere = { stage: { competition: { tournamentId: tournament.id } } };
    await prisma.matchEvent.deleteMany({ where: { match: matchWhere } });
    await prisma.resultRevision.deleteMany({ where: { match: matchWhere } });
    await prisma.match.deleteMany({ where: matchWhere });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  }
});

describe("团体项目与队伍", () => {
  it("建赛可创建团体项目，默认五个小场与名单人数；非团体项目不带团体设置", async () => {
    const { team, ms } = await newTournament("format");
    const teamCompetition = await prisma.competition.findUniqueOrThrow({ where: { id: team } });
    expect(teamCompetition).toMatchObject({
      kind: "TEAM",
      entryType: "TEAM",
      teamRubbers: ["MS", "WS", "MD", "WD", "XD"],
      teamRosterMin: 4,
      teamRosterMax: 12,
      teamMinMale: 2,
      teamMinFemale: 2,
    });
    const individual = await prisma.competition.findUniqueOrThrow({ where: { id: ms } });
    expect(individual.teamRubbers).toEqual([]);
    expect(individual.teamRosterMin).toBeNull();
    // 数据库兜底：个人项目不能带团体设置。
    await expect(prisma.competition.update({ where: { id: ms }, data: { teamRubbers: ["MS"] } })).rejects.toThrow();
  });

  it("队伍名称按全半角/空白规范化去重；裁判不能建队", async () => {
    const { slug } = await newTournament("teams");
    const first = await createTeam(adminId, slug, { name: "数学 学院" });
    expect(first.code).toBe("T01");
    await expect(createTeam(adminId, slug, { name: "数学学院" })).rejects.toMatchObject({ code: "team_name_taken" });
    await expect(createTeam(adminId, slug, { name: "=HYPERLINK()" })).rejects.toMatchObject({ status: 400 });
    await expect(createTeam(refereeId, slug, { name: "物理学院" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("队伍负责人账号", () => {
  it("新邮箱开通账号：一次性初始口令只返回一次，库内只存哈希，首次登录必须修改；审计不含口令", async () => {
    const { slug, tournamentId } = await newTournament("provision");
    const team = await createTeam(adminId, slug, { name: "化学学院" });
    const email = emailFor("new");
    const result = await provisionTeamManager(adminId, slug, team.id, { email: email.toUpperCase(), name: "王老师" });
    expect(result.accountCreated).toBe(true);
    expect(result.initialPassword).toMatch(/^[2-9a-zA-Z]{16}$/);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, mustChangePassword: true, provisionedForTournamentId: true, systemRole: true, accounts: { select: { password: true } } },
    });
    expect(user).toMatchObject({ mustChangePassword: true, provisionedForTournamentId: tournamentId, systemRole: "USER" });
    expect(user.accounts[0].password).not.toContain(result.initialPassword as string);
    await expect(verifyPassword({ hash: user.accounts[0].password as string, password: result.initialPassword as string })).resolves.toBe(true);
    const logs = await prisma.auditLog.findMany({ where: { tournamentId, action: "TEAM_MANAGER_ADDED" } });
    expect(JSON.stringify(logs)).not.toContain(result.initialPassword as string);
    // 负责人不获得任何赛事管理角色。
    await expect(prisma.roleAssignment.count({ where: { userId: user.id } })).resolves.toBe(0);
  });

  it("已有账号只绑定、不返回口令；编排员不能开通账号；不能重置有管理角色的账号", async () => {
    const { slug } = await newTournament("bind");
    const team = await createTeam(adminId, slug, { name: "生物学院" });
    const referee = await prisma.user.findUniqueOrThrow({ where: { id: refereeId }, select: { email: true } });
    const bound = await provisionTeamManager(adminId, slug, team.id, { email: referee.email, name: "裁判员" });
    expect(bound).toMatchObject({ accountCreated: false, initialPassword: null });
    await expect(provisionTeamManager(adminId, slug, team.id, { email: referee.email, name: "裁判员" })).rejects.toMatchObject({ code: "already_manager" });
    await expect(resetTeamManagerPassword(adminId, slug, team.id, refereeId)).rejects.toMatchObject({ code: "manager_not_resettable" });
    // 解除绑定不会停用有其他角色的账号。
    await expect(removeTeamManager(adminId, slug, team.id, refereeId)).resolves.toEqual({ accountDisabled: false });
    const organizer = emailFor("organizer");
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const orgUser = await prisma.user.create({ data: { email: organizer, name: "编排员" } });
    await prisma.roleAssignment.create({ data: { userId: orgUser.id, tournamentId: tournament.id, role: "ORGANIZER" } });
    await expect(provisionTeamManager(orgUser.id, slug, team.id, { email: emailFor("x"), name: "某人" })).rejects.toMatchObject({ status: 403 });
    // 编排员可以建队。
    await expect(createTeam(orgUser.id, slug, { name: "地理学院" })).resolves.toMatchObject({ code: "T02" });
  });

  it("重置口令使旧会话失效；移除本赛事专用账号时停用该账号", async () => {
    const { slug } = await newTournament("reset");
    const team = await createTeam(adminId, slug, { name: "历史学院" });
    const email = emailFor("reset");
    const created = await provisionTeamManager(adminId, slug, team.id, { email, name: "李老师" });
    await prisma.user.update({ where: { id: created.userId }, data: { mustChangePassword: false } });
    await prisma.session.create({
      data: { userId: created.userId, token: `tok-${RUN}-reset`, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const reset = await resetTeamManagerPassword(adminId, slug, team.id, created.userId);
    expect(reset.initialPassword).not.toBe(created.initialPassword);
    await expect(prisma.session.count({ where: { userId: created.userId } })).resolves.toBe(0);
    await expect(prisma.user.findUniqueOrThrow({ where: { id: created.userId } })).resolves.toMatchObject({ mustChangePassword: true });
    await expect(removeTeamManager(adminId, slug, team.id, created.userId)).resolves.toEqual({ accountDisabled: true });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: created.userId } })).resolves.toMatchObject({ status: "DISABLED" });
  });
});

describe("负责人提交团体名单", () => {
  it("只能操作本队；首次登录未改口令不能提交；名单规则逐条报错", async () => {
    const { slug, team: competitionId } = await newTournament("roster-rules");
    const mine = await createTeam(adminId, slug, { name: "外语学院" });
    const other = await createTeam(adminId, slug, { name: "法学院" });
    const manager = await provisionTeamManager(adminId, slug, mine.id, { email: emailFor("rules"), name: "赵老师" });
    const actor = { userId: manager.userId, mode: "TEAM_MANAGER" as const };

    await expect(submitTeamRoster(actor, slug, mine.id, { competitionId, members: roster() })).rejects.toMatchObject({
      code: "password_change_required",
    });
    await prisma.user.update({ where: { id: manager.userId }, data: { mustChangePassword: false } });
    await expect(submitTeamRoster(actor, slug, other.id, { competitionId, members: roster() })).rejects.toMatchObject({
      code: "not_team_manager",
    });
    const otherSlug = (await newTournament("roster-rules-other")).slug;
    await expect(submitTeamRoster(actor, otherSlug, mine.id, { competitionId, members: roster() })).rejects.toMatchObject({
      status: 403,
    });

    const bad = [
      { displayName: "甲", studentId: "S1", gender: "MALE", rubberKinds: ["MS"] },
      { displayName: "乙", studentId: "S1", gender: "MALE", rubberKinds: ["MD"] },
      { displayName: "丙", studentId: "", gender: "FEMALE" },
      { displayName: "丁", studentId: "S4" },
    ];
    const failure = await submitTeamRoster(actor, slug, mine.id, { competitionId, members: bad }).catch((error) => error);
    expect(failure).toMatchObject({ status: 400, code: "invalid_members" });
    const errors = (failure.details as { errors: string[] }).errors;
    expect(errors).toContain("第 3 名队员的学号不能为空（团体赛以学号识别队员）");
    expect(errors).toContain("第 4 名队员的性别必须选择「男」或「女」");
    expect(errors.some((message) => message.includes("学号 S1 在名单中重复"))).toBe(true);
    await expect(
      submitTeamRoster(actor, slug, mine.id, { competitionId, members: roster(4, 1) }),
    ).rejects.toMatchObject({ message: expect.stringContaining("至少需要 2 名女队员") });
  });

  it("提交生成待审核名单；修改须带版本并整份替换；同一学号不能进两支队；负责人可撤回待审核名单", async () => {
    const { slug, team: competitionId } = await newTournament("roster-flow");
    const mine = await createTeam(adminId, slug, { name: "音乐学院" });
    const rival = await createTeam(adminId, slug, { name: "美术学院" });
    const manager = await provisionTeamManager(adminId, slug, mine.id, { email: emailFor("flow"), name: "钱老师" });
    await prisma.user.update({ where: { id: manager.userId }, data: { mustChangePassword: false } });
    const actor = { userId: manager.userId, mode: "TEAM_MANAGER" as const };

    const members = roster();
    const first = await submitTeamRoster(actor, slug, mine.id, { competitionId, members });
    expect(first).toMatchObject({ created: true, version: 0 });
    const stored = await prisma.registration.findUniqueOrThrow({
      where: { id: first.registrationId },
      select: { status: true, source: true, teamId: true, dedupeKey: true, members: { select: { gender: true } } },
    });
    expect(stored).toMatchObject({ status: "PENDING", source: "TEAM_MANAGER", teamId: mine.id, dedupeKey: null });
    expect(stored.members).toHaveLength(6);

    await expect(submitTeamRoster(actor, slug, mine.id, { competitionId, members })).rejects.toMatchObject({ code: "version_required" });
    const bigger = [...members, { displayName: "替补", studentId: nextStudentId(), gender: "MALE", rubberKinds: ["MD"] }];
    const updated = await submitTeamRoster(actor, slug, mine.id, { competitionId, members: bigger, expectedVersion: 0 });
    expect(updated).toMatchObject({ created: false, version: 1, registrationId: first.registrationId });
    await expect(prisma.registrationMember.count({ where: { registrationId: first.registrationId } })).resolves.toBe(7);
    await expect(
      submitTeamRoster(actor, slug, mine.id, { competitionId, members: bigger, expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: "version_conflict" });

    // 美术学院想把音乐学院的队员也写进名单。
    const stolen = [members[0], ...roster(2, 3)];
    await expect(
      submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, rival.id, { competitionId, members: stolen }),
    ).rejects.toMatchObject({ code: "member_already_registered", message: expect.stringContaining("音乐学院") });

    await withdrawTeamRoster(manager.userId, slug, first.registrationId, { expectedVersion: 1 });
    await expect(prisma.registration.findUniqueOrThrow({ where: { id: first.registrationId } })).resolves.toMatchObject({
      status: "WITHDRAWN",
    });
    // 撤回后可以重新提交。
    await expect(submitTeamRoster(actor, slug, mine.id, { competitionId, members: roster() })).resolves.toMatchObject({ created: true });
  });

  it("报名未开放或已截止时负责人不能提交；管理员审核通过后生成团体报名单位，负责人不能再改", async () => {
    const { slug, team: competitionId } = await newTournament("roster-approve");
    const mine = await createTeam(adminId, slug, { name: "体育学院" });
    const manager = await provisionTeamManager(adminId, slug, mine.id, { email: emailFor("approve"), name: "孙老师" });
    await prisma.user.update({ where: { id: manager.userId }, data: { mustChangePassword: false } });
    const actor = { userId: manager.userId, mode: "TEAM_MANAGER" as const };
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { registrationClosesAt: new Date(Date.now() - 60_000) } });
    await expect(submitTeamRoster(actor, slug, mine.id, { competitionId, members: roster() })).rejects.toMatchObject({
      code: "registration_closed",
    });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { registrationClosesAt: null } });

    const members = roster();
    const submitted = await submitTeamRoster(actor, slug, mine.id, { competitionId, members });
    const outcome = await approveRegistration(slug, submitted.registrationId);
    expect(outcome.status).toBe("APPROVED");
    const entry = await prisma.entry.findFirstOrThrow({
      where: { competitionId },
      select: {
        entryType: true,
        teamId: true,
        displayName: true,
        members: { select: { participant: { select: { gender: true, studentId: true } } } },
      },
    });
    expect(entry).toMatchObject({ entryType: "TEAM", teamId: mine.id, displayName: "体育学院" });
    expect(entry.members).toHaveLength(6);
    expect(entry.members.filter((member) => member.participant.gender === "FEMALE")).toHaveLength(3);
    await expect(submitTeamRoster(actor, slug, mine.id, { competitionId, members, expectedVersion: 1 })).rejects.toMatchObject({
      code: "roster_approved",
    });
  });

  it("同一学号的既有人员：未登记性别则补齐，性别不一致则拒绝通过", async () => {
    const { slug, team: competitionId, ms } = await newTournament("gender");
    const studentId = nextStudentId();
    const single = await createManualRegistration(adminId, slug, { competitionId: ms, members: [{ displayName: "周同学", studentId }] });
    await approveRegistration(slug, single.id);
    const team = await createTeam(adminId, slug, { name: "教育学院" });
    const members = [{ displayName: "周同学", studentId, gender: "FEMALE", rubberKinds: ["WD"] }, ...roster(3, 2)];
    const submitted = await submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, team.id, { competitionId, members });
    await approveRegistration(slug, submitted.registrationId);
    await expect(prisma.participant.findFirstOrThrow({ where: { studentId } })).resolves.toMatchObject({ gender: "FEMALE" });

    // 已登记为女、另一份名单却写男 → 拒绝通过。
    const other = await createTeam(adminId, slug, { name: "新闻学院" });
    // 乙组只打男单、女单、混双：报项也只能在这三项里选。
    const conflictMembers = [
      { displayName: "周同学", studentId, gender: "MALE", rubberKinds: ["MS"] },
      ...roster(2, 3).map((member) => ({ ...member, rubberKinds: member.rubberKinds.filter((kind) => ["MS", "WS", "XD"].includes(kind)) })),
    ];
    // 同一项目不能重复报同一人，所以换到个人项目之外的新团体项目验证。
    const extra = await prisma.competition.create({
      data: {
        tournamentId: (await prisma.tournament.findUniqueOrThrow({ where: { slug } })).id,
        code: "TEAM2",
        name: "团体赛乙组",
        kind: "TEAM",
        entryType: "TEAM",
        teamRubbers: ["MS", "WS", "XD"],
        teamRosterMin: 4,
        teamRosterMax: 10,
        teamMinMale: 1,
        teamMinFemale: 1,
      },
    });
    const conflict = await submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, other.id, { competitionId: extra.id, members: conflictMembers });
    await expect(approveRegistration(slug, conflict.registrationId)).rejects.toMatchObject({
      code: "identity_conflict",
      message: expect.stringContaining("性别"),
    });
  });

  it("数据库兜底：团体项目报名必须挂队伍，名单缺性别不能提交", async () => {
    const { slug, tournamentId, team: competitionId } = await newTournament("db-guard");
    await expect(
      prisma.registration.create({
        data: {
          tournamentId,
          competitionId,
          referenceCode: `R-${RUN}-GD`.toUpperCase(),
          source: "MANUAL",
          members: { create: roster().map((member, index) => ({ ...member, gender: member.gender as "MALE" | "FEMALE", slot: index + 1 })) },
        },
      }),
    ).rejects.toThrow();
    const team = await createTeam(adminId, slug, { name: "哲学学院" });
    await expect(
      prisma.registration.create({
        data: {
          tournamentId,
          competitionId,
          teamId: team.id,
          referenceCode: `R-${RUN}-GE`.toUpperCase(),
          source: "MANUAL",
          members: { create: roster().map((member, index) => ({ displayName: member.displayName, studentId: member.studentId, slot: index + 1 })) },
        },
      }),
    ).rejects.toThrow(/without student id or gender/);
  });
});

describe("团体赛抽签编排", () => {
  it("0/1 支队伍不能编排", async () => {
    const { slug } = await newTournament("draw-empty");
    await expect(generateDrawDraft(adminId, slug, "TEAM", { format: "ROUND_ROBIN" })).rejects.toMatchObject({
      code: "draw_invalid",
      message: expect.stringContaining("没有已审核通过的报名单位"),
    });
    const { team } = await prisma.competition.findFirstOrThrow({ where: { tournament: { slug }, code: "TEAM" }, select: { id: true } }).then((row) => ({ team: row.id }));
    await approvedTeams(slug, team, 1);
    await expect(generateDrawDraft(adminId, slug, "TEAM", { format: "ROUND_ROBIN" })).rejects.toMatchObject({
      message: expect.stringContaining("不自动产生冠军"),
    });
  });

  it("8 支队伍：草稿可重复生成与调签，发布后生成小组循环＋淘汰对阵与五个小场占位并冻结", async () => {
    const { slug, tournamentId, team: competitionId } = await newTournament("draw-team");
    await approvedTeams(slug, competitionId, 8);

    const first = await generateDrawDraft(adminId, slug, "TEAM", { format: "GROUPS_KNOCKOUT", thirdPlaceMatch: true });
    const second = await generateDrawDraft(adminId, slug, "TEAM", { format: "GROUPS_KNOCKOUT", thirdPlaceMatch: true });
    expect(second.version).toBe(first.version + 1);
    await expect(prisma.draw.findUniqueOrThrow({ where: { id: first.drawId } })).resolves.toMatchObject({ status: "SUPERSEDED" });

    const draft = await currentDraft(competitionId);
    const result = draft.result as unknown as DrawResult;
    const [groupA, groupB] = result.layout.groups;
    const adjusted = await adjustDrawDraft(adminId, slug, "TEAM", draft.id, {
      type: "SWAP",
      entryA: groupA.entryIds[1],
      entryB: groupB.entryIds[1],
      reason: "组委会要求同城学院分开",
    });
    await expect(
      adjustDrawDraft(adminId, slug, "TEAM", draft.id, { type: "SWAP", entryA: groupA.entryIds[2], entryB: groupB.entryIds[2], reason: "过期" }),
    ).rejects.toMatchObject({ code: "draft_stale" });
    const adjustedDraft = await currentDraft(competitionId);
    expect(adjustedDraft.id).toBe(adjusted.drawId);
    expect(adjustedDraft.adjustments).toHaveLength(1);

    // 可复现：按保存的种子、名单与调签记录重算，结果逐字节一致。
    const replay = replayDraw(
      {
        entries: adjustedDraft.input as unknown as DrawEntryInput[],
        settings: adjustedDraft.settings as unknown as DrawSettings,
        randomSeed: adjustedDraft.randomSeed,
      },
      adjustedDraft.adjustments as unknown as DrawAdjustment[],
    );
    expect(replay.ok && stableStringify(replay.result)).toBe(stableStringify(adjustedDraft.result));

    await expect(publishDraw(adminId, slug, "TEAM", adjusted.drawId, { confirm: true })).rejects.toMatchObject({
      code: "registration_not_closed",
    });
    // 截止前又来一份待审核名单：发布被拒，处理后才能发布。
    const late = await createTeam(adminId, slug, { name: "迟到学院" });
    const lateRoster = await submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, late.id, { competitionId, members: roster() });
    await closeRegistration(slug);
    await expect(publishDraw(adminId, slug, "TEAM", adjusted.drawId, { confirm: true })).rejects.toMatchObject({
      code: "pending_registrations",
    });
    await reviewRegistration(adminId, slug, lateRoster.registrationId, { action: "REJECT", expectedVersion: 0, reason: "超过截止时间" });
    await expect(publishDraw(adminId, slug, "TEAM", adjusted.drawId, {})).rejects.toMatchObject({ code: "confirm_required" });

    const published = await publishDraw(adminId, slug, "TEAM", adjusted.drawId, { confirm: true });
    // 2 组各 4 队：12 场小组对抗 + 2 半决赛 + 决赛 + 三四名赛 = 16 场对抗，每场 5 个小场。
    expect(published).toMatchObject({ stages: 2, groups: 2, fixtures: 16, matches: 80 });
    const fixtures = await prisma.fixture.findMany({ where: { drawId: adjusted.drawId }, include: { matches: { orderBy: { rubberOrder: "asc" } } } });
    expect(fixtures.every((fixture) => fixture.matches.length === 5)).toBe(true);
    expect(fixtures.every((fixture) => fixture.matches.map((match) => match.rubberKind).join() === "MS,WS,MD,WD,XD")).toBe(true);
    const semi = fixtures.find((fixture) => fixture.code === "SF1");
    expect(semi).toMatchObject({ sideASource: "GROUP_RANK", sideARank: 1, sideAEntryId: null, sideBSource: "GROUP_RANK", sideBRank: 2 });
    const bronze = fixtures.find((fixture) => fixture.code === "3P");
    expect(bronze).toMatchObject({ kind: "THIRD_PLACE", sideASource: "FIXTURE_LOSER", sideBSource: "FIXTURE_LOSER" });
    await expect(prisma.entry.count({ where: { competitionId, frozenAt: null } })).resolves.toBe(0);
    await expect(prisma.matchRuleSnapshot.count({ where: { match: { fixture: { drawId: adjusted.drawId } } } })).resolves.toBe(80);
    await expect(prisma.draw.findUniqueOrThrow({ where: { id: adjusted.drawId } })).resolves.toMatchObject({ status: "PUBLISHED" });

    // 团体小场出场名单属于后续阶段：此时不能开始计分。
    const rubber = fixtures.find((fixture) => fixture.kind === "GROUP")?.matches[0];
    await prisma.roleAssignment.create({ data: { userId: refereeId, tournamentId, role: "REFEREE" } });
    await prisma.officialAssignment.create({ data: { matchId: rubber?.id as string, userId: refereeId } });
    await expect(getAuthoritativeMatchState(refereeId, rubber?.code as string)).rejects.toMatchObject({ code: "match_not_ready" });

    // 发布后：报名与名单全部锁定，也不能再生成草稿。
    const blocked = await createTeam(adminId, slug, { name: "补报学院" });
    await expect(
      submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, blocked.id, { competitionId, members: roster() }),
    ).rejects.toMatchObject({ code: "competition_locked" });
    const approved = await prisma.registration.findFirstOrThrow({ where: { competitionId, status: "APPROVED" } });
    await expect(
      reviewRegistration(adminId, slug, approved.id, { action: "WITHDRAW", expectedVersion: approved.version, reason: "测试" }),
    ).rejects.toMatchObject({ code: "competition_locked" });
    await expect(generateDrawDraft(adminId, slug, "TEAM", { format: "ROUND_ROBIN" })).rejects.toMatchObject({ code: "draw_published" });

    // 数据库兜底：对阵来源不能引用更晚的轮次（无环）。
    const final = fixtures.find((fixture) => fixture.code === "F");
    await expect(
      prisma.fixture.update({ where: { id: semi?.id as string }, data: { sideASource: "FIXTURE_WINNER", sideAGroupId: null, sideARank: null, sideAFixtureId: final?.id } }),
    ).rejects.toThrow(/acyclic/);
  });

  it("撤销发布只允许裁判长且必须写原因；任一比赛开始后拒绝；撤销后解冻并可重抽", async () => {
    const { slug, tournamentId, team: competitionId } = await newTournament("draw-revoke");
    await approvedTeams(slug, competitionId, 4);
    const draft = await generateDrawDraft(adminId, slug, "TEAM", { format: "ROUND_ROBIN" });
    await closeRegistration(slug);
    await publishDraw(adminId, slug, "TEAM", draft.drawId, { confirm: true });

    await expect(revokePublishedDraw(adminId, slug, "TEAM", { reason: "漏报一支队伍" })).rejects.toMatchObject({ status: 403 });
    await prisma.roleAssignment.create({ data: { userId: adminId, tournamentId, role: "CHIEF_REFEREE" } });
    await expect(revokePublishedDraw(adminId, slug, "TEAM", { reason: " " })).rejects.toMatchObject({ code: "reason_required" });

    const match = await prisma.match.findFirstOrThrow({ where: { fixture: { drawId: draft.drawId } } });
    await prisma.match.update({ where: { id: match.id }, data: { lifecycleStatus: "IN_PROGRESS" } });
    await expect(revokePublishedDraw(adminId, slug, "TEAM", { reason: "漏报一支队伍" })).rejects.toMatchObject({
      code: "draw_matches_started",
    });
    await prisma.match.update({ where: { id: match.id }, data: { lifecycleStatus: "SCHEDULED" } });

    const revoked = await revokePublishedDraw(adminId, slug, "TEAM", { reason: "漏报一支队伍" });
    expect(revoked.removedMatches).toBe(6 * 5);
    await expect(prisma.fixture.count({ where: { drawId: draft.drawId } })).resolves.toBe(0);
    await expect(prisma.stage.count({ where: { drawId: draft.drawId } })).resolves.toBe(0);
    await expect(prisma.entry.count({ where: { competitionId, frozenAt: { not: null } } })).resolves.toBe(0);
    await expect(prisma.draw.findUniqueOrThrow({ where: { id: draft.drawId } })).resolves.toMatchObject({
      status: "REVOKED",
      revokeReason: "漏报一支队伍",
    });
    await expect(generateDrawDraft(adminId, slug, "TEAM", { format: "ROUND_ROBIN" })).resolves.toMatchObject({ version: 2 });
  });

  it("草稿之后名单变化或草稿结果被篡改：拒绝发布", async () => {
    const { slug, team: competitionId } = await newTournament("draw-guard");
    await approvedTeams(slug, competitionId, 4);
    const draft = await generateDrawDraft(adminId, slug, "TEAM", { format: "ROUND_ROBIN" });
    await approvedTeams(slug, competitionId, 1, "补录");
    await closeRegistration(slug);
    await expect(publishDraw(adminId, slug, "TEAM", draft.drawId, { confirm: true })).rejects.toMatchObject({
      code: "draw_input_changed",
    });
    const again = await generateDrawDraft(adminId, slug, "TEAM", { format: "ROUND_ROBIN" });
    const stored = await prisma.draw.findUniqueOrThrow({ where: { id: again.drawId } });
    const tampered = structuredClone(stored.result) as unknown as DrawResult;
    tampered.fixtures[0] = { ...tampered.fixtures[0], sideA: tampered.fixtures[0].sideB, sideB: tampered.fixtures[0].sideA };
    await prisma.draw.update({ where: { id: again.drawId }, data: { result: tampered as never } });
    await expect(publishDraw(adminId, slug, "TEAM", again.drawId, { confirm: true })).rejects.toMatchObject({
      code: "draw_not_reproducible",
    });
  });
});

describe("个人项目抽签与执裁衔接", () => {
  it("5 人单循环发布后生成 10 场确定对阵；指派裁判后能读取权威状态并记分", async () => {
    const { slug, tournamentId, ms } = await newTournament("draw-singles");
    for (let index = 0; index < 5; index += 1) {
      const created = await createManualRegistration(adminId, slug, {
        competitionId: ms,
        members: [{ displayName: `单打选手${index + 1}`, studentId: nextStudentId(), teamName: index < 2 ? "数学学院" : `学院${index}` }],
      });
      await approveRegistration(slug, created.id);
    }
    const draft = await generateDrawDraft(adminId, slug, "MS", { format: "ROUND_ROBIN" });
    await closeRegistration(slug);
    const published = await publishDraw(adminId, slug, "MS", draft.drawId, { confirm: true });
    expect(published).toMatchObject({ fixtures: 10, matches: 10, groups: 1 });
    const matches = await prisma.match.findMany({ where: { fixture: { drawId: draft.drawId } }, select: { id: true, code: true, sideAEntryId: true, sideBEntryId: true, publishedAt: true } });
    expect(matches.every((match) => match.sideAEntryId && match.sideBEntryId && match.sideAEntryId !== match.sideBEntryId)).toBe(true);
    // 抽签发布不等于对外公开赛程：逐场公开发布边界仍为空。
    expect(matches.every((match) => match.publishedAt === null)).toBe(true);
    const pairs = matches.map((match) => [match.sideAEntryId, match.sideBEntryId].sort().join("|"));
    expect(new Set(pairs).size).toBe(10);

    const target = matches[0];
    await prisma.roleAssignment.create({ data: { userId: refereeId, tournamentId, role: "REFEREE" } });
    await prisma.officialAssignment.create({ data: { matchId: target.id, userId: refereeId } });
    const state = await getAuthoritativeMatchState(refereeId, target.code);
    expect(state).toMatchObject({ status: "snapshot", version: 0, state: { phase: "AWAITING_COIN_TOSS" } });
    const control = await acquireScoringSession(refereeId, target.code, "41111111-1111-4111-8111-111111111111");
    const envelope = {
      commandId: "41000000-0000-4000-8000-000000000001",
      occurredAt: "2026-11-01T02:00:00.000Z",
      expectedVersion: 0,
      scoringSessionId: control.sessionId,
      takeoverGeneration: control.takeoverGeneration,
      type: "RECORD_COIN_TOSS",
      payload: { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } },
    } as ScoringCommandEnvelope;
    await expect(submitScoringCommand(refereeId, target.code, envelope, control.controlToken)).resolves.toMatchObject({
      status: "accepted",
      version: 1,
    });
    // 比赛开始后，裁判长也不能撤销抽签。
    await prisma.roleAssignment.create({ data: { userId: adminId, tournamentId, role: "CHIEF_REFEREE" } });
    await expect(revokePublishedDraw(adminId, slug, "MS", { reason: "测试" })).rejects.toMatchObject({ code: "draw_matches_started" });
  });

  it("6 人单淘汰：签表 8 位 2 个轮空，轮空不生成比赛，决赛与三四名赛引用未决来源", async () => {
    const { slug, ms } = await newTournament("draw-ko");
    for (let index = 0; index < 6; index += 1) {
      const created = await createManualRegistration(adminId, slug, {
        competitionId: ms,
        members: [{ displayName: `淘汰选手${index + 1}`, studentId: nextStudentId() }],
      });
      await approveRegistration(slug, created.id);
    }
    const entries = await prisma.entry.findMany({ where: { competitionId: ms }, orderBy: { code: "asc" }, select: { id: true } });
    const draft = await generateDrawDraft(adminId, slug, "MS", {
      format: "KNOCKOUT",
      seeds: [
        { entryId: entries[0].id, seedNo: 1, basis: "上届冠军" },
        { entryId: entries[1].id, seedNo: 2, basis: "上届亚军" },
      ],
    });
    await closeRegistration(slug);
    const published = await publishDraw(adminId, slug, "MS", draft.drawId, { confirm: true });
    // 首轮 2 场（两个种子轮空）+ 半决赛 2 + 决赛 1 + 三四名 1。
    expect(published).toMatchObject({ fixtures: 6, matches: 6, groups: 0, stages: 1 });
    const fixtures = await prisma.fixture.findMany({ where: { drawId: draft.drawId }, include: { matches: { select: { sideAEntryId: true, sideBEntryId: true } } } });
    const final = fixtures.find((fixture) => fixture.code === "F");
    expect(final?.matches[0]).toEqual({ sideAEntryId: null, sideBEntryId: null });
    const semis = fixtures.filter((fixture) => fixture.code.startsWith("SF"));
    // 每场半决赛一侧是轮空直接晋级的种子，另一侧是首轮胜者。
    expect(semis.map((fixture) => [fixture.sideASource, fixture.sideBSource].sort().join())).toEqual([
      "ENTRY,FIXTURE_WINNER",
      "ENTRY,FIXTURE_WINNER",
    ]);
    expect(semis.map((fixture) => fixture.sideAEntryId ?? fixture.sideBEntryId).sort()).toEqual([entries[0].id, entries[1].id].sort());
  });
});

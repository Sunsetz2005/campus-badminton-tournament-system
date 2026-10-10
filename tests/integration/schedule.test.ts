import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { RubberKind } from "@/domain/registration/team-roster";
import { eligibleForRubber } from "@/domain/team/lineup";
import { utcToZonedLocal } from "@/domain/time/zoned-time";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { getPublicSchedule } from "@/server/services/public-tournament-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { loadScheduleFacts } from "@/server/services/schedule-facts";
import {
  addCourts,
  autoScheduleAfterDraw,
  checkDraft,
  discardDraftSlot,
  hashWarnings,
  loadScheduleWorkspace,
  publishSchedule,
  relayoutTie,
  replaceMatchReferee,
  replaceScheduleDays,
  saveDraftSlot,
  suggestDraft,
  updateCourt,
} from "@/server/services/schedule-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { acquireScoringSession } from "@/server/services/scoring-session-service";
import {
  createRefereeAccount,
  disableRefereeAccount,
  resetRefereePassword,
  updateRefereeMode,
} from "@/server/services/referee-account-service";
import { createTeam, provisionTeamManager, submitTeamRoster } from "@/server/services/team-service";
import { loadRosterForLineup, submitLineup } from "@/server/services/team-tie-service";
import { createTournament, publishTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

const RUN = randomBytes(3).toString("hex");
const TZ = "Asia/Shanghai";
const createdSlugs: string[] = [];
const createdEmails: string[] = [];
let adminId = "";
let refereeId = "";
let referee2Id = "";
let studentSeq = 0;

function nextStudentId() {
  studentSeq += 1;
  return `C${RUN.toUpperCase()}${String(studentSeq).padStart(4, "0")}`;
}

function roster(male = 3, female = 3) {
  return [
    ...Array.from({ length: male }, (_, index) => ({
      displayName: `男${studentSeq}-${index}`,
      studentId: nextStudentId(),
      gender: "MALE",
      rubberKinds: ["MS", "MD", "XD"],
    })),
    ...Array.from({ length: female }, (_, index) => ({
      displayName: `女${studentSeq}-${index}`,
      studentId: nextStudentId(),
      gender: "FEMALE",
      rubberKinds: ["WS", "WD", "XD"],
    })),
  ];
}

async function approve(slug: string, registrationId: string) {
  const current = await prisma.registration.findUniqueOrThrow({ where: { id: registrationId }, select: { version: true } });
  return reviewRegistration(adminId, slug, registrationId, { action: "APPROVE", expectedVersion: current.version });
}

async function teamTournament(name: string, teamCount: number, settings: Record<string, unknown>, teamFormat?: Record<string, unknown>, rosterShape: [number, number] = [3, 3]) {
  const slug = `t4c-${RUN}-${name}`;
  createdSlugs.push(slug);
  await createTournament(adminId, {
    slug,
    name: `赛程测试 ${name}`,
    startDate: "2026-11-02",
    endDate: "2026-11-03",
    timezone: TZ,
    namePolicy: "DISPLAY_NAMES",
    rulePreset: "traditional-21",
    competitions: [{ kind: "TEAM", code: "TEAM", name: "学院团体赛", ...(teamFormat ? { teamFormat } : {}) }],
  });
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const competition = await prisma.competition.findFirstOrThrow({ where: { tournamentId: tournament.id }, select: { id: true } });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
  const teams: { id: string }[] = [];
  for (let index = 0; index < teamCount; index += 1) {
    const team = await createTeam(adminId, slug, { name: `学院${index + 1}` });
    const submitted = await submitTeamRoster({ userId: adminId, mode: "ADMIN" }, slug, team.id, {
      competitionId: competition.id,
      members: roster(...rosterShape),
    });
    await approve(slug, submitted.registrationId);
    teams.push(team);
  }
  const draft = await generateDrawDraft(adminId, slug, "TEAM", settings);
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
  await publishDraw(adminId, slug, "TEAM", draft.drawId, { confirm: true });
  await prisma.roleAssignment.createMany({
    data: [
      { userId: refereeId, tournamentId: tournament.id, role: "REFEREE" },
      { userId: referee2Id, tournamentId: tournament.id, role: "REFEREE" },
      { userId: adminId, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
    ],
  });
  return { slug, tournamentId: tournament.id, competitionId: competition.id, teams };
}

async function autoLineup(entryId: string, fixtureId: string) {
  const members = await loadRosterForLineup(entryId);
  const matches = await prisma.match.findMany({ where: { fixtureId }, orderBy: { rubberOrder: "asc" }, select: { rubberOrder: true, rubberKind: true } });
  return matches.map((match) => {
    const kind = match.rubberKind as RubberKind;
    const pool = eligibleForRubber(kind, members);
    const picked = kind === "XD" ? [pool.find((item) => item.gender === "MALE"), pool.find((item) => item.gender === "FEMALE")] : pool.slice(0, kind === "MS" || kind === "WS" ? 1 : 2);
    return { order: match.rubberOrder as number, participantIds: picked.map((item) => item?.participantId as string) };
  });
}

async function publishWithDigest(slug: string, tournamentId: string) {
  const facts = await loadScheduleFacts(prisma, tournamentId);
  return publishSchedule(adminId, slug, { warningDigest: hashWarnings(checkDraft(facts)) });
}

function local(instant: Date) {
  return utcToZonedLocal(instant, TZ);
}

function coinToss(control: { sessionId: string; takeoverGeneration: number }): ScoringCommandEnvelope {
  return {
    commandId: randomUUID(),
    occurredAt: new Date().toISOString(),
    expectedVersion: 0,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type: "RECORD_COIN_TOSS",
    payload: { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } },
  } as ScoringCommandEnvelope;
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
  const email = `ref2-${RUN}@example.invalid`;
  createdEmails.push(email);
  referee2Id = (await prisma.user.create({ data: { email, name: `第二裁判${RUN}` } })).id;
});

afterAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  for (const slug of createdSlugs) {
    const tournament = await prisma.tournament.findUnique({ where: { slug }, select: { id: true } });
    if (!tournament) continue;
    const matchWhere = { stage: { competition: { tournamentId: tournament.id } } };
    await prisma.matchEvent.deleteMany({ where: { match: matchWhere } });
    await prisma.resultRevision.deleteMany({ where: { match: matchWhere } });
    await prisma.scoringSession.deleteMany({ where: { match: matchWhere } });
    await prisma.match.deleteMany({ where: matchWhere });
    await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: null } });
    await prisma.ruleProfileRevision.deleteMany({ where: { ruleProfile: { tournamentId: tournament.id } } });
    await prisma.tournament.delete({ where: { id: tournament.id } });
  }
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
});

describe("从对阵表到赛程：建议、检查、发布、执裁衔接", () => {
  let ctx: Awaited<ReturnType<typeof teamTournament>>;

  beforeAll(async () => {
    ctx = await teamTournament("flow", 6, { format: "GROUPS_KNOCKOUT", groupCount: 2 });
    await addCourts(adminId, ctx.slug, { count: 3 });
    await replaceScheduleDays(adminId, ctx.slug, {
      days: [
        { date: "2026-11-02", start: "09:00", end: "18:00" },
        { date: "2026-11-03", start: "09:00", end: "18:00" },
      ],
    });
  });

  it("只有赛事管理员能排赛程；裁判员不行", async () => {
    await expect(suggestDraft(refereeId, ctx.slug, {})).rejects.toMatchObject({ status: 403 });
  });

  it("自动建议：小组一组一块场地、淘汰赛在小组赛之后两块场地并行，且没有硬冲突", async () => {
    const result = await suggestDraft(adminId, ctx.slug, { stage: "ALL" });
    expect(result.unplaced).toEqual([]);
    expect(result.hardCount).toBe(0);
    const facts = await loadScheduleFacts(prisma, ctx.tournamentId);
    const byGroup = new Map<string, Set<string>>();
    for (const fact of facts.facts) {
      const placement = facts.draft.get(fact.id)!;
      expect(placement.start).not.toBeNull();
      if (fact.groupKey) byGroup.set(fact.groupKey, (byGroup.get(fact.groupKey) ?? new Set()).add(placement.courtId as string));
    }
    expect([...byGroup.values()].map((courts) => courts.size)).toEqual([1, 1]);
    const lastGroupEnd = Math.max(...facts.facts.filter((fact) => fact.stageOrder === 1).map((fact) => facts.draft.get(fact.id)!.start! + 25 * 60_000));
    const knockout = facts.facts.filter((fact) => fact.stageOrder === 2);
    expect(knockout.length).toBeGreaterThan(0);
    expect(knockout.every((fact) => facts.draft.get(fact.id)!.start! >= lastGroupEnd)).toBe(true);
    // 淘汰赛待晋级：候选集合非空、被标为暂定。
    expect(knockout.every((fact) => fact.candidateEntries.length > 0)).toBe(true);
    // 草稿发布前不影响已发布数据：比赛还没有计划时间，也没有主裁判指派。
    const scheduled = await prisma.match.count({ where: { stage: { competition: { tournamentId: ctx.tournamentId } }, scheduledAt: { not: null } } });
    expect(scheduled).toBe(0);
  });

  it("警告摘要不一致时拒绝发布；一致时发布并同步裁判指派与公开赛程", async () => {
    await expect(publishSchedule(adminId, ctx.slug, { warningDigest: "stale" })).rejects.toMatchObject({ code: "warnings_changed" });
    const published = await publishWithDigest(ctx.slug, ctx.tournamentId);
    expect(published.version).toBe(1);
    expect(published.added).toBeGreaterThan(0);
    const matches = await prisma.match.findMany({
      where: { stage: { competition: { tournamentId: ctx.tournamentId } } },
      select: { scheduledAt: true, scheduledEndAt: true, courtId: true, publishedAt: true, officialAssignments: { where: { active: true } } },
    });
    expect(matches.every((match) => match.scheduledAt && match.scheduledEndAt && match.courtId && match.publishedAt)).toBe(true);
    // 只有 2 名裁判员，而淘汰赛两场对抗并行时同时有 4 个小场：排程不为等裁判而压缩并行，
    // 指派不到的比赛如实缺裁判（发布前作为「尚未指派裁判」警告确认过），其余每场恰好 1 名主裁判。
    expect(matches.every((match) => match.officialAssignments.length <= 1)).toBe(true);
    expect(matches.filter((match) => match.officialAssignments.length === 1).length).toBeGreaterThan(matches.length / 2);
    // 「我的执裁」按真实指派读取。
    const mine = await prisma.officialAssignment.count({ where: { userId: refereeId, active: true, match: { stage: { competition: { tournamentId: ctx.tournamentId } } } } });
    expect(mine).toBeGreaterThan(0);
    await expect(prisma.scheduleSlot.count({ where: { tournamentId: ctx.tournamentId } })).resolves.toBe(0);
    const publication = await prisma.schedulePublication.findFirstOrThrow({ where: { tournamentId: ctx.tournamentId } });
    expect(publication.matchCount).toBe(matches.length);
  });

  it("人工改动后立即复检：挪到同场地同时间是硬冲突，发布被拒绝；放弃改动后恢复", async () => {
    const facts = await loadScheduleFacts(prisma, ctx.tournamentId);
    const groupFacts = facts.facts.filter((fact) => fact.groupKey);
    const [first] = groupFacts;
    const other = groupFacts.find((fact) => fact.groupKey !== first.groupKey)!;
    const target = facts.published.get(first.id)!;
    const court = facts.courts.find((item) => item.id === target.courtId)!;
    const response = await saveDraftSlot(adminId, ctx.slug, other.code, {
      courtCode: court.code,
      start: local(new Date(target.start!)),
      durationMinutes: 25,
      refereeUserId: target.refereeId === refereeId ? referee2Id : refereeId,
    });
    expect(response.focusIssues.map((issue) => issue.code)).toContain("COURT_OVERLAP");
    await expect(publishWithDigest(ctx.slug, ctx.tournamentId)).rejects.toMatchObject({ code: "schedule_has_conflicts" });
    const after = await discardDraftSlot(adminId, ctx.slug, other.code);
    expect(after.hardCount).toBe(0);
  });

  it("同一裁判同时执裁两场是硬冲突", async () => {
    const facts = await loadScheduleFacts(prisma, ctx.tournamentId);
    const groupA = facts.facts.filter((fact) => fact.groupKey && fact.groupKey === facts.facts.find((item) => item.groupKey)!.groupKey);
    const groupB = facts.facts.filter((fact) => fact.groupKey && fact.groupKey !== groupA[0].groupKey);
    const left = facts.published.get(groupA[0].id)!;
    const right = groupB.find((fact) => facts.published.get(fact.id)!.start === left.start)!;
    const response = await saveDraftSlot(adminId, ctx.slug, right.code, {
      courtCode: facts.courts.find((court) => court.id === facts.published.get(right.id)!.courtId)!.code,
      start: local(new Date(left.start!)),
      durationMinutes: 25,
      refereeUserId: left.refereeId,
    });
    expect(response.focusIssues.map((issue) => issue.code)).toContain("REFEREE_OVERLAP");
    await discardDraftSlot(adminId, ctx.slug, right.code);
  });

  it("关闭场地：已发布赛程出现硬冲突，需要调整后重新发布；重新开放后消失", async () => {
    const facts = await loadScheduleFacts(prisma, ctx.tournamentId);
    const used = facts.courts.find((court) => [...facts.published.values()].some((placement) => placement.courtId === court.id))!;
    const closed = await updateCourt(adminId, ctx.slug, used.code, { active: false });
    expect(closed.affectedPublishedMatches).toBeGreaterThan(0);
    const workspace = await loadScheduleWorkspace(ctx.tournamentId, new Date());
    expect(workspace.publishedCheck.issues.some((issue) => issue.code === "COURT_CLOSED")).toBe(true);
    expect(workspace.draftCheck.hardCount).toBeGreaterThan(0);
    await expect(publishWithDigest(ctx.slug, ctx.tournamentId)).rejects.toMatchObject({ code: "schedule_has_conflicts" });
    await updateCourt(adminId, ctx.slug, used.code, { active: true });
    expect((await loadScheduleWorkspace(ctx.tournamentId, new Date())).publishedCheck.hardCount).toBe(0);
  });

  it("已开始的比赛不能被移动：草稿拒绝、数据库拒绝、重新建议也不动它；裁判长临时换裁判衔接接管规则", async () => {
    const fixture = await prisma.fixture.findFirstOrThrow({ where: { competitionId: ctx.competitionId, groupId: { not: null } }, orderBy: [{ round: "asc" }, { sequence: "asc" }] });
    for (const side of ["A", "B"] as const) {
      const entryId = (side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId) as string;
      await submitLineup({ userId: adminId, mode: "ADMIN" }, ctx.slug, fixture.id, { side, rubbers: await autoLineup(entryId, fixture.id) });
    }
    const rubber = await prisma.match.findFirstOrThrow({
      where: { fixtureId: fixture.id, rubberOrder: 1 },
      select: { id: true, code: true, scheduledAt: true, courtId: true, officialAssignments: { where: { active: true }, select: { userId: true } } },
    });
    const originalReferee = rubber.officialAssignments[0].userId;
    const otherReferee = originalReferee === refereeId ? referee2Id : refereeId;
    const control = await acquireScoringSession(originalReferee, rubber.code, randomUUID());
    await expect(submitScoringCommand(originalReferee, rubber.code, coinToss(control), control.controlToken)).resolves.toMatchObject({ status: "accepted" });

    await expect(
      saveDraftSlot(adminId, ctx.slug, rubber.code, { courtCode: null, start: null, durationMinutes: 25, refereeUserId: null }),
    ).rejects.toMatchObject({ code: "match_started" });
    await expect(prisma.match.update({ where: { id: rubber.id }, data: { scheduledAt: new Date("2026-11-05T01:00:00Z") } })).rejects.toThrow();
    await suggestDraft(adminId, ctx.slug, { stage: "ALL" });
    const facts = await loadScheduleFacts(prisma, ctx.tournamentId);
    expect(facts.draft.get(rubber.id)!.start).toBe(rubber.scheduledAt!.getTime());

    // 裁判长临时更换裁判：须写原因；旧控制会话被吊销，旧设备再写被拒绝；新裁判按接管规则取得控制。
    await expect(replaceMatchReferee(adminId, ctx.slug, rubber.code, { refereeUserId: otherReferee, reason: "" })).rejects.toMatchObject({ code: "reason_required" });
    await expect(replaceMatchReferee(refereeId, ctx.slug, rubber.code, { refereeUserId: otherReferee, reason: "身体不适" })).rejects.toMatchObject({ status: 403 });
    const replaced = await replaceMatchReferee(adminId, ctx.slug, rubber.code, { refereeUserId: otherReferee, reason: "原裁判身体不适" });
    expect(replaced.revokedSessions).toBe(1);
    // 两个小组同时 09:00 开打，新裁判原本在另一块场地执裁：如实返回时间重叠，由裁判长决定是否再改派。
    expect(replaced.overlapping.length).toBeGreaterThan(0);
    const workspace = await loadScheduleWorkspace(ctx.tournamentId, new Date());
    expect(workspace.publishedCheck.issues.some((issue) => issue.code === "REFEREE_OVERLAP")).toBe(true);
    const stale = { ...coinToss(control), expectedVersion: 1 };
    // 指派已失效：旧设备连读取权限都没有了，写入在进入会话校验前就被拒绝。
    await expect(submitScoringCommand(originalReferee, rubber.code, stale, control.controlToken)).rejects.toMatchObject({ status: 403 });
    const revoked = await prisma.scoringSession.findUniqueOrThrow({ where: { id: control.sessionId } });
    expect(revoked).toMatchObject({ status: "REVOKED", revokedReason: "REFEREE_REPLACED" });
    const next = await acquireScoringSession(otherReferee, rubber.code, randomUUID());
    expect(next.status).toBe("acquired");
    expect(next.takeoverGeneration).toBe(control.takeoverGeneration + 1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "MATCH_REFEREE_REPLACED", targetId: rubber.id } });
    expect(audit.metadata).toMatchObject({ reason: "原裁判身体不适", from: [originalReferee], to: otherReferee });
  });

  it("公开赛程：团体小场在名单公开前只显示学院，不下发整队名单；公开后只显示该小场上场队员", async () => {
    await publishTournament(adminId, ctx.slug);
    const schedule = await getPublicSchedule(ctx.slug);
    const all = schedule.matches.concat(schedule.unscheduled);
    expect(all.length).toBeGreaterThan(0);
    const revealedFixture = await prisma.fixture.findFirstOrThrow({ where: { competitionId: ctx.competitionId, lineupsRevealedAt: { not: null } }, select: { id: true } });
    const revealedCodes = new Set((await prisma.match.findMany({ where: { fixtureId: revealedFixture.id }, select: { code: true } })).map((match) => match.code));
    for (const match of all) {
      const members = [...(match.sideA?.members ?? []), ...(match.sideB?.members ?? [])];
      if (revealedCodes.has(match.code)) {
        expect(members.length).toBeGreaterThanOrEqual(2);
        expect(members.length).toBeLessThanOrEqual(4);
      } else {
        expect(members).toEqual([]);
      }
      expect(match.stageName).toMatch(/第 \d 场/);
      // 换裁判造成的重叠会让新裁判的下一场有据顺延（DELAYED 带原计划时间）；其余为固定或预计时间。
      expect(["FIXED", "ESTIMATED", "DELAYED"]).toContain(match.time.type);
      if (match.time.type === "DELAYED") expect(match.time.originalScheduledAt).toBeTruthy();
    }
    expect(all.some((match) => match.time.type === "ESTIMATED")).toBe(true);
  });
});

describe("出场名单截止、兼项上限与同时进行的小场", () => {
  let ctx: Awaited<ReturnType<typeof teamTournament>>;
  let managerId = "";

  beforeAll(async () => {
    ctx = await teamTournament(
      "lineup",
      2,
      { format: "ROUND_ROBIN" },
      { rubbers: ["XD", "MS", "WS", "MD", "WD"], rosterMin: 6, rosterMax: 12, minMale: 4, minFemale: 2, maxRubbersMale: 1, maxRubbersFemale: 2 },
      [4, 2],
    );
    await addCourts(adminId, ctx.slug, { count: 3 });
    const email = `mgr-${RUN}-deadline@example.invalid`;
    createdEmails.push(email);
    await provisionTeamManager(adminId, ctx.slug, ctx.teams[0].id, { email, name: "截止测试负责人" });
    managerId = (await prisma.user.update({ where: { email }, data: { mustChangePassword: false }, select: { id: true } })).id;
  });

  async function fixtureAndSide() {
    const fixture = await prisma.fixture.findFirstOrThrow({ where: { competitionId: ctx.competitionId } });
    const managerEntry = await prisma.entry.findFirstOrThrow({ where: { competitionId: ctx.competitionId, teamId: ctx.teams[0].id } });
    const side = fixture.sideAEntryId === managerEntry.id ? "A" : "B";
    return { fixture, side: side as "A" | "B", other: (side === "A" ? "B" : "A") as "A" | "B", entryId: managerEntry.id };
  }

  async function lineupFor(entryId: string) {
    const members = await loadRosterForLineup(entryId);
    const male = members.filter((member) => member.gender === "MALE").map((member) => member.participantId);
    const female = members.filter((member) => member.gender === "FEMALE").map((member) => member.participantId);
    return { male, female };
  }

  it("赛程发布前没有截止时间；发布后截止前负责人可以提交", async () => {
    const { fixture, entryId } = await fixtureAndSide();
    const { male, female } = await lineupFor(entryId);
    const start = new Date(Date.now() + 3 * 60 * 60_000);
    start.setUTCSeconds(0, 0);
    await relayoutTie(adminId, ctx.slug, fixture.id, { start: local(start), courtCodes: ["C1", "C2", "C3"] });
    await publishWithDigest(ctx.slug, ctx.tournamentId);
    // 三块场地同时打：第 1（混双）、2（男单）、3（女单）场同时开始，同一名女队员不能既上混双又上女单。
    const clash = [
      { order: 1, participantIds: [male[0], female[0]] },
      { order: 2, participantIds: [male[1]] },
      { order: 3, participantIds: [female[0]] },
      { order: 4, participantIds: [male[2], male[3]] },
      { order: 5, participantIds: [female[0], female[1]] },
    ];
    await expect(submitLineup({ userId: managerId, mode: "TEAM_MANAGER" }, ctx.slug, fixture.id, { rubbers: clash })).rejects.toMatchObject({
      code: "invalid_lineup",
      details: { errors: expect.arrayContaining([expect.stringContaining("同时进行")]) },
    });
    // 男队员不得兼项。
    const maleTwice = [
      { order: 1, participantIds: [male[0], female[0]] },
      { order: 2, participantIds: [male[0]] },
      { order: 3, participantIds: [female[1]] },
      { order: 4, participantIds: [male[2], male[3]] },
      { order: 5, participantIds: [female[0], female[1]] },
    ];
    await expect(submitLineup({ userId: managerId, mode: "TEAM_MANAGER" }, ctx.slug, fixture.id, { rubbers: maleTwice })).rejects.toMatchObject({
      details: { errors: expect.arrayContaining([expect.stringContaining("男队员最多 1 个")]) },
    });
    const valid = [
      { order: 1, participantIds: [male[0], female[0]] },
      { order: 2, participantIds: [male[1]] },
      { order: 3, participantIds: [female[1]] },
      { order: 4, participantIds: [male[2], male[3]] },
      { order: 5, participantIds: [female[0], female[1]] },
    ];
    await expect(submitLineup({ userId: managerId, mode: "TEAM_MANAGER" }, ctx.slug, fixture.id, { rubbers: valid })).resolves.toMatchObject({ late: false, revealed: false });
  });

  it("数据库兜底兼项上限：绕过服务直接写入第二个小场会被拒绝", async () => {
    const { fixture, side, entryId } = await fixtureAndSide();
    const rubber2 = await prisma.match.findFirstOrThrow({ where: { fixtureId: fixture.id, rubberOrder: 2 } });
    const players = await prisma.matchPlayer.findMany({ where: { match: { fixtureId: fixture.id, rubberOrder: 1 }, side } });
    const maleInXd = (await loadRosterForLineup(entryId)).find((member) => member.gender === "MALE" && players.some((player) => player.participantId === member.participantId))!;
    await expect(
      prisma.$transaction([
        prisma.matchPlayer.deleteMany({ where: { matchId: rubber2.id, side } }),
        prisma.matchPlayer.create({ data: { matchId: rubber2.id, side, slot: 1, entryId, participantId: maleInXd.participantId } }),
      ]),
    ).rejects.toThrow(/limit is 1/);
  });

  it("赛程改到截止之后：负责人不能再改，管理员代交并标记逾期", async () => {
    const { fixture, side, other, entryId } = await fixtureAndSide();
    const start = new Date(Date.now() + 20 * 60_000);
    start.setUTCSeconds(0, 0);
    await relayoutTie(adminId, ctx.slug, fixture.id, { start: local(start), courtCodes: ["C1"] });
    await publishWithDigest(ctx.slug, ctx.tournamentId);
    const own = await prisma.fixtureLineup.findUniqueOrThrow({ where: { fixtureId_side: { fixtureId: fixture.id, side } } });
    const { male, female } = await lineupFor(entryId);
    const rubbers = [
      { order: 1, participantIds: [male[0], female[0]] },
      { order: 2, participantIds: [male[1]] },
      { order: 3, participantIds: [female[0]] },
      { order: 4, participantIds: [male[2], male[3]] },
      { order: 5, participantIds: [female[1], female[0]] },
    ];
    await expect(
      submitLineup({ userId: managerId, mode: "TEAM_MANAGER" }, ctx.slug, fixture.id, { expectedVersion: own.version, rubbers }),
    ).rejects.toMatchObject({ code: "lineup_deadline_passed" });
    const otherEntry = (other === "A" ? fixture.sideAEntryId : fixture.sideBEntryId) as string;
    const theirs = await lineupFor(otherEntry);
    const result = await submitLineup({ userId: adminId, mode: "ADMIN" }, ctx.slug, fixture.id, {
      side: other,
      rubbers: [
        { order: 1, participantIds: [theirs.male[0], theirs.female[0]] },
        { order: 2, participantIds: [theirs.male[1]] },
        { order: 3, participantIds: [theirs.female[1]] },
        { order: 4, participantIds: [theirs.male[2], theirs.male[3]] },
        { order: 5, participantIds: [theirs.female[0], theirs.female[1]] },
      ],
    });
    expect(result).toMatchObject({ late: true, revealed: true });
    const late = await prisma.fixtureLineup.findUniqueOrThrow({ where: { fixtureId_side: { fixtureId: fixture.id, side: other } } });
    expect(late).toMatchObject({ source: "ADMIN", submittedLate: true });
    // 名单公开后，人员冲突按真实上场队员检查。
    const facts = await loadScheduleFacts(prisma, ctx.tournamentId);
    const rubberFacts = facts.facts.filter((fact) => fact.fixtureId === fixture.id);
    expect(rubberFacts.every((fact) => fact.confirmedPersons.length >= 2 && !fact.hiddenPersons)).toBe(true);
  });
});

describe("个人项目：同一人同时报单打和双打", () => {
  it("两场时间重叠时复检给出该运动员的硬冲突", async () => {
    const slug = `t4c-${RUN}-single`;
    createdSlugs.push(slug);
    await createTournament(adminId, {
      slug,
      name: "赛程测试 个人项目",
      startDate: "2026-11-02",
      endDate: "2026-11-03",
      timezone: TZ,
      namePolicy: "CODES_ONLY",
      rulePreset: "traditional-21",
      competitions: [
        { kind: "MS", code: "MS", name: "男子单打" },
        { kind: "MD", code: "MD", name: "男子双打" },
      ],
    });
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const competitions = Object.fromEntries(
      (await prisma.competition.findMany({ where: { tournamentId: tournament.id }, select: { id: true, code: true } })).map((item) => [item.code, item.id]),
    );
    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
    const shared = nextStudentId();
    const registrations = [
      { competitionId: competitions.MS, members: [{ displayName: "兼项甲", studentId: shared }] },
      { competitionId: competitions.MS, members: [{ displayName: "单打乙", studentId: nextStudentId() }] },
      { competitionId: competitions.MD, members: [{ displayName: "兼项甲", studentId: shared }, { displayName: "双打丙", studentId: nextStudentId() }] },
      { competitionId: competitions.MD, members: [{ displayName: "双打丁", studentId: nextStudentId() }, { displayName: "双打戊", studentId: nextStudentId() }] },
    ];
    for (const input of registrations) {
      const created = await createManualRegistration(adminId, slug, input);
      await approve(slug, created.id);
    }
    const drafts = {
      MS: await generateDrawDraft(adminId, slug, "MS", { format: "ROUND_ROBIN" }),
      MD: await generateDrawDraft(adminId, slug, "MD", { format: "ROUND_ROBIN" }),
    };
    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
    await publishDraw(adminId, slug, "MS", drafts.MS.drawId, { confirm: true });
    await publishDraw(adminId, slug, "MD", drafts.MD.drawId, { confirm: true });
    await addCourts(adminId, slug, { count: 2 });
    const ms = await prisma.match.findFirstOrThrow({ where: { stage: { competitionId: competitions.MS } } });
    const md = await prisma.match.findFirstOrThrow({ where: { stage: { competitionId: competitions.MD } } });
    await saveDraftSlot(adminId, slug, ms.code, { courtCode: "C1", start: "2026-11-02T09:00", durationMinutes: 30, refereeUserId: null });
    const response = await saveDraftSlot(adminId, slug, md.code, { courtCode: "C2", start: "2026-11-02T09:20", durationMinutes: 30, refereeUserId: null });
    const overlap = response.focusIssues.find((issue) => issue.code === "PERSON_OVERLAP");
    expect(overlap?.severity).toBe("HARD");
    expect(overlap?.message).toContain("兼项甲");
    const moved = await saveDraftSlot(adminId, slug, md.code, { courtCode: "C2", start: "2026-11-02T09:30", durationMinutes: 30, refereeUserId: null });
    expect(moved.focusIssues.filter((issue) => issue.severity === "HARD")).toEqual([]);
  });
});

describe("一键排程：抽签后自动排出场地与时间", () => {
  /** 默认 6 人单循环：15 场、每轮 3 场两两不重叠，共 5 轮。 */
  async function singlesRoundRobin(
    name: string,
    setup?: (slug: string) => Promise<void>,
    players = 6,
    drawSettings: Record<string, unknown> = { format: "ROUND_ROBIN" },
  ) {
    const slug = `t4c-${RUN}-${name}`;
    createdSlugs.push(slug);
    await createTournament(adminId, {
      slug,
      name: `一键排程 ${name}`,
      startDate: "2026-11-02",
      endDate: "2026-11-02",
      timezone: TZ,
      namePolicy: "DISPLAY_NAMES",
      rulePreset: "traditional-21",
      competitions: [{ kind: "MS", code: "MS", name: "男子单打" }],
    });
    const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const competition = await prisma.competition.findFirstOrThrow({ where: { tournamentId: tournament.id }, select: { id: true } });
    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
    for (let index = 0; index < players; index += 1) {
      const created = await createManualRegistration(adminId, slug, {
        competitionId: competition.id,
        members: [{ displayName: `选手${index + 1}`, studentId: nextStudentId() }],
      });
      await approve(slug, created.id);
    }
    const draft = await generateDrawDraft(adminId, slug, "MS", drawSettings);
    await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
    await setup?.(slug);
    await publishDraw(adminId, slug, "MS", draft.drawId, { confirm: true });
    return { slug, tournamentId: tournament.id };
  }

  it("未设场地或比赛日时明确拒绝；时段不够时算出需要的结束时间，延长后全部排下", async () => {
    const { slug, tournamentId } = await singlesRoundRobin("shortfall");
    await expect(autoScheduleAfterDraw(adminId, slug, "MS")).resolves.toEqual({ status: "SKIPPED_NOT_CONFIGURED" });
    await expect(suggestDraft(adminId, slug, {})).rejects.toMatchObject({ status: 409, code: "no_courts" });
    await addCourts(adminId, slug, { count: 3 });
    await expect(suggestDraft(adminId, slug, {})).rejects.toMatchObject({ status: 409, code: "no_schedule_days" });
    // 拒绝时不写任何草稿时间。
    await expect(prisma.scheduleSlot.count({ where: { tournamentId, startsAt: { not: null } } })).resolves.toBe(0);

    // 默认每场 30 分钟、换场 5 分钟：5 轮需要 09:00 到 11:50。
    await replaceScheduleDays(adminId, slug, { days: [{ date: "2026-11-02", start: "09:00", end: "10:00" }] });
    const short = await suggestDraft(adminId, slug, {});
    expect(short.scope).toBe(15);
    expect(short.placed).toBeLessThan(15);
    expect(short.shortfall).toEqual({ date: "2026-11-02", currentEnd: "10:00", requiredEnd: "11:50" });

    await replaceScheduleDays(adminId, slug, { days: [{ date: "2026-11-02", start: "09:00", end: "11:50" }] });
    const full = await suggestDraft(adminId, slug, {});
    expect(full).toMatchObject({ scope: 15, placed: 15, shortfall: null, unplaced: [], hardCount: 0 });
    const slots = await prisma.scheduleSlot.findMany({ where: { tournamentId }, select: { startsAt: true, courtId: true } });
    expect(slots.every((slot) => slot.startsAt && slot.courtId)).toBe(true);
    expect(new Set(slots.map((slot) => local(slot.startsAt as Date)))).toEqual(
      new Set(["2026-11-02T09:00", "2026-11-02T09:35", "2026-11-02T10:10", "2026-11-02T10:45", "2026-11-02T11:20"]),
    );

    // 已有安排时，抽签后的自动排程不覆盖。
    await expect(autoScheduleAfterDraw(adminId, slug, "MS")).resolves.toEqual({ status: "SKIPPED_ALREADY_ARRANGED" });
  });

  it("放宽到当天 24:00 也排不下时提示增加比赛日", async () => {
    const { slug } = await singlesRoundRobin("more-days", async (slug) => {
      await addCourts(adminId, slug, { count: 1 });
      await replaceScheduleDays(adminId, slug, { days: [{ date: "2026-11-02", start: "18:00", end: "19:00" }] });
    });
    const result = await suggestDraft(adminId, slug, {});
    expect(result.shortfall).toEqual({ date: "2026-11-02", currentEnd: "19:00", requiredEnd: null });
  });

  it("已设好场地与比赛日时，抽签发布后直接生成全部比赛的草稿安排", async () => {
    const { slug, tournamentId } = await singlesRoundRobin("auto", async (slug) => {
      await addCourts(adminId, slug, { count: 3 });
      await replaceScheduleDays(adminId, slug, { days: [{ date: "2026-11-02", start: "09:00", end: "18:00" }] });
    });
    const result = await autoScheduleAfterDraw(adminId, slug, "MS");
    expect(result).toMatchObject({ status: "GENERATED", scope: 15, placed: 15, shortfall: null });
    await expect(prisma.scheduleSlot.count({ where: { tournamentId, startsAt: { not: null } } })).resolves.toBe(15);
    // 只是草稿：发布前比赛本身没有计划时间。
    await expect(prisma.match.count({ where: { stage: { competition: { tournamentId } }, scheduledAt: { not: null } } })).resolves.toBe(0);
  });

  it("小组+淘汰：两场半决赛同时进行，决赛与三四名赛同时进行（同项目未定对阵不会共用运动员）", async () => {
    // 复现演示站反馈：10 人分 2 组、8 块场地。小组赛每组最多 2 场并行，只用得上 4 块场地；
    // 淘汰赛此前被当作可能撞人而全部串行在 1 块场地上。
    const { slug, tournamentId } = await singlesRoundRobin(
      "ko-parallel",
      async (slug) => {
        await addCourts(adminId, slug, { count: 8 });
        await replaceScheduleDays(adminId, slug, { days: [{ date: "2026-11-02", start: "09:00", end: "18:00" }] });
      },
      10,
      { format: "GROUPS_KNOCKOUT", groupCount: 2, qualifiersPerGroup: 2, thirdPlaceMatch: true },
    );
    const result = await autoScheduleAfterDraw(adminId, slug, "MS");
    expect(result).toMatchObject({ status: "GENERATED", scope: 24, placed: 24, hardCount: 0, warningCount: 1 });
    const slots = await prisma.scheduleSlot.findMany({
      where: { tournamentId },
      select: { startsAt: true, courtId: true, match: { select: { fixture: { select: { kind: true } } } } },
    });
    const startsOf = (kinds: string[]) =>
      slots.filter((slot) => kinds.includes(slot.match.fixture?.kind ?? "")).map((slot) => local(slot.startsAt as Date)).sort();
    const groupStarts = startsOf(["GROUP"]);
    // 5 轮 × 4 场，每轮占 4 块场地。
    expect(new Set(groupStarts).size).toBe(5);
    expect(Math.max(...[...new Set(groupStarts)].map((start) => groupStarts.filter((item) => item === start).length))).toBe(4);
    const lastGroup = groupStarts.at(-1)!;
    const knockout = startsOf(["KNOCKOUT", "THIRD_PLACE"]);
    expect(knockout).toHaveLength(4);
    // 半决赛两场同一时刻；决赛与三四名赛同一时刻，且在半决赛之后。
    expect(knockout[0]).toBe(knockout[1]);
    expect(knockout[2]).toBe(knockout[3]);
    expect(knockout[0] > lastGroup && knockout[2] > knockout[0]).toBe(true);
    // 唯一的警告是没有裁判员账号时的「尚未指派裁判」，不再有同项目的暂定冲突。
    const facts = await loadScheduleFacts(prisma, tournamentId);
    expect(checkDraft(facts).issues.map((issue) => issue.code)).toEqual(["NO_REFEREE"]);
  });

  it("共用裁判账号：不逐场指派也能执裁任意一场；同一场只能由一台设备控制；切回逐场指派或停用后失去权限", async () => {
    const { slug, tournamentId } = await singlesRoundRobin("shared-ref", async (slug) => {
      await addCourts(adminId, slug, { count: 3 });
      await replaceScheduleDays(adminId, slug, { days: [{ date: "2026-11-02", start: "09:00", end: "18:00" }] });
    });
    const username = `Ref_${RUN}`;
    const created = await createRefereeAccount(adminId, slug, { username, name: "现场裁判" });
    expect(created.password).toMatch(/^[A-Za-z0-9]{16}$/);
    const account = await prisma.user.findUniqueOrThrow({
      where: { id: created.userId },
      select: { email: true, username: true, mustChangePassword: true, provisionedForTournamentId: true },
    });
    createdEmails.push(account.email);
    // 共用账号不要求首次改口令；用户名按登录插件小写归一。
    expect(account).toMatchObject({ username: username.toLowerCase(), mustChangePassword: false, provisionedForTournamentId: tournamentId });
    await expect(createRefereeAccount(adminId, slug, { username: username.toUpperCase(), name: "重复" })).rejects.toMatchObject({ status: 409, code: "username_taken" });
    await expect(createRefereeAccount(adminId, slug, { username: `ref2_${RUN}`, name: "短口令", password: "short" })).rejects.toMatchObject({ status: 400 });
    // 审计不含口令。
    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { tournamentId, action: "REFEREE_ACCOUNT_CREATED" } });
    expect(JSON.stringify(auditRow.metadata)).not.toContain(created.password as string);

    const matches = await prisma.match.findMany({ where: { stage: { competition: { tournamentId } } }, select: { code: true }, orderBy: { code: "asc" } });
    const [first, second] = matches.map((match) => match.code);

    // 逐场指派模式下没有指派就不能执裁。
    await expect(acquireScoringSession(created.userId, first, randomUUID())).rejects.toMatchObject({ status: 403, code: "not_assigned" });

    await updateRefereeMode(adminId, slug, { refereeMode: "SHARED_ACCOUNT" });
    // 排程不指派主裁判，也不提示「尚未指派裁判」。
    const suggestion = await suggestDraft(adminId, slug, { assignReferees: true });
    expect(suggestion).toMatchObject({ placed: 15, hardCount: 0 });
    await expect(prisma.scheduleSlot.count({ where: { tournamentId, refereeUserId: { not: null } } })).resolves.toBe(0);
    const facts = await loadScheduleFacts(prisma, tournamentId);
    expect(checkDraft(facts).issues.map((issue) => issue.code)).not.toContain("NO_REFEREE");

    // 同一账号、两台设备分别执裁两场；第二台设备不能抢同一场。
    const deviceA = randomUUID();
    const deviceB = randomUUID();
    const controlA = await acquireScoringSession(created.userId, first, deviceA);
    await expect(acquireScoringSession(created.userId, first, deviceB)).rejects.toMatchObject({ status: 409, code: "controller_exists" });
    const controlB = await acquireScoringSession(created.userId, second, deviceB);
    await expect(submitScoringCommand(created.userId, first, coinToss(controlA), controlA.controlToken)).resolves.toMatchObject({ status: "accepted" });
    await expect(submitScoringCommand(created.userId, second, coinToss(controlB), controlB.controlToken)).resolves.toMatchObject({ status: "accepted" });

    // 只能重置/停用本赛事开通的裁判账号，不能借此接管管理员账号。
    await expect(resetRefereePassword(adminId, slug, adminId, {})).rejects.toMatchObject({ status: 404 });
    const reset = await resetRefereePassword(adminId, slug, created.userId, {});
    expect(reset.password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(reset.password).not.toBe(created.password);

    // 切回逐场指派：已取得的控制在下一条命令时被拒绝。
    await updateRefereeMode(adminId, slug, { refereeMode: "PER_MATCH" });
    const next = { ...coinToss(controlA), type: "RECORD_SPECIAL_OUTCOME", expectedVersion: 1, payload: { type: "WO", winnerSide: "A" } } as ScoringCommandEnvelope;
    await expect(submitScoringCommand(created.userId, first, next, controlA.controlToken)).rejects.toMatchObject({ status: 403 });

    // 停用：撤销角色、注销会话、吊销控制。
    await updateRefereeMode(adminId, slug, { refereeMode: "SHARED_ACCOUNT" });
    await disableRefereeAccount(adminId, slug, created.userId);
    await expect(prisma.scoringSession.count({ where: { userId: created.userId, status: "ACTIVE" } })).resolves.toBe(0);
    await expect(acquireScoringSession(created.userId, first, deviceA)).rejects.toMatchObject({ status: 403 });
  });
});

import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand } from "@/domain/rules/match-engine";
import { requireChiefReferee } from "@/server/auth/authorization";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { createChiefRefereeAccount, grantChiefReferee, listChiefReferees, revokeChiefReferee } from "@/server/services/chief-referee-service";
import { updateRefereeMode } from "@/server/services/referee-account-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { acquireScoringSession, heartbeatScoringSession, takeoverScoringSession } from "@/server/services/scoring-session-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

const RUN = randomBytes(3).toString("hex");
const createdSlugs: string[] = [];
const createdUserIds: string[] = [];
let adminId = "";
/** 示例裁判员：平台共用裁判账号，建赛时自动持有 REFEREE。 */
let refereeId = "";
let chiefAId = "";
let chiefBId = "";
let otherAdminId = "";
let commandSeq = 0;

async function newUser(label: string, extra: { username?: string; status?: "ACTIVE" | "DISABLED" } = {}) {
  const user = await prisma.user.create({
    data: { name: `${label} ${RUN}`, email: `${label}-${RUN}@chief-referee.test`, ...extra },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  return user.id;
}

/** 只经产品服务建赛：建赛向导 → 报名审核 → 单循环抽签发布。不直接写角色表。 */
async function published(name: string, entryCount = 3) {
  const slug = `chief-${RUN}-${name}`;
  createdSlugs.push(slug);
  await createTournament(adminId, {
    slug,
    name: `裁判长授予测试 ${name}`,
    startDate: "2026-11-01",
    endDate: "2026-11-03",
    timezone: "Asia/Shanghai",
    namePolicy: "CODES_ONLY",
    rulePreset: "traditional-21",
    competitions: [{ kind: "MS", code: "MS", name: "男子单打" }],
  });
  const tournament = await prisma.tournament.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const competition = await prisma.competition.findFirstOrThrow({ where: { tournamentId: tournament.id }, select: { id: true } });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_OPEN" });
  for (let index = 0; index < entryCount; index += 1) {
    const created = await createManualRegistration(adminId, slug, {
      competitionId: competition.id,
      members: [{ displayName: `选手${index + 1}`, teamName: `学院${index + 1}` }],
    });
    const registration = await prisma.registration.findUniqueOrThrow({ where: { referenceCode: created.referenceCode }, select: { id: true, version: true } });
    await reviewRegistration(adminId, slug, registration.id, { action: "APPROVE", expectedVersion: registration.version });
  }
  const draft = await generateDrawDraft(adminId, slug, "MS", { format: "ROUND_ROBIN" });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
  await publishDraw(adminId, slug, "MS", draft.drawId, { confirm: true });
  await updateRefereeMode(adminId, slug, { refereeMode: "SHARED_ACCOUNT" });
  const matches = await prisma.match.findMany({
    where: { stage: { competition: { tournamentId: tournament.id } } },
    orderBy: { code: "asc" },
    select: { id: true, code: true },
  });
  return { slug, tournamentId: tournament.id, matches };
}

function command(
  control: { sessionId: string; takeoverGeneration: number },
  expectedVersion: number,
  type: MatchCommand["type"],
  payload: MatchCommand["payload"],
): ScoringCommandEnvelope {
  commandSeq += 1;
  return {
    commandId: randomUUID(),
    occurredAt: new Date(Date.UTC(2026, 10, 2, 8, 0, commandSeq)).toISOString(),
    expectedVersion,
    scoringSessionId: control.sessionId,
    takeoverGeneration: control.takeoverGeneration,
    type,
    payload,
  } as ScoringCommandEnvelope;
}

async function accepted(promise: Promise<unknown>) {
  const result = (await promise) as { status: string; version: number };
  if (result.status !== "accepted") throw new Error(`命令未被接受：${result.status}`);
  return result;
}

/** 平台共用裁判账号在共用账号模式下记录弃权并提交，返回待复核的版本。 */
async function submitWalkover(matchCode: string) {
  const control = await acquireScoringSession(refereeId, matchCode, randomUUID());
  const current = await prisma.match.findUniqueOrThrow({ where: { code: matchCode }, select: { version: true } });
  let version = (await accepted(
    submitScoringCommand(refereeId, matchCode, command(control, current.version, "RECORD_SPECIAL_OUTCOME", { type: "WO", winnerSide: "A", reason: "对方未到" }), control.controlToken),
  )).version;
  version = (await accepted(submitScoringCommand(refereeId, matchCode, command(control, version, "SUBMIT_RESULT", { reason: "提交弃权结果" }), control.controlToken))).version;
  return version;
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
  chiefAId = await newUser("chief-a", { username: `chiefa_${RUN}` });
  chiefBId = await newUser("chief-b");
  otherAdminId = await newUser("other-admin");
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
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("赛事管理员授予与撤销裁判长", () => {
  it("新建赛事起初没有裁判长；按登录用户名或邮箱授予，重复授予幂等并留审计", async () => {
    const { slug, tournamentId } = await published("grant");
    expect(await listChiefReferees(tournamentId)).toEqual([]);

    const first = await grantChiefReferee(adminId, slug, { login: `CHIEFA_${RUN}` });
    expect(first).toMatchObject({ userId: chiefAId, granted: true, username: `chiefa_${RUN}` });
    const again = await grantChiefReferee(adminId, slug, { userId: chiefAId });
    expect(again).toMatchObject({ userId: chiefAId, granted: false });
    const byEmail = await grantChiefReferee(adminId, slug, { login: `Chief-B-${RUN}@chief-referee.test` });
    expect(byEmail).toMatchObject({ userId: chiefBId, granted: true });

    expect(await prisma.roleAssignment.count({ where: { tournamentId, role: "CHIEF_REFEREE" } })).toBe(2);
    expect((await listChiefReferees(tournamentId)).map((chief) => chief.id)).toEqual([chiefAId, chiefBId]);
    const audits = await prisma.auditLog.findMany({ where: { tournamentId, action: "CHIEF_REFEREE_GRANTED" }, select: { targetId: true, actorUserId: true } });
    expect(audits).toHaveLength(2);
    expect(audits.every((item) => item.actorUserId === adminId)).toBe(true);

    // 管理员可以把自己设为裁判长。
    await expect(grantChiefReferee(adminId, slug, { userId: adminId })).resolves.toMatchObject({ granted: true });
    expect((await listChiefReferees(tournamentId)).find((chief) => chief.id === adminId)).toMatchObject({ isAdmin: true });
  });

  it("只有本赛事管理员可以授予/撤销；拒绝平台共用裁判账号、停用账号和不存在的账号", async () => {
    const { slug, tournamentId } = await published("guard");
    await grantChiefReferee(adminId, slug, { userId: chiefAId });

    // 非管理员：裁判员、裁判长本人、无角色账号。
    await expect(grantChiefReferee(refereeId, slug, { userId: chiefBId })).rejects.toMatchObject({ status: 403 });
    await expect(grantChiefReferee(chiefAId, slug, { userId: chiefBId })).rejects.toMatchObject({ status: 403 });
    await expect(revokeChiefReferee(chiefAId, slug, chiefAId)).rejects.toMatchObject({ status: 403 });
    await expect(createChiefRefereeAccount(otherAdminId, slug, { username: `x_${RUN}`, name: "x" })).rejects.toMatchObject({ status: 403 });

    await expect(grantChiefReferee(adminId, slug, { userId: refereeId })).rejects.toMatchObject({ status: 409, code: "platform_referee_not_allowed" });
    const disabledId = await newUser("disabled", { status: "DISABLED" });
    await expect(grantChiefReferee(adminId, slug, { userId: disabledId })).rejects.toMatchObject({ status: 409, code: "account_disabled" });
    await expect(grantChiefReferee(adminId, slug, { userId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    await expect(grantChiefReferee(adminId, slug, { login: `nobody-${RUN}` })).rejects.toMatchObject({ status: 404 });
    await expect(grantChiefReferee(adminId, slug, {})).rejects.toMatchObject({ status: 400 });
    await expect(grantChiefReferee(adminId, `missing-${RUN}`, { userId: chiefBId })).rejects.toMatchObject({ status: 404 });

    expect((await listChiefReferees(tournamentId)).map((chief) => chief.id)).toEqual([chiefAId]);
  });

  it("授予只在本赛事生效：别的赛事的管理员无权操作，本赛事裁判长在别的赛事没有裁判长权限", async () => {
    const one = await published("scope-a");
    const two = await published("scope-b");
    // 另一位账号只是赛事一的管理员（测试夹具直接给角色，模拟「另一赛事的管理员」）。
    await prisma.roleAssignment.create({ data: { userId: otherAdminId, tournamentId: one.tournamentId, role: "ADMIN" } });

    await grantChiefReferee(otherAdminId, one.slug, { userId: chiefAId });
    await expect(grantChiefReferee(otherAdminId, two.slug, { userId: chiefAId })).rejects.toMatchObject({ status: 403 });
    await expect(requireChiefReferee(chiefAId, one.matches[0].code)).resolves.toMatchObject({ chiefReferee: true });
    await expect(requireChiefReferee(chiefAId, two.matches[0].code)).rejects.toMatchObject({ status: 403 });

    await grantChiefReferee(adminId, two.slug, { userId: chiefAId });
    // 撤销赛事二不影响赛事一。
    await expect(revokeChiefReferee(otherAdminId, two.slug, chiefAId)).rejects.toMatchObject({ status: 403 });
    await expect(revokeChiefReferee(adminId, two.slug, chiefAId)).resolves.toMatchObject({ revoked: true });
    await expect(requireChiefReferee(chiefAId, one.matches[0].code)).resolves.toMatchObject({ chiefReferee: true });
    await expect(requireChiefReferee(chiefAId, two.matches[0].code)).rejects.toMatchObject({ status: 403 });
    await expect(revokeChiefReferee(adminId, two.slug, chiefAId)).resolves.toMatchObject({ revoked: false, revokedSessionIds: [] });
  });

  it("为本赛事开通裁判长账号：初始口令只返回一次、首次登录须改口令；用户名重复拒绝", async () => {
    const { slug, tournamentId } = await published("account");
    const username = `Chief_${RUN}`;
    const created = await createChiefRefereeAccount(adminId, slug, { username, name: "  裁判长  甲 " });
    createdUserIds.push(created.userId);
    expect(created).toMatchObject({ username, name: "裁判长 甲" });
    expect(created.initialPassword.length).toBeGreaterThanOrEqual(8);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: created.userId },
      select: { username: true, mustChangePassword: true, provisionedForTournamentId: true, platformReferee: true, accounts: { select: { password: true } } },
    });
    expect(user).toMatchObject({ username: username.toLowerCase(), mustChangePassword: true, provisionedForTournamentId: tournamentId, platformReferee: false });
    expect(user.accounts[0].password).not.toContain(created.initialPassword);
    expect(await listChiefReferees(tournamentId)).toEqual([expect.objectContaining({ id: created.userId, mustChangePassword: true })]);
    const auditMetadata = JSON.stringify(
      await prisma.auditLog.findFirstOrThrow({ where: { tournamentId, action: "CHIEF_REFEREE_ACCOUNT_CREATED" }, select: { metadata: true } }),
    );
    expect(auditMetadata).not.toContain(created.initialPassword);

    await expect(createChiefRefereeAccount(adminId, slug, { username: username.toUpperCase(), name: "重复" })).rejects.toMatchObject({ status: 409, code: "username_taken" });
    await expect(createChiefRefereeAccount(adminId, slug, { username: "a", name: "太短" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("授予后的裁判长权限与撤销后的会话吊销", () => {
  it("授予前不能接管；授予后能接管并复核锁定结果", async () => {
    const { slug, matches } = await published("confirm");
    const matchCode = matches[0].code;
    const version = await submitWalkover(matchCode);

    // 授予前没有裁判长权限。
    await expect(takeoverScoringSession(chiefAId, matchCode, randomUUID(), "复核结果")).rejects.toMatchObject({ status: 403 });

    await grantChiefReferee(adminId, slug, { userId: chiefAId });
    const chief = await takeoverScoringSession(chiefAId, matchCode, randomUUID(), "复核结果");
    await accepted(submitScoringCommand(chiefAId, matchCode, command(chief, version, "CONFIRM_RESULT", { reason: "复核通过" }), chief.controlToken));
    const match = await prisma.match.findUniqueOrThrow({ where: { code: matchCode }, select: { verificationStatus: true } });
    expect(match.verificationStatus).toBe("LOCKED");
  });

  it("撤销裁判长同一事务吊销其在本赛事的裁判长控制会话，之后命令与心跳都被拒绝", async () => {
    const { slug, matches } = await published("revoke");
    const matchCode = matches[0].code;
    const version = await submitWalkover(matchCode);
    await grantChiefReferee(adminId, slug, { userId: chiefAId });
    const chief = await takeoverScoringSession(chiefAId, matchCode, randomUUID(), "复核结果");

    const revoked = await revokeChiefReferee(adminId, slug, chiefAId);
    expect(revoked).toEqual({ userId: chiefAId, revoked: true, revokedSessionIds: [chief.sessionId] });
    const session = await prisma.scoringSession.findUniqueOrThrow({ where: { id: chief.sessionId }, select: { status: true, revokedReason: true } });
    expect(session).toEqual({ status: "REVOKED", revokedReason: "CHIEF_REFEREE_REVOKED" });

    await expect(
      submitScoringCommand(chiefAId, matchCode, command(chief, version, "CONFIRM_RESULT", { reason: "撤销后复核" }), chief.controlToken),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(heartbeatScoringSession(chiefAId, matchCode, chief.sessionId, chief.takeoverGeneration, chief.controlToken)).rejects.toMatchObject({ status: 409 });
    await expect(takeoverScoringSession(chiefAId, matchCode, randomUUID(), "再次接管")).rejects.toMatchObject({ status: 403 });
    const match = await prisma.match.findUniqueOrThrow({ where: { code: matchCode }, select: { verificationStatus: true } });
    expect(match.verificationStatus).not.toBe("LOCKED");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "CHIEF_REFEREE_REVOKED", targetId: chiefAId, tournament: { slug } }, select: { metadata: true } });
    expect(audit.metadata).toEqual({ revokedSessionIds: [chief.sessionId] });

    // 另一位裁判长不受影响，仍可接管并复核。
    await grantChiefReferee(adminId, slug, { userId: chiefBId });
    const second = await takeoverScoringSession(chiefBId, matchCode, randomUUID(), "改由另一位裁判长复核");
    await accepted(submitScoringCommand(chiefBId, matchCode, command(second, version, "CONFIRM_RESULT", { reason: "复核通过" }), second.controlToken));
  });
});

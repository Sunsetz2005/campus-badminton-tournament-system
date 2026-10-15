import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { confirmIndividualGroupRanking, recordResultOnly, reviewResultOnly } from "@/server/services/results-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

import { holdRowLock, settledWithin, waitUntilBlockedBy } from "../support/db-barrier";

/**
 * CON-001：确认小组名次与重开本组比赛结果的并发一致性。
 *
 * 不靠随机 Promise.all 碰运气，而是用第三个数据库连接做确定性屏障：
 *   1. 屏障连接锁住半决赛对阵行（确认名次回填签位时才会写它）；
 *   2. 启动「确认名次」：它读完本组全部已锁定结果、写入名次后，卡在回填签位上，尚未提交；
 *   3. 此时执行「重开本组一场比赛」；
 *   4. 放开屏障，两个事务各自完成。
 * 无论谁成功、谁失败，最终状态都必须自洽：名次已确认 ⇔ 本组比赛全部仍是锁定结果，且签位与名次一致。
 */

const RUN = randomBytes(3).toString("hex");
const createdSlugs: string[] = [];
const createdEmails: string[] = [];
let adminId = "";
let chiefId = "";

const WIN = [{ a: 21, b: 10 }, { a: 21, b: 10 }];
const LOSE = [{ a: 10, b: 21 }, { a: 10, b: 21 }];

async function publishedGroupsKnockout(name: string) {
  const slug = `con1-${RUN}-${name}`;
  createdSlugs.push(slug);
  await createTournament(adminId, {
    slug,
    name: `并发一致性 ${name}`,
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
  for (let index = 0; index < 6; index += 1) {
    const created = await createManualRegistration(adminId, slug, {
      competitionId: competition.id,
      members: [{ displayName: `选手${index + 1}`, teamName: `学院${index + 1}` }],
    });
    const registration = await prisma.registration.findUniqueOrThrow({
      where: { referenceCode: created.referenceCode },
      select: { id: true, version: true },
    });
    await reviewRegistration(adminId, slug, registration.id, { action: "APPROVE", expectedVersion: registration.version });
  }
  const draft = await generateDrawDraft(adminId, slug, "MS", { format: "GROUPS_KNOCKOUT", qualifiersPerGroup: 2 });
  await transitionTournamentPhase(adminId, slug, { to: "REGISTRATION_CLOSED" });
  await publishDraw(adminId, slug, "MS", draft.drawId, { confirm: true });
  await prisma.roleAssignment.createMany({
    data: [
      { userId: adminId, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
      { userId: chiefId, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
    ],
  });
  return { slug, competitionId: competition.id };
}

/** 本组全部比赛按「编号小者胜」补录并由第二位裁判长锁定。 */
async function lockGroupResults(slug: string, competitionId: string, groupCode: string) {
  const fixtures = await prisma.fixture.findMany({
    where: { competitionId, kind: "GROUP", group: { code: groupCode } },
    orderBy: [{ round: "asc" }, { sequence: "asc" }],
    include: { matches: true, sideAEntry: true, sideBEntry: true },
  });
  for (const item of fixtures) {
    const aWins = (item.sideAEntry?.code ?? "") < (item.sideBEntry?.code ?? "");
    const recorded = await recordResultOnly(adminId, slug, item.matches[0].code, {
      outcome: "NORMAL",
      games: aWins ? WIN : LOSE,
      reason: "纸质记分表补录",
    });
    await reviewResultOnly(chiefId, slug, item.matches[0].code, {
      action: "CONFIRM",
      expectedRevision: recorded.revision,
      reason: "核对无误",
    });
  }
  return fixtures;
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  const email = `chief-${RUN}@con001.test`;
  createdEmails.push(email);
  chiefId = (await prisma.user.create({ data: { name: `第二裁判长 ${RUN}`, email } })).id;
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

describe("CON-001 小组名次确认与结果重开的并发一致性", () => {
  it("确认名次已读结果、尚未提交时重开本组比赛：最终不得留下新旧混合状态", async () => {
    const { slug, competitionId } = await publishedGroupsKnockout("race");
    const groupFixtures = await lockGroupResults(slug, competitionId, "A");
    const reopenTarget = groupFixtures[0].matches[0].code;
    const semi = await prisma.fixture.findFirstOrThrow({
      where: { competitionId, OR: [{ sideAGroup: { code: "A" } }, { sideBGroup: { code: "A" } }] },
      select: { id: true },
    });

    const barrier = await holdRowLock("fixtures", semi.id);
    const confirm = confirmIndividualGroupRanking(chiefId, slug, "MS", "A", {});
    confirm.catch(() => undefined);
    // 确认事务此时已读完本组结果并写入名次，正等待回填半决赛签位。
    await waitUntilBlockedBy(barrier.pid);

    const reopen = reviewResultOnly(chiefId, slug, reopenTarget, { action: "REOPEN", expectedRevision: 1, reason: "更正比分" });
    reopen.catch(() => undefined);
    // 重开必须等确认事务结束：它在读“名次是否已确认”之前要取得同一把小组行锁。
    // 修复前它不等待、直接按旧值提交（2026-10-15 复现）。
    expect(await settledWithin(reopen, 1_000)).toBe(false);

    barrier.release();
    await barrier.done;
    const [confirmResult, reopenResult] = await Promise.allSettled([confirm, reopen]);

    const group = await prisma.group.findFirstOrThrow({
      where: { code: "A", stage: { competitionId } },
      select: { id: true, rankingConfirmedAt: true },
    });
    const latestRevisions = await prisma.resultRevision.findMany({
      where: { match: { fixture: { groupId: group.id } } },
      orderBy: { revision: "desc" },
      distinct: ["matchId"],
      select: { matchId: true, status: true },
    });
    const allGroupResultsLocked = latestRevisions.length === groupFixtures.length && latestRevisions.every((item) => item.status === "LOCKED");
    const slots = await prisma.fixture.findMany({
      where: { OR: [{ sideAGroupId: group.id }, { sideBGroupId: group.id }] },
      select: { sideAGroupId: true, sideAEntryId: true, sideBGroupId: true, sideBEntryId: true },
    });
    const filledFromGroup = slots.flatMap((slot) => [
      ...(slot.sideAGroupId === group.id ? [slot.sideAEntryId] : []),
      ...(slot.sideBGroupId === group.id ? [slot.sideBEntryId] : []),
    ]);

    const outcome = {
      confirm: confirmResult.status,
      reopen: reopenResult.status,
      rankingConfirmed: Boolean(group.rankingConfirmedAt),
      allGroupResultsLocked,
      filledFromGroup: filledFromGroup.filter(Boolean).length,
    };
    // 至少一方成功，否则屏障没有制造出真正的交错。
    expect(confirmResult.status === "fulfilled" || reopenResult.status === "fulfilled", JSON.stringify(outcome)).toBe(true);
    // 一致性不变量：名次已确认 ⇔ 本组结果全部仍锁定；签位只在名次确认时回填。
    expect(outcome.rankingConfirmed, JSON.stringify(outcome)).toBe(allGroupResultsLocked);
    expect(outcome.filledFromGroup, JSON.stringify(outcome)).toBe(outcome.rankingConfirmed ? filledFromGroup.length : 0);
    // 本协议下的确定结果：确认先提交，重开随后取得锁、看到已确认的名次并整体撤回。
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      confirm: "fulfilled",
      reopen: "fulfilled",
      rankingConfirmed: false,
      allGroupResultsLocked: false,
      filledFromGroup: 0,
    });
  });
});

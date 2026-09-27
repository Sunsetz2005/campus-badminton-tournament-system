import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand } from "@/domain/rules/match-engine";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import {
  computeResultImpact,
  confirmIndividualGroupRanking,
  getResultImpact,
  loadCompetitionResults,
  publishStandings,
  recordResultDisposition,
  recordResultOnly,
  reviewResultOnly,
  setRankingExclusion,
} from "@/server/services/results-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { acquireScoringSession, releaseScoringSession, takeoverScoringSession } from "@/server/services/scoring-session-service";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

const RUN = randomBytes(3).toString("hex");
const createdSlugs: string[] = [];
const createdEmails: string[] = [];
let adminId = "";
let refereeId = "";
/** 第二位裁判长：仅结果记录必须由补录人以外的人独立复核。 */
let chiefId = "";
let commandSeq = 0;

async function newTournament(name: string, entryCount: number) {
  const slug = `t6-${RUN}-${name}`;
  createdSlugs.push(slug);
  await createTournament(adminId, {
    slug,
    name: `成绩名次测试 ${name}`,
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
  return { slug, tournamentId: tournament.id, competitionId: competition.id };
}

async function published(name: string, entryCount: number, settings: Record<string, unknown>) {
  const created = await newTournament(name, entryCount);
  const draft = await generateDrawDraft(adminId, created.slug, "MS", settings);
  await transitionTournamentPhase(adminId, created.slug, { to: "REGISTRATION_CLOSED" });
  await publishDraw(adminId, created.slug, "MS", draft.drawId, { confirm: true });
  await prisma.roleAssignment.createMany({
    data: [
      { userId: refereeId, tournamentId: created.tournamentId, role: "REFEREE" },
      { userId: adminId, tournamentId: created.tournamentId, role: "CHIEF_REFEREE" },
      { userId: chiefId, tournamentId: created.tournamentId, role: "CHIEF_REFEREE" },
    ],
  });
  return created;
}

async function fixture(competitionId: string, code: string) {
  return prisma.fixture.findFirstOrThrow({
    where: { competitionId, code },
    include: { matches: true, sideAEntry: true, sideBEntry: true },
  });
}

async function groupFixtures(competitionId: string, groupCode: string) {
  return prisma.fixture.findMany({
    where: { competitionId, kind: "GROUP", group: { code: groupCode } },
    orderBy: [{ round: "asc" }, { sequence: "asc" }],
    include: { matches: true, sideAEntry: true, sideBEntry: true },
  });
}

const WIN = [{ a: 21, b: 10 }, { a: 21, b: 10 }];
const LOSE = [{ a: 10, b: 21 }, { a: 10, b: 21 }];

/** 管理员补录、第二位裁判长复核锁定一场仅结果记录。 */
async function resultOnly(slug: string, matchCode: string, input: Record<string, unknown>) {
  const recorded = await recordResultOnly(adminId, slug, matchCode, { reason: "纸质记分表补录", ...input });
  await reviewResultOnly(chiefId, slug, matchCode, { action: "CONFIRM", expectedRevision: recorded.revision, reason: "核对记分表无误" });
  return recorded.revision;
}

/** 编号小者胜：组内名次严格按报名编号，不出现同分。 */
async function playGroupByCode(slug: string, competitionId: string, groupCode: string) {
  for (const item of await groupFixtures(competitionId, groupCode)) {
    const aWins = (item.sideAEntry?.code ?? "") < (item.sideBEntry?.code ?? "");
    await resultOnly(slug, item.matches[0].code, { outcome: "NORMAL", games: aWins ? WIN : LOSE });
  }
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

/** 裁判台路径：主裁判记录弃权并提交，裁判长接管后复核锁定。返回锁定命令信封，便于重放。 */
async function liveWalkover(matchId: string, winnerSide: "A" | "B") {
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId }, select: { code: true } });
  await prisma.officialAssignment.upsert({
    where: { matchId_userId_role: { matchId, userId: refereeId, role: "MAIN_REFEREE" } },
    create: { matchId, userId: refereeId },
    update: {},
  });
  const control = await acquireScoringSession(refereeId, match.code, randomUUID());
  let version = (await accepted(
    submitScoringCommand(refereeId, match.code, command(control, (await prisma.match.findUniqueOrThrow({ where: { id: matchId } })).version, "RECORD_SPECIAL_OUTCOME", { type: "WO", winnerSide, reason: "对方未到" }), control.controlToken),
  )).version;
  version = (await accepted(submitScoringCommand(refereeId, match.code, command(control, version, "SUBMIT_RESULT", { reason: "提交弃权结果" }), control.controlToken))).version;
  const chief = await takeoverScoringSession(adminId, match.code, randomUUID(), "复核结果");
  const confirm = command(chief, version, "CONFIRM_RESULT", { reason: "复核通过" });
  version = (await accepted(submitScoringCommand(adminId, match.code, confirm, chief.controlToken))).version;
  return { code: match.code, chief, version, confirm };
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
  const email = `chief-${RUN}@results.test`;
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

describe("仅结果记录", () => {
  it("校验逐局比分；只写结果、不伪造回合；补录人不能自己复核；不能再在裁判台记分", async () => {
    const { slug, competitionId } = await published("record", 3, { format: "ROUND_ROBIN" });
    const [first] = await groupFixtures(competitionId, "A");
    const matchCode = first.matches[0].code;

    await expect(recordResultOnly(adminId, slug, matchCode, { outcome: "NORMAL", games: [{ a: 25, b: 20 }, { a: 21, b: 10 }], reason: "补录" }))
      .rejects.toMatchObject({ code: "invalid_result" });
    await expect(recordResultOnly(adminId, slug, matchCode, { outcome: "WO", winnerSide: "A", games: [{ a: 21, b: 0 }, { a: 21, b: 0 }], reason: "补录" }))
      .rejects.toMatchObject({ code: "invalid_result", message: expect.stringContaining("不补任何比分") });
    await expect(recordResultOnly(refereeId, slug, matchCode, { outcome: "NORMAL", games: WIN, reason: "补录" }))
      .rejects.toMatchObject({ status: 403 });
    await expect(recordResultOnly(adminId, slug, matchCode, { outcome: "NORMAL", games: WIN, reason: "" }))
      .rejects.toMatchObject({ code: "reason_required" });

    const recorded = await recordResultOnly(adminId, slug, matchCode, { outcome: "NORMAL", games: [{ a: 21, b: 18 }, { a: 17, b: 21 }, { a: 23, b: 21 }], reason: "纸质记分表 07 号" });
    const match = await prisma.match.findUniqueOrThrow({
      where: { code: matchCode },
      include: { games: { orderBy: { number: "asc" } }, events: true, resultRevisions: true },
    });
    expect(match).toMatchObject({ resultSource: "RESULT_ONLY", lifecycleStatus: "SUBMITTED", verificationStatus: "PENDING_REVIEW", outcomeType: "NORMAL", version: 0 });
    expect(match.events).toHaveLength(0);
    expect(match.games.map((game) => [game.scoreA, game.scoreB])).toEqual([[21, 18], [17, 21], [23, 21]]);
    expect(match.resultRevisions[0]).toMatchObject({ source: "RESULT_ONLY", status: "PENDING", revision: 1 });

    // 数据库兜底：仅结果记录的比赛不能再写入记分事件。
    await expect(
      prisma.matchEvent.create({ data: { matchId: match.id, version: 1, type: "COIN_TOSS", payload: {} } }),
    ).rejects.toThrow();
    await prisma.officialAssignment.create({ data: { matchId: match.id, userId: refereeId } });
    await expect(acquireScoringSession(refereeId, matchCode, randomUUID())).rejects.toMatchObject({ code: "result_only_match" });

    await expect(reviewResultOnly(adminId, slug, matchCode, { action: "CONFIRM", expectedRevision: 1, reason: "自己复核" }))
      .rejects.toMatchObject({ code: "independent_review_required" });
    await expect(reviewResultOnly(refereeId, slug, matchCode, { action: "CONFIRM", expectedRevision: 1, reason: "越权" }))
      .rejects.toMatchObject({ status: 403 });
    await reviewResultOnly(chiefId, slug, matchCode, { action: "CONFIRM", expectedRevision: recorded.revision, reason: "核对无误" });
    await expect(reviewResultOnly(chiefId, slug, matchCode, { action: "CONFIRM", expectedRevision: recorded.revision, reason: "重复确认" }))
      .rejects.toMatchObject({ code: "not_pending" });
    const locked = await fixture(competitionId, first.code);
    expect(locked.matches[0].verificationStatus).toBe("LOCKED");
    expect(locked.winnerEntryId).toBe(locked.sideAEntryId);
  });

  it("退回后比赛回到未开始，可重新补录；修订历史保留", async () => {
    const { slug, competitionId } = await published("return", 3, { format: "ROUND_ROBIN" });
    const [first] = await groupFixtures(competitionId, "A");
    const matchCode = first.matches[0].code;
    await recordResultOnly(adminId, slug, matchCode, { outcome: "NORMAL", games: WIN, reason: "补录" });
    await reviewResultOnly(chiefId, slug, matchCode, { action: "RETURN", expectedRevision: 1, reason: "胜方写反" });
    await expect(prisma.match.findUniqueOrThrow({ where: { code: matchCode } })).resolves.toMatchObject({
      resultSource: "LIVE",
      lifecycleStatus: "SCHEDULED",
      verificationStatus: "UNVERIFIED",
      outcomeType: null,
    });
    const again = await recordResultOnly(adminId, slug, matchCode, { outcome: "NORMAL", games: LOSE, reason: "按记分表更正" });
    expect(again.revision).toBe(2);
    const revisions = await prisma.resultRevision.findMany({ where: { match: { code: matchCode } }, orderBy: { revision: "asc" } });
    expect(revisions.map((item) => item.status)).toEqual(["RETURNED", "PENDING"]);
  });
});

describe("个人项目小组名次", () => {
  it("未确认结果只有暂定榜；完全同分须按抽签顺序并写明依据才能确认", async () => {
    const { slug, tournamentId, competitionId } = await published("lots", 3, { format: "ROUND_ROBIN" });
    const fixtures = await groupFixtures(competitionId, "A");
    // 三方循环相胜且每场都是 2—0、21:10，胜场、净胜局、净胜分全部相同。
    expect(fixtures).toHaveLength(3);
    await recordResultOnly(adminId, slug, fixtures[0].matches[0].code, { outcome: "NORMAL", games: WIN, reason: "补录" });

    let loaded = await loadCompetitionResults(prisma, tournamentId, "MS");
    expect(loaded?.results?.groups[0].ranking.status).toBe("PROVISIONAL");
    expect(loaded?.results?.groups[0].ranking.countedMatchCodes).toEqual([]);
    await expect(confirmIndividualGroupRanking(chiefId, slug, "MS", "A", {})).rejects.toMatchObject({ code: "ranking_not_confirmable" });

    await reviewResultOnly(chiefId, slug, fixtures[0].matches[0].code, { action: "CONFIRM", expectedRevision: 1, reason: "核对" });
    // 构造循环：第 1 场 A 胜；另外两场让「第 1 场的负者」胜「第三人」、「第三人」胜「第 1 场的胜者」。
    const winner = fixtures[0].sideAEntryId as string;
    const loser = fixtures[0].sideBEntryId as string;
    for (const item of fixtures.slice(1)) {
      const sides = [item.sideAEntryId, item.sideBEntryId];
      const beatsA = sides.includes(loser) ? item.sideAEntryId === loser : item.sideAEntryId !== winner;
      await resultOnly(slug, item.matches[0].code, { outcome: "NORMAL", games: beatsA ? WIN : LOSE });
    }
    loaded = await loadCompetitionResults(prisma, tournamentId, "MS");
    const ranking = loaded!.results!.groups[0].ranking;
    expect(ranking.status).toBe("NEEDS_DECISION");
    expect(ranking.unresolved[0]).toHaveLength(3);
    expect(ranking.rows.every((row) => row.position === 1 && row.won === 1 && row.netGames === 0 && row.netPoints === 0)).toBe(true);

    await expect(confirmIndividualGroupRanking(refereeId, slug, "MS", "A", {})).rejects.toMatchObject({ status: 403 });
    await expect(confirmIndividualGroupRanking(chiefId, slug, "MS", "A", {})).rejects.toMatchObject({ code: "ranking_not_confirmable" });
    const lotsOrder = [...ranking.unresolved[0]].reverse();
    await expect(confirmIndividualGroupRanking(chiefId, slug, "MS", "A", { order: lotsOrder })).rejects.toMatchObject({ code: "reason_required" });
    await confirmIndividualGroupRanking(chiefId, slug, "MS", "A", { order: lotsOrder, reason: "11月2日 10:00 裁判长主持抽签，双方领队见证" });
    await expect(confirmIndividualGroupRanking(chiefId, slug, "MS", "A", { order: lotsOrder })).rejects.toMatchObject({ code: "ranking_confirmed" });

    loaded = await loadCompetitionResults(prisma, tournamentId, "MS");
    expect(loaded!.results!.placements.map((item) => [item.entryId, item.label])).toEqual(lotsOrder.map((id, index) => [id, `第 ${index + 1} 名`]));
    expect(loaded!.results!.placementsComplete).toBe(true);
  });

  it("特殊结果阻止正式名次；裁判长排除不能完成比赛的单位后才能确认，原比赛保留", async () => {
    const { slug, tournamentId, competitionId } = await published("special", 4, { format: "ROUND_ROBIN" });
    const fixtures = await groupFixtures(competitionId, "A");
    const withdrawn = fixtures[0].sideBEntryId as string;
    for (const item of fixtures) {
      const involves = item.sideAEntryId === withdrawn || item.sideBEntryId === withdrawn;
      if (involves) {
        await resultOnly(slug, item.matches[0].code, { outcome: "WO", winnerSide: item.sideAEntryId === withdrawn ? "B" : "A" });
      } else {
        const aWins = (item.sideAEntry?.code ?? "") < (item.sideBEntry?.code ?? "");
        await resultOnly(slug, item.matches[0].code, { outcome: "NORMAL", games: aWins ? WIN : LOSE });
      }
    }
    let ranking = (await loadCompetitionResults(prisma, tournamentId, "MS"))!.results!.groups[0].ranking;
    expect(ranking.status).toBe("BLOCKED");
    expect(ranking.blockers).toHaveLength(3);
    await expect(confirmIndividualGroupRanking(chiefId, slug, "MS", "A", {})).rejects.toMatchObject({ code: "ranking_not_confirmable" });

    await expect(setRankingExclusion(chiefId, slug, "MS", "A", { entryId: withdrawn, action: "ADD", reason: "" })).rejects.toMatchObject({ code: "reason_required" });
    await expect(setRankingExclusion(refereeId, slug, "MS", "A", { entryId: withdrawn, action: "ADD", reason: "x" })).rejects.toMatchObject({ status: 403 });
    await setRankingExclusion(chiefId, slug, "MS", "A", { entryId: withdrawn, action: "ADD", reason: "赛前伤病弃权，不能完成本组比赛" });
    ranking = (await loadCompetitionResults(prisma, tournamentId, "MS"))!.results!.groups[0].ranking;
    expect(ranking.status).toBe("READY");
    expect(ranking.rows).toHaveLength(3);
    expect(ranking.excludedMatchCodes).toHaveLength(3);
    await confirmIndividualGroupRanking(chiefId, slug, "MS", "A", {});
    await expect(setRankingExclusion(chiefId, slug, "MS", "A", { entryId: withdrawn, action: "REMOVE" })).rejects.toMatchObject({ code: "ranking_confirmed" });
    // 原比赛与比分都还在。
    await expect(prisma.match.count({ where: { fixture: { competitionId }, outcomeType: "WO", verificationStatus: "LOCKED" } })).resolves.toBe(3);
    const placements = (await loadCompetitionResults(prisma, tournamentId, "MS"))!.results!.placements;
    expect(placements.find((item) => item.entryId === withdrawn)?.label).toBe("排除，不计名次");
  });
});

describe("晋级、重复确认与结果更正", () => {
  it("小组名次回填签位；淘汰胜者晋级且重复确认只生效一次；下游未开赛可重开撤回，已开赛则阻止并登记人工处置；更正后榜单需重发", async () => {
    const { slug, tournamentId, competitionId } = await published("ko", 6, { format: "GROUPS_KNOCKOUT", qualifiersPerGroup: 2, thirdPlaceMatch: true });
    await playGroupByCode(slug, competitionId, "A");
    await playGroupByCode(slug, competitionId, "B");
    await confirmIndividualGroupRanking(chiefId, slug, "MS", "A", {});
    await confirmIndividualGroupRanking(chiefId, slug, "MS", "B", {});

    const groupA = await groupFixtures(competitionId, "A");
    const groupB = await groupFixtures(competitionId, "B");
    const orderOf = (fixtures: typeof groupA) =>
      [...new Map(fixtures.flatMap((item) => [item.sideAEntry!, item.sideBEntry!]).map((entry) => [entry.id, entry])).values()]
        .sort((left, right) => left.code.localeCompare(right.code))
        .map((entry) => entry.id);
    const [a1, a2, a3] = orderOf(groupA);
    const [b1, b2] = orderOf(groupB);
    let sf1 = await fixture(competitionId, "SF1");
    let sf2 = await fixture(competitionId, "SF2");
    expect([sf1.sideAEntryId, sf1.sideBEntryId]).toEqual([a1, b2]);
    expect([sf2.sideAEntryId, sf2.sideBEntryId]).toEqual([b1, a2]);

    const v1 = await publishStandings(adminId, slug, "MS", { note: "小组赛名次" });
    expect(v1.version).toBe(1);
    await expect(publishStandings(adminId, slug, "MS", {})).rejects.toMatchObject({ code: "standings_unchanged" });
    await expect(publishStandings(refereeId, slug, "MS", {})).rejects.toMatchObject({ status: 403 });
    let loaded = (await loadCompetitionResults(prisma, tournamentId, "MS"))!.results!;
    expect(loaded.needsRepublish).toBe(false);
    expect(loaded.placements.find((item) => item.entryId === a3)?.label).toBe("A 组未出线");

    // SF1：裁判台弃权结果，裁判长复核锁定 → 胜者进入决赛、负者进入三四名赛。
    const live = await liveWalkover(sf1.matches[0].id, "A");
    const final = await fixture(competitionId, "F");
    const third = await fixture(competitionId, "3P");
    expect(final.sideAEntryId).toBe(a1);
    expect(third.sideAEntryId).toBe(b2);

    // 重复确认（同一 commandId 重放）：返回原结果，不会再次晋级。
    const replay = (await submitScoringCommand(adminId, live.code, live.confirm, live.chief.controlToken)) as { status: string };
    expect(replay.status).toBe("duplicate");
    await expect(prisma.auditLog.count({ where: { action: "RESULT_ADVANCED", targetId: sf1.id } })).resolves.toBe(1);
    await expect(prisma.fixture.count({ where: { competitionId } })).resolves.toBe(6 + 4);

    // 决赛未开赛：影响预览可见，且可以受控重开撤回。
    await expect(recordResultDisposition(chiefId, slug, live.code, { decision: "MAINTAIN", reason: "维持" })).rejects.toMatchObject({ code: "correction_not_blocked" });
    await expect(getResultImpact(refereeId, live.code, "REOPEN")).rejects.toMatchObject({ status: 403 });
    const preview = await getResultImpact(adminId, live.code, "REOPEN");
    expect(preview.blocked).toBe(false);
    expect(preview.effects.join("\n")).toContain("撤回");
    expect(preview.effects.join("\n")).toContain("F");
    const reopened = await accepted(submitScoringCommand(adminId, live.code, command(live.chief, live.version, "REOPEN_RESULT", { reason: "核对签表发现弃权方记错" }), live.chief.controlToken));
    expect((await fixture(competitionId, "F")).sideAEntryId).toBeNull();
    expect((await fixture(competitionId, "3P")).sideAEntryId).toBeNull();
    expect((await fixture(competitionId, "SF1")).winnerEntryId).toBeNull();

    // 裁判长释放控制，主裁判重新提交，裁判长再次复核锁定。
    await releaseScoringSession(adminId, live.code, live.chief.sessionId, live.chief.takeoverGeneration, live.chief.controlToken);
    const control = await acquireScoringSession(refereeId, live.code, randomUUID());
    let version = (await accepted(submitScoringCommand(refereeId, live.code, command(control, reopened.version, "SUBMIT_RESULT", { reason: "重新提交" }), control.controlToken))).version;
    const chief = await takeoverScoringSession(adminId, live.code, randomUUID(), "复核");
    version = (await accepted(submitScoringCommand(adminId, live.code, command(chief, version, "CONFIRM_RESULT", { reason: "复核通过" }), chief.controlToken))).version;
    expect((await fixture(competitionId, "F")).sideAEntryId).toBe(a1);

    // SF2 用仅结果记录：b1 胜。
    sf2 = await fixture(competitionId, "SF2");
    await resultOnly(slug, sf2.matches[0].code, { outcome: "NORMAL", games: WIN });
    expect((await fixture(competitionId, "F")).sideBEntryId).toBe(b1);
    expect((await fixture(competitionId, "3P")).sideBEntryId).toBe(a2);

    // 决赛已开始（已有待复核的结果）：重开 SF1 必须被阻止，不悄悄换掉决赛选手。
    const finalMatch = (await fixture(competitionId, "F")).matches[0];
    const finalRevision = (await recordResultOnly(adminId, slug, finalMatch.code, { outcome: "NORMAL", games: LOSE, reason: "决赛记分表" })).revision;
    const blocked = await computeResultImpact(prisma, sf1.matches[0].id, "REOPEN");
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockers.join("\n")).toContain("F");
    await expect(
      submitScoringCommand(adminId, live.code, command(chief, version, "REOPEN_RESULT", { reason: "再次更正" }), chief.controlToken),
    ).rejects.toMatchObject({ code: "downstream_started" });
    sf1 = await fixture(competitionId, "SF1");
    expect(sf1.matches[0].verificationStatus).toBe("LOCKED");
    expect((await fixture(competitionId, "F")).sideAEntryId).toBe(a1);
    const disposition = await recordResultDisposition(chiefId, slug, live.code, { decision: "MAINTAIN", reason: "决赛已开打，维持半决赛原结果并记录争议" });
    expect(disposition.decision).toBe("MAINTAIN");
    await expect(prisma.resultDisposition.findUniqueOrThrow({ where: { id: disposition.id } })).resolves.toMatchObject({
      decision: "MAINTAIN",
      blockedBy: expect.arrayContaining([expect.stringContaining("F")]),
    });

    // 小组比赛在淘汰赛开打后也不能自动更正：会撤回名次并改写半决赛签位。
    const groupMatch = groupA[0].matches[0];
    await expect(
      reviewResultOnly(chiefId, slug, groupMatch.code, { action: "REOPEN", expectedRevision: 1, reason: "更正比分" }),
    ).rejects.toMatchObject({ code: "downstream_started" });
    await expect(prisma.group.findFirstOrThrow({ where: { code: "A", stage: { competitionId } } })).resolves.toMatchObject({ rankingConfirmedAt: expect.any(Date) });

    // 决赛与三四名赛结束：决出前四名，榜单需要重新发布。
    await reviewResultOnly(chiefId, slug, finalMatch.code, { action: "CONFIRM", expectedRevision: finalRevision, reason: "复核" });
    await resultOnly(slug, (await fixture(competitionId, "3P")).matches[0].code, { outcome: "NORMAL", games: WIN });
    loaded = (await loadCompetitionResults(prisma, tournamentId, "MS"))!.results!;
    expect(loaded.needsRepublish).toBe(true);
    expect(loaded.placements.slice(0, 4).map((item) => [item.entryId, item.label])).toEqual([
      [b1, "冠军"],
      [a1, "亚军"],
      [b2, "季军"],
      [a2, "第 4 名"],
    ]);
    expect(loaded.placementsComplete).toBe(true);
    await publishStandings(chiefId, slug, "MS", { note: "最终名次" });

    // 决赛结果更正（没有后续比赛）：撤回冠亚军，榜单再次标记需重发，历史版本保留。
    const finalImpact = await getResultImpact(adminId, finalMatch.code, "REOPEN");
    expect(finalImpact.blocked).toBe(false);
    expect(finalImpact.effects.join("\n")).toContain("需重新发布");
    await reviewResultOnly(chiefId, slug, finalMatch.code, { action: "REOPEN", expectedRevision: finalRevision, reason: "记分表胜方抄错" });
    loaded = (await loadCompetitionResults(prisma, tournamentId, "MS"))!.results!;
    expect(loaded.needsRepublish).toBe(true);
    expect(loaded.placements.find((item) => item.entryId === b1)?.label).toBe("名次待定");
    expect(loaded.publications.map((item) => item.version)).toEqual([2, 1]);
    await resultOnly(slug, finalMatch.code, { outcome: "NORMAL", games: WIN });
    loaded = (await loadCompetitionResults(prisma, tournamentId, "MS"))!.results!;
    expect(loaded.placements[0]).toMatchObject({ entryId: a1, label: "冠军" });
    const v3 = await publishStandings(adminId, slug, "MS", { note: "更正决赛结果后重新发布" });
    expect(v3.version).toBe(3);
    await expect(prisma.standingsPublication.count({ where: { competitionId } })).resolves.toBe(3);
  });
});

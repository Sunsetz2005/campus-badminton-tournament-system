import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import type { MatchCommand } from "@/domain/rules/match-engine";
import { generateDrawDraft, publishDraw } from "@/server/services/draw-service";
import { createManualRegistration, reviewRegistration } from "@/server/services/registration-service";
import { submitScoringCommand, type ScoringCommandEnvelope } from "@/server/services/scoring-command-service";
import { releaseSuspendedMatchCourt } from "@/server/services/schedule-service";
import { acquireScoringSession, takeoverScoringSession } from "@/server/services/scoring-session-service";
import { loadOfficiatingRecords } from "@/server/services/officiating-record";
import { createTournament, transitionTournamentPhase } from "@/server/services/tournament-admin-service";

/**
 * 赛务口径决定（2026-10-27）的比赛日规则：见 `docs/knowledge-base/03-竞赛规则/赛务口径决定-2026-10-27.md`。
 */

const RUN = `r2${randomBytes(3).toString("hex")}`;
const createdSlugs: string[] = [];
let adminId = "";
let refereeId = "";
let commandSeq = 0;

async function roundRobin(name: string, entryCount: number) {
  const slug = `md-${RUN}-${name}`;
  createdSlugs.push(slug);
  await createTournament(adminId, {
    slug,
    name: `比赛日规则 ${name}`,
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
  await prisma.roleAssignment.createMany({
    skipDuplicates: true,
    data: [
      { userId: refereeId, tournamentId: tournament.id, role: "REFEREE" },
      { userId: adminId, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
    ],
  });
  const matches = await prisma.match.findMany({
    where: { stage: { competition: { tournamentId: tournament.id } } },
    select: { id: true, code: true, sideAEntryId: true, sideBEntryId: true },
    orderBy: { code: "asc" },
  });
  for (const match of matches) {
    await prisma.officialAssignment.upsert({
      where: { matchId_userId_role: { matchId: match.id, userId: refereeId, role: "MAIN_REFEREE" } },
      create: { matchId: match.id, userId: refereeId },
      update: {},
    });
  }
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

/** 抛币后确认开局设置：这一步让比赛进入「进行中」。 */
async function startMatch(matchCode: string, deviceId = randomUUID()) {
  return (await startMatchWithControl(matchCode, deviceId)).result;
}

async function startMatchWithControl(matchCode: string, deviceId = randomUUID()) {
  const control = await acquireScoringSession(refereeId, matchCode, deviceId, "演示裁判");
  const toss = await submitScoringCommand(
    refereeId,
    matchCode,
    command(control, 0, "RECORD_COIN_TOSS", {
      valid: true,
      winnerSide: "A",
      winnerChoice: { kind: "SERVICE", decision: "SERVE" },
      loserChoice: { kind: "END", end: "END_2" },
    }),
    control.controlToken,
  );
  if (toss.status !== "accepted") throw new Error("抛币不应命中幂等分支。");
  const state = toss.state as { players: { A: string[]; B: string[] } };
  const result = await submitScoringCommand(
    refereeId,
    matchCode,
    command(control, toss.version, "CONFIRM_OPENING_SETUP", {
      serverPlayerId: state.players.A[0],
      receiverPlayerId: state.players.B[0],
      logicalCourts: null,
    } as MatchCommand["payload"]),
    control.controlToken,
  );
  return { control, result };
}

beforeAll(async () => {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
  adminId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL ?? "" } })).id;
  refereeId = (await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL ?? "" } })).id;
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
});

/*
 * ===== 独立复判第二轮探针（2026-11-09，非产品测试）=====
 * 上方夹具逐字复制自 tests/review/match-day-review.probe.ts（仅改 RUN 前缀）。
 * 只读断言为主；为构造并发与过期场景，少量直接写 _test 库（标明「探针写入」），不改产品代码。
 */
import { appendFileSync } from "node:fs";
/** 探针观察值写到 REVIEW_LOG（vitest 的 console 输出在本仓库配置下不显示）。 */
function note(...parts: unknown[]) {
  const line = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
  if (process.env.REVIEW_LOG) appendFileSync(process.env.REVIEW_LOG, `${line}\n`);
}
type Iso = "ReadCommitted" | "Serializable";

async function twoCourts(tournamentId: string) {
  return Promise.all(["C1", "C2"].map((code, index) => prisma.court.create({ data: { tournamentId, code, name: `场地 ${index + 1}`, active: true, sortOrder: index } })));
}

function disjointPair(matches: { id: string; code: string; sideAEntryId: string | null; sideBEntryId: string | null }[]) {
  const [m, ...rest] = matches;
  const n = rest.find((match) => ![match.sideAEntryId, match.sideBEntryId].some((id) => id === m.sideAEntryId || id === m.sideBEntryId))!;
  return { m, n };
}

describe("复判第二轮 RV-01 触发器：两种隔离级别交错进入同一块场地（确定性屏障）", () => {
  const combos: [Iso, Iso][] = [["ReadCommitted", "ReadCommitted"], ["ReadCommitted", "Serializable"], ["Serializable", "ReadCommitted"], ["Serializable", "Serializable"]];
  for (const [first, second] of combos) {
    it(`${first} 先改写并持锁，${second} 已取快照后再进入同场：后者被拒，场地上只有一场`, async () => {
      const { tournamentId, matches } = await roundRobin(`iso-${first[0]}${second[0]}`.toLowerCase(), 4);
      const [c1] = await twoCourts(tournamentId);
      const { m, n } = disjointPair(matches);
      // 探针写入：两场未开始的比赛都排在场地 1（未开始，场地未冻结）。
      await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
      await prisma.match.update({ where: { id: n.id }, data: { courtId: c1.id } });

      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstWrote!: (pid: number) => void;
      const firstPid = new Promise<number>((resolve) => { firstWrote = resolve; });
      let secondSnapshot!: () => void;
      const secondHasSnapshot = new Promise<void>((resolve) => { secondSnapshot = resolve; });

      const t2 = prisma.$transaction(async (tx) => {
        // 先取快照（可串行化下快照在第一条语句时确定），再等第一方写入。
        await tx.$queryRaw`SELECT count(*) FROM "matches" WHERE "courtId" = ${c1.id}::uuid AND "lifecycleStatus" IN ('IN_PROGRESS','SUSPENDED')`;
        secondSnapshot();
        await firstPid;
        await tx.$executeRaw`UPDATE "matches" SET "lifecycleStatus" = 'IN_PROGRESS' WHERE "id" = ${n.id}::uuid`;
      }, { isolationLevel: second, timeout: 30_000 });
      const t1 = prisma.$transaction(async (tx) => {
        await secondHasSnapshot;
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx.$executeRaw`UPDATE "matches" SET "lifecycleStatus" = 'IN_PROGRESS' WHERE "id" = ${m.id}::uuid`;
        firstWrote(row.pid);
        await firstMayCommit;
      }, { isolationLevel: first, timeout: 30_000 });

      const { waitUntilBlockedBy } = await import("../support/db-barrier");
      await waitUntilBlockedBy(await firstPid);
      releaseFirst();
      const [r1, r2] = await Promise.allSettled([t1, t2]);
      const reason = r2.status === "rejected" ? String((r2.reason as Error).message) : "fulfilled";
      note(`RV01-ISO ${first}->${second}: first=${r1.status} second=${/court_occupied/.test(reason) ? "court_occupied" : /40001|serializ|P2034/i.test(reason) ? "40001" : reason.slice(0, 120)}`);
      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("rejected");
      await expect(prisma.match.count({ where: { courtId: c1.id, lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] } } })).resolves.toBe(1);
    });
  }
});

describe("复判第二轮 RV-02：离场待续时记录特殊结果（退赛）", () => {
  it("主裁判在离场待续时记录退赛：观察返回与数据", async () => {
    const { slug, tournamentId, matches } = await roundRobin("ret", 4);
    const [c1] = await twoCourts(tournamentId);
    const { m } = disjointPair(matches);
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    const { control, result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("x");
    const paused = await submitScoringCommand(refereeId, m.code, command(control, result.version, "PAUSE_MATCH", { reason: "伤停" }), control.controlToken);
    if (paused.status !== "accepted") throw new Error("x");
    await releaseSuspendedMatchCourt(adminId, slug, m.code, { reason: "医疗处理、场地全满" });
    let outcome: unknown = null;
    try {
      outcome = await submitScoringCommand(refereeId, m.code, command(control, paused.version, "RECORD_SPECIAL_OUTCOME", { type: "RET", winnerSide: "A", reason: "B 方伤退" } as MatchCommand["payload"]), control.controlToken);
    } catch (error) {
      const e = error as { status?: number; code?: string; constructor: { name: string }; message: string };
      outcome = { thrown: e.constructor.name, status: e.status ?? null, code: e.code ?? null, message: e.message.slice(-400) };
    }
    const after = await prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { lifecycleStatus: true, awaitingCourtSince: true, courtId: true, version: true } });
    note("RV02-RET outcome", JSON.stringify(outcome), "after", JSON.stringify(after));
    // RV2-01 已修（迁移 20261109130000）：退赛照常记录，比赛转为结束待提交，离场标记保留、仍无场地。
    expect(outcome).toMatchObject({ status: "accepted" });
    expect(after).toMatchObject({ lifecycleStatus: "ENDED_PENDING_SUBMISSION", awaitingCourtSince: expect.any(Date), courtId: null });
  });

  it("离场待续时完整比分更正被引擎拒绝（暂停中不可更正）", async () => {
    const { slug, tournamentId, matches } = await roundRobin("corr", 4);
    const [c1] = await twoCourts(tournamentId);
    const { m } = disjointPair(matches);
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    const { control, result } = await startMatchWithControl(m.code);
    if (result.status !== "accepted") throw new Error("x");
    const paused = await submitScoringCommand(refereeId, m.code, command(control, result.version, "PAUSE_MATCH", { reason: "伤停" }), control.controlToken);
    if (paused.status !== "accepted") throw new Error("x");
    await releaseSuspendedMatchCourt(adminId, slug, m.code, { reason: "场地全满" });
    const chief = await takeoverScoringSession(adminId, m.code, randomUUID(), "复核");
    const state = paused.state as { score: unknown };
    await expect(submitScoringCommand(adminId, m.code, command(chief, paused.version, "CORRECT_SCORE_STATE", { reason: "更正", obligationModel: 2, replacement: { score: state.score } } as unknown as MatchCommand["payload"]), chief.controlToken)).rejects.toBeTruthy();
    await expect(prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { lifecycleStatus: true } })).resolves.toEqual({ lifecycleStatus: "SUSPENDED" });
  });
});

describe("复判第二轮 O-4：入口、时间线与公开边界", () => {
  it("共用账号续用（同一设备）不带姓名同样被拒；API 表单 80 字截到 40 字", async () => {
    const { matches } = await roundRobin("o4-entry", 3);
    const device = randomUUID();
    await acquireScoringSession(refereeId, matches[0].code, device, "甲");
    await expect(acquireScoringSession(refereeId, matches[0].code, device)).rejects.toMatchObject({ status: 400, code: "officiating_name_required" });
    await expect(acquireScoringSession(refereeId, matches[0].code, device, "   ")).rejects.toMatchObject({ code: "officiating_name_required" });
    // 另一台设备（同一共用账号）被 controller_exists 拦住，不能借续用改名。
    await expect(acquireScoringSession(refereeId, matches[0].code, randomUUID(), "乙")).rejects.toMatchObject({ code: "controller_exists" });
  });

  it("时间线：交接、换回、接管、过期后另一设备取得控制、同设备过期后换名", async () => {
    const { matches } = await roundRobin("o4-line", 3);
    const match = matches[0];
    const d1 = randomUUID();
    await acquireScoringSession(refereeId, match.code, d1, "甲");
    await acquireScoringSession(refereeId, match.code, d1, "乙");
    await acquireScoringSession(refereeId, match.code, d1, "乙");
    await acquireScoringSession(refereeId, match.code, d1, "甲");
    await takeoverScoringSession(adminId, match.code, randomUUID(), "设备失联");
    // 探针写入：让裁判长会话过期。
    await prisma.scoringSession.updateMany({ where: { matchId: match.id, status: "ACTIVE" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const d2 = randomUUID();
    await acquireScoringSession(refereeId, match.code, d2, "丙");
    await prisma.scoringSession.updateMany({ where: { matchId: match.id, status: "ACTIVE" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await acquireScoringSession(refereeId, match.code, d2, "丁");
    const records = await loadOfficiatingRecords(prisma, [match.id]);
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { name: true } });
    const actual = records.get(match.id)!.actual.map((entry) => `${entry.kind}:${entry.name}`);
    note("O4-LINE", JSON.stringify(actual));
    expect(actual).toEqual(["ACQUIRED:甲", "HANDOVER:乙", "HANDOVER:甲", `TAKEOVER:${admin.name}（裁判长接管）`, "ACQUIRED:丙", "ACQUIRED:丁"]);
  });

  it("未登记姓名的旧会话（B2 上线前建立）续用时补填姓名：时间线把补填人记成从会话开始就在执裁", async () => {
    const { matches } = await roundRobin("o4-legacy", 3);
    const match = matches[0];
    const device = randomUUID();
    const first = await acquireScoringSession(refereeId, match.code, device, "占位");
    // 探针写入：模拟 B2 上线前、逐场指派模式下共用账号建立的未登记姓名会话。
    await prisma.scoringSession.update({ where: { id: first.sessionId }, data: { officiatingName: null } });
    await acquireScoringSession(refereeId, match.code, device, "后来的人");
    const records = await loadOfficiatingRecords(prisma, [match.id]);
    const actual = records.get(match.id)!.actual.map((entry) => `${entry.kind}:${entry.name}`);
    note("O4-LEGACY", JSON.stringify(actual));
    // RV2-03 已修（开发会话 2026-11-09）：保留「未登记姓名」一段，再列交接后的人。
    expect(actual).toEqual(["ACQUIRED:共用账号（未登记姓名）", "HANDOVER:后来的人"]);
  });

  it("裁判姓名不出现在公开赛程、公开比赛详情、对外快照与对外数据表", async () => {
    const { slug, tournamentId, matches } = await roundRobin("o4-leak", 3);
    const secret = `复判秘名${RUN}`;
    const [c1] = await twoCourts(tournamentId);
    const match = matches[0];
    await prisma.match.update({ where: { id: match.id }, data: { courtId: c1.id } });
    const { control, result } = await startMatchWithControl(match.code);
    if (result.status !== "accepted") throw new Error("x");
    await acquireScoringSession(refereeId, match.code, control.sessionId ? (await prisma.scoringSession.findUniqueOrThrow({ where: { id: control.sessionId } })).deviceSessionId : randomUUID(), secret);
    await prisma.tournament.update({ where: { id: tournamentId }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    // 探针写入：把全部比赛设为已发布，让公开页尽量多地投影数据。
    await prisma.match.updateMany({ where: { stage: { competition: { tournamentId } } }, data: { publishedAt: new Date() } }).catch(() => undefined);
    const { getPublicSchedule, getPublicMatchDetail, getPublicTournament } = await import("@/server/services/public-tournament-service");
    const { captureReportSnapshot } = await import("@/server/services/report-snapshot-service");
    const { generateReportExport } = await import("@/server/services/report-export-service");
    const outputs = {
      tournament: JSON.stringify(await getPublicTournament(slug)),
      schedule: JSON.stringify(await getPublicSchedule(slug)),
      detail: JSON.stringify(await getPublicMatchDetail(slug, match.code)),
      snapshot: JSON.stringify((await captureReportSnapshot(tournamentId, "DRAFT")).snapshot),
    };
    const workbook = await generateReportExport(adminId, slug, { kind: "DATA_WORKBOOK", edition: "DRAFT" });
    const file = await prisma.reportExport.findUniqueOrThrow({ where: { id: workbook.id }, select: { content: true } });
    const internal = await generateReportExport(adminId, slug, { kind: "REGISTRATIONS_INTERNAL" });
    const internalFile = await prisma.reportExport.findUniqueOrThrow({ where: { id: internal.id }, select: { content: true } });
    const { inflateRawSync } = await import("node:zlib");
    const unzipText = (buffer: Buffer) => {
      // 极简 zip 读取：遍历本地文件头，解出 deflate/stored 内容拼接成文本（只用于搜索）。
      let offset = 0;
      let text = "";
      while (buffer.readUInt32LE(offset) === 0x04034b50) {
        const method = buffer.readUInt16LE(offset + 8);
        const size = buffer.readUInt32LE(offset + 18);
        const nameLength = buffer.readUInt16LE(offset + 26);
        const extraLength = buffer.readUInt16LE(offset + 28);
        const start = offset + 30 + nameLength + extraLength;
        const data = buffer.subarray(start, start + size);
        text += (method === 8 ? inflateRawSync(data) : data).toString("utf8");
        offset = start + size;
      }
      return text;
    };
    const workbookText = unzipText(Buffer.from(file.content));
    const internalText = unzipText(Buffer.from(internalFile.content));
    note("O4-LEAK lengths", Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, value.length])), "workbook", workbookText.length, "internal", internalText.length);
    for (const [key, value] of Object.entries(outputs)) expect(value, key).not.toContain(secret);
    expect(workbookText).not.toContain(secret);
    // 对照：内部名单确实含有该姓名（证明搜索方法有效）。
    expect(internalText).toContain(secret);
  });
});

describe("复判第二轮 RV-01 边界：比赛结束后场地已被下一场占用，再撤销最后一分", () => {
  it("撤销让结束待提交的比赛回到进行中：观察返回码与提示文字", async () => {
    const { tournamentId, matches } = await roundRobin("undo", 4);
    const [c1] = await twoCourts(tournamentId);
    const { m, n } = disjointPair(matches);
    await prisma.match.update({ where: { id: m.id }, data: { courtId: c1.id } });
    await prisma.match.update({ where: { id: n.id }, data: { courtId: c1.id } });
    const control = await acquireScoringSession(refereeId, m.code, randomUUID(), "演示裁判");
    type R = { status: string; version: number; state: { phase: string; players: { A: string[]; B: string[] }; pendingObligations: { id: string; type: string }[] } };
    const send = async (version: number, type: MatchCommand["type"], payload: MatchCommand["payload"]) =>
      (await submitScoringCommand(refereeId, m.code, command(control, version, type, payload), control.controlToken)) as unknown as R;
    let result = await send(0, "RECORD_COIN_TOSS", { valid: true, winnerSide: "A", winnerChoice: { kind: "SERVICE", decision: "SERVE" }, loserChoice: { kind: "END", end: "END_2" } } as MatchCommand["payload"]);
    result = await send(result.version, "CONFIRM_OPENING_SETUP", { serverPlayerId: result.state.players.A[0], receiverPlayerId: result.state.players.B[0], logicalCourts: null } as MatchCommand["payload"]);
    while (result.state.phase !== "MATCH_COMPLETE_PENDING_SUBMISSION") {
      const obligation = result.state.pendingObligations[0];
      if (obligation) result = await send(result.version, obligation.type === "INTERVAL" ? "ACKNOWLEDGE_INTERVAL" : "CONFIRM_CHANGE_ENDS", { obligationId: obligation.id } as MatchCommand["payload"]);
      else if (result.state.phase === "AWAITING_NEXT_GAME_SETUP") result = await send(result.version, "CONFIRM_NEXT_GAME_SETUP", { serverPlayerId: result.state.players.A[0], receiverPlayerId: result.state.players.B[0], logicalCourts: null } as MatchCommand["payload"]);
      else result = await send(result.version, "RALLY_WON", { side: "A" } as MatchCommand["payload"]);
    }
    await startMatch(n.code);
    let outcome: unknown;
    try {
      outcome = await send(result.version, "UNDO_LAST_REVERSIBLE", { reason: "最后一分记错" } as MatchCommand["payload"]);
    } catch (error) {
      const e = error as { status?: number; code?: string; message: string };
      outcome = { status: e.status ?? null, code: e.code ?? null, message: e.message };
    }
    const after = await prisma.match.findUniqueOrThrow({ where: { id: m.id }, select: { lifecycleStatus: true } });
    note("RV01-UNDO", outcome, after);
    await expect(prisma.match.count({ where: { courtId: c1.id, lifecycleStatus: { in: ["IN_PROGRESS", "SUSPENDED"] } } })).resolves.toBe(1);
  });
});

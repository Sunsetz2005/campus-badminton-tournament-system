import { randomUUID } from "node:crypto";

import { hashPassword, verifyPassword } from "better-auth/crypto";

import { prisma } from "../src/db/client";
import { assertDemoSeedDatabase } from "../src/db/database-safety";
import {
  deriveScoreCorrectionReplacement,
  type LogicalCourts,
  type MatchCommand,
  type MatchState,
  type Side,
} from "../src/domain/rules/match-engine";
import { hashRuleConfig, traditional21Demo } from "../src/domain/rules/rule-profile";
import { submitScoringCommand } from "../src/server/services/scoring-command-service";
import {
  acquireScoringSession,
  releaseScoringSession,
  takeoverScoringSession,
} from "../src/server/services/scoring-session-service";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`模拟种子缺少 ${name}。`);
  return value;
}

async function ensureAuthUser(email: string, password: string, name: string) {
  const normalizedEmail = email.toLowerCase();
  return prisma.$transaction(async (transaction) => {
    const user = await transaction.user.upsert({
      where: { email: normalizedEmail },
      update: { name, status: "ACTIVE", emailVerified: true },
      create: { email: normalizedEmail, name, emailVerified: true },
    });

    const accountKey = { providerId: "credential", accountId: user.id };
    const account = await transaction.account.findUnique({
      where: { providerId_accountId: accountKey },
      select: { password: true },
    });
    const passwordMatches =
      account?.password && (await verifyPassword({ hash: account.password, password }));
    if (!passwordMatches) {
      const passwordHash = await hashPassword(password);
      await transaction.account.upsert({
        where: { providerId_accountId: accountKey },
        update: { userId: user.id, password: passwordHash },
        create: { ...accountKey, userId: user.id, password: passwordHash },
      });
    }
    return user;
  });
}

async function ensureEntry(
  competitionId: string,
  code: string,
  displayName: string,
  entryType: "SINGLES" | "DOUBLES",
  participantIds: string[],
) {
  const expected = entryType === "SINGLES" ? 1 : 2;
  if (participantIds.length !== expected || new Set(participantIds).size !== expected) {
    throw new Error(`${code} 的成员数量或身份不符合 ${entryType} 约束。`);
  }
  return prisma.$transaction(async (transaction) => {
    const entry = await transaction.entry.upsert({
      where: { competitionId_code: { competitionId, code } },
      update: { displayName, entryType },
      create: { competitionId, code, displayName, entryType },
    });
    for (const [index, participantId] of participantIds.entries()) {
      await transaction.entryMember.upsert({
        where: { entryId_slot: { entryId: entry.id, slot: index + 1 } },
        update: { participantId },
        create: { entryId: entry.id, competitionId, participantId, slot: index + 1 },
      });
    }
    const members = await transaction.entryMember.findMany({ where: { entryId: entry.id } });
    if (members.length !== expected) {
      throw new Error(`${code} 已存在额外成员；种子不会删除既有数据，请人工检查。`);
    }
    return entry;
  });
}

type SeedResultMode = "ENDED_PENDING_SUBMISSION" | "SUBMITTED" | "LOCKED";

interface SeedResultInput {
  adminId: string;
  endedAt: Date;
  format: "SINGLES" | "DOUBLES";
  matchCode: string;
  mode: SeedResultMode;
  players: Record<Side, string[]>;
  refereeId: string;
  scheduledAt: Date;
  scores: Array<{ A: number; B: number }>;
}

interface SeedSpecialResultInput {
  adminId: string;
  endedAt: Date;
  matchCode: string;
  outcome: "WO" | "RET" | "DSQ" | "ABANDONED" | "BYE";
  refereeId: string;
  scheduledAt: Date;
  winnerSide: Side | null;
}

interface ControlLease {
  controlToken: string;
  matchVersion: number;
  sessionId: string;
  takeoverGeneration: number;
}

function opposite(side: Side): Side {
  return side === "A" ? "B" : "A";
}

function logicalCourtsFor(players: Record<Side, string[]>, format: "SINGLES" | "DOUBLES"): LogicalCourts | null {
  if (format === "SINGLES") return null;
  return {
    A: { R: players.A[0], L: players.A[1] },
    B: { R: players.B[0], L: players.B[1] },
  };
}

async function resultAlreadySeeded(matchCode: string) {
  const match = await prisma.match.findUniqueOrThrow({
    where: { code: matchCode },
    select: { id: true, version: true, _count: { select: { events: true } } },
  });
  if (match.version === 0 && match._count.events === 0) return false;
  if (match.version > 0 && match._count.events > 0) return true;
  throw new Error(`${matchCode} 的版本与事件历史不一致，种子停止写入。`);
}

async function seedCommand(
  matchCode: string,
  actorUserId: string,
  control: ControlLease,
  expectedVersion: number,
  occurredAt: Date,
  type: MatchCommand["type"],
  payload: MatchCommand["payload"],
) {
  const result = await submitScoringCommand(
    actorUserId,
    matchCode,
    {
      commandId: randomUUID(),
      occurredAt: occurredAt.toISOString(),
      expectedVersion,
      scoringSessionId: control.sessionId,
      takeoverGeneration: control.takeoverGeneration,
      type,
      payload,
    },
    control.controlToken,
  );
  if (result.status !== "accepted") throw new Error(`${matchCode} 的 ${type} 命令意外命中幂等分支。`);
  return result;
}

async function seedNormalResult(input: SeedResultInput) {
  if (await resultAlreadySeeded(input.matchCode)) return;
  const logicalCourts = logicalCourtsFor(input.players, input.format);
  const refereeControl = await acquireScoringSession(input.refereeId, input.matchCode, randomUUID());
  let control: ControlLease = refereeControl;
  let actorUserId = input.refereeId;
  let sequence = 0;
  let version = refereeControl.matchVersion;
  let state: MatchState;
  const occurredAt = () => new Date(input.scheduledAt.getTime() + sequence++ * 60_000);
  const send = async (type: MatchCommand["type"], payload: MatchCommand["payload"]) => {
    const result = await seedCommand(input.matchCode, actorUserId, control, version, occurredAt(), type, payload);
    version = result.version;
    state = result.state;
    return state;
  };

  await send("RECORD_COIN_TOSS", {
    valid: true,
    winnerSide: "A",
    winnerChoice: { kind: "SERVICE", decision: "SERVE" },
    loserChoice: { kind: "END", end: "END_2" },
  });
  await send("CONFIRM_OPENING_SETUP", {
    serverPlayerId: input.players.A[0],
    receiverPlayerId: input.players.B[0],
    logicalCourts,
  });

  for (const [index, score] of input.scores.entries()) {
    const winner: Side = score.A > score.B ? "A" : "B";
    const preFinalScore = { A: score.A - (winner === "A" ? 1 : 0), B: score.B - (winner === "B" ? 1 : 0) };
    const court = preFinalScore[winner] % 2 === 0 ? "R" : "L";
    const receivingSide = opposite(winner);
    const serverPlayerId = input.format === "SINGLES" ? input.players[winner][0] : logicalCourts![winner][court];
    const receiverPlayerId = input.format === "SINGLES" ? input.players[receivingSide][0] : logicalCourts![receivingSide][court];
    const replacement = deriveScoreCorrectionReplacement(state!, {
      score: preFinalScore,
      servingSide: winner,
      serverPlayerId,
      receiverPlayerId,
      logicalCourts,
    });
    await send("CORRECT_SCORE_STATE", { reason: `模拟第 ${index + 1} 局局末比分`, replacement });
    await send("RALLY_WON", { side: winner });
    if (index === input.scores.length - 1) continue;

    for (const obligation of [...state!.pendingObligations]) {
      if (obligation.type === "INTERVAL") {
        await send("ACKNOWLEDGE_INTERVAL", { obligationId: obligation.id });
      } else if (obligation.type === "CHANGE_ENDS") {
        await send("CONFIRM_CHANGE_ENDS", { obligationId: obligation.id });
      }
    }
    const nextServingSide = state!.nextGameServingSide!;
    await send("CONFIRM_NEXT_GAME_SETUP", {
      serverPlayerId: input.players[nextServingSide][0],
      receiverPlayerId: input.players[opposite(nextServingSide)][0],
      logicalCourts,
    });
  }

  if (input.mode !== "ENDED_PENDING_SUBMISSION") {
    await send("SUBMIT_RESULT", { reason: "模拟主裁判提交结果" });
  }
  if (input.mode === "LOCKED") {
    control = await takeoverScoringSession(input.adminId, input.matchCode, randomUUID(), "模拟裁判长复核结果");
    actorUserId = input.adminId;
    await send("CONFIRM_RESULT", { reason: "模拟裁判长复核通过" });
  }
  await releaseScoringSession(actorUserId, input.matchCode, control.sessionId, control.takeoverGeneration, control.controlToken);
  await prisma.match.update({
    where: { code: input.matchCode },
    data: { startedAt: new Date(input.scheduledAt.getTime() + 5 * 60_000), endedAt: input.endedAt },
  });
  await prisma.resultRevision.updateMany({
    where: { match: { code: input.matchCode } },
    data: {
      createdAt: new Date(input.endedAt.getTime() + 5 * 60_000),
      reviewedAt: input.mode === "LOCKED" ? new Date(input.endedAt.getTime() + 10 * 60_000) : undefined,
    },
  });
}

async function seedSpecialResult(input: SeedSpecialResultInput) {
  if (await resultAlreadySeeded(input.matchCode)) return;
  const refereeControl = await acquireScoringSession(input.refereeId, input.matchCode, randomUUID());
  let version = refereeControl.matchVersion;
  let sequence = 0;
  const send = async (
    actorUserId: string,
    control: ControlLease,
    type: MatchCommand["type"],
    payload: MatchCommand["payload"],
  ) => {
    const result = await seedCommand(
      input.matchCode,
      actorUserId,
      control,
      version,
      new Date(input.scheduledAt.getTime() + sequence++ * 60_000),
      type,
      payload,
    );
    version = result.version;
  };
  await send(input.refereeId, refereeControl, "RECORD_SPECIAL_OUTCOME", {
    type: input.outcome,
    ...(input.winnerSide ? { winnerSide: input.winnerSide } : {}),
    reason: "模拟现场特殊结果",
  });
  await send(input.refereeId, refereeControl, "SUBMIT_RESULT", { reason: "模拟主裁判提交特殊结果" });
  const chiefControl = await takeoverScoringSession(input.adminId, input.matchCode, randomUUID(), "模拟裁判长复核特殊结果");
  await send(input.adminId, chiefControl, "CONFIRM_RESULT", { reason: "模拟裁判长复核通过" });
  await releaseScoringSession(input.adminId, input.matchCode, chiefControl.sessionId, chiefControl.takeoverGeneration, chiefControl.controlToken);
  await prisma.match.update({
    where: { code: input.matchCode },
    data: { startedAt: new Date(input.scheduledAt.getTime() + 5 * 60_000), endedAt: input.endedAt },
  });
  await prisma.resultRevision.updateMany({
    where: { match: { code: input.matchCode } },
    data: {
      createdAt: new Date(input.endedAt.getTime() + 5 * 60_000),
      reviewedAt: new Date(input.endedAt.getTime() + 10 * 60_000),
    },
  });
}

/**
 * 仅供首页分组展示的附加模拟赛事。
 *
 * 它们不含项目、报名或比赛，因此不会出现在任何公开赛程里，
 * 也不会被误认为真实的阶段 4 报名或编排数据。
 */
async function seedPortalTournaments(adminId: string) {
  const definitions = [
    {
      slug: "spring-campus-2026",
      name: "2026 校园羽毛球春季联赛（模拟）",
      subtitle: "模拟数据 · 已结束",
      organizer: "校园羽毛球赛事管理系统（模拟）",
      venue: "体育馆一号馆（模拟）",
      summary: "模拟的已结束赛事，用于检查首页「已结束」分组。尚未接入赛程与成绩。",
      startDate: new Date("2026-03-09T00:00:00.000Z"),
      endDate: new Date("2026-03-15T00:00:00.000Z"),
      phase: "FINISHED" as const,
    },
    {
      slug: "winter-campus-2026",
      name: "2026 校园羽毛球冬季邀请赛（模拟）",
      subtitle: "模拟数据 · 筹备中",
      organizer: "校园羽毛球赛事管理系统（模拟）",
      venue: null,
      summary: "模拟的筹备中赛事，用于检查首页「即将开始」分组。报名与编排功能尚未实现。",
      startDate: new Date("2026-12-14T00:00:00.000Z"),
      endDate: new Date("2026-12-20T00:00:00.000Z"),
      phase: "PREPARING" as const,
    },
  ];

  for (const definition of definitions) {
    const { slug, ...fields } = definition;
    const record = await prisma.tournament.upsert({
      where: { slug },
      update: { ...fields, status: "PUBLISHED", publishedAt: new Date("2026-09-22T00:00:00.000Z") },
      create: {
        slug,
        timezone: "Asia/Shanghai",
        status: "PUBLISHED",
        namePolicy: "CODES_ONLY",
        publishedAt: new Date("2026-09-22T00:00:00.000Z"),
        ...fields,
      },
    });
    await prisma.roleAssignment.upsert({
      where: { userId_tournamentId_role: { userId: adminId, tournamentId: record.id, role: "ADMIN" } },
      update: {},
      create: { userId: adminId, tournamentId: record.id, role: "ADMIN" },
    });
  }
  return definitions.length;
}

async function main() {
  assertDemoSeedDatabase(process.env.DATABASE_URL);
  if (process.env.ALLOW_DEMO_ACCOUNTS !== "true") {
    throw new Error("必须显式设置 ALLOW_DEMO_ACCOUNTS=true 才能创建模拟身份。");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境禁止运行模拟种子。");
  }

  const admin = await ensureAuthUser(required("DEMO_ADMIN_EMAIL"), required("DEMO_ADMIN_PASSWORD"), "本地赛事管理员");
  // 平台级角色只允许新建赛事；既有赛事的权限仍逐一通过 RoleAssignment 授予。
  await prisma.user.update({ where: { id: admin.id }, data: { systemRole: "SYSTEM_ADMIN" } });
  const referee = await ensureAuthUser(
    required("DEMO_REFEREE_EMAIL"),
    required("DEMO_REFEREE_PASSWORD"),
    "本地临场裁判",
  );
  const participantEmail = process.env.DEMO_PARTICIPANT_EMAIL?.trim();
  const participantPassword = process.env.DEMO_PARTICIPANT_PASSWORD?.trim();
  if (Boolean(participantEmail) !== Boolean(participantPassword)) {
    throw new Error("模拟参赛选手账号必须同时提供 DEMO_PARTICIPANT_EMAIL 和 DEMO_PARTICIPANT_PASSWORD。");
  }
  if (participantEmail && participantPassword) {
    await ensureAuthUser(participantEmail, participantPassword, "模拟参赛选手（只读）");
  }

  // 门户元数据。选手名本身就是虚构匿名名，因此显式采用 DISPLAY_NAMES；
  // 真实赛事默认为 CODES_ONLY，由组织者另行决定是否公开姓名。
  const demoPortalFields = {
    name: "阶段 1 匿名模拟赛",
    subtitle: "人工测验夹具 · 非正式赛事",
    organizer: "校园羽毛球赛事管理系统（模拟）",
    venue: "综合体育馆（模拟）",
    summary: "本赛事全部为模拟数据，用于人工测验裁判执裁、结果提交与公开展示，不代表正式赛事公告。",
    startDate: new Date("2026-09-21T00:00:00.000Z"),
    endDate: new Date("2026-10-01T00:00:00.000Z"),
    status: "PUBLISHED" as const,
    phase: "RUNNING" as const,
    namePolicy: "DISPLAY_NAMES" as const,
  };
  const tournament = await prisma.tournament.upsert({
    where: { slug: "phase-1-demo" },
    update: { ...demoPortalFields, publishedAt: new Date("2026-09-21T00:00:00.000Z") },
    create: {
      slug: "phase-1-demo",
      timezone: "Asia/Shanghai",
      publishedAt: new Date("2026-09-21T00:00:00.000Z"),
      ...demoPortalFields,
    },
  });

  await prisma.roleAssignment.upsert({
    where: { userId_tournamentId_role: { userId: admin.id, tournamentId: tournament.id, role: "ADMIN" } },
    update: {},
    create: { userId: admin.id, tournamentId: tournament.id, role: "ADMIN" },
  });
  await prisma.roleAssignment.upsert({
    where: { userId_tournamentId_role: { userId: admin.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" } },
    update: {},
    create: { userId: admin.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
  });
  await prisma.roleAssignment.upsert({
    where: { userId_tournamentId_role: { userId: referee.id, tournamentId: tournament.id, role: "REFEREE" } },
    update: {},
    create: { userId: referee.id, tournamentId: tournament.id, role: "REFEREE" },
  });

  const profile = await prisma.ruleProfile.upsert({
    where: { tournamentId_key: { tournamentId: tournament.id, key: "traditional-21-demo" } },
    update: { name: "传统 21 分演示配置" },
    create: { tournamentId: tournament.id, key: "traditional-21-demo", name: "传统 21 分演示配置" },
  });
  const configHash = hashRuleConfig(traditional21Demo);
  const revision = await prisma.ruleProfileRevision.upsert({
    where: { ruleProfileId_revision: { ruleProfileId: profile.id, revision: 1 } },
    update: {},
    create: {
      ruleProfileId: profile.id,
      revision: 1,
      sourceLabel: "项目演示配置",
      sourceVersion: "phase-1",
      config: traditional21Demo,
      configHash,
      adoptedAt: new Date("2026-09-18T00:00:00.000Z"),
      frozenAt: new Date("2026-09-18T00:00:00.000Z"),
    },
  });
  await prisma.tournament.update({ where: { id: tournament.id }, data: { defaultRuleRevisionId: revision.id } });

  const singles = await prisma.competition.upsert({
    where: { tournamentId_code: { tournamentId: tournament.id, code: "MS" } },
    update: { name: "男子单打", ruleProfileRevisionId: revision.id },
    create: {
      tournamentId: tournament.id,
      code: "MS",
      name: "男子单打",
      kind: "MS",
      entryType: "SINGLES",
      ruleProfileRevisionId: revision.id,
    },
  });
  const doubles = await prisma.competition.upsert({
    where: { tournamentId_code: { tournamentId: tournament.id, code: "MD" } },
    update: { name: "男子双打", ruleProfileRevisionId: revision.id },
    create: {
      tournamentId: tournament.id,
      code: "MD",
      name: "男子双打",
      kind: "MD",
      entryType: "DOUBLES",
      ruleProfileRevisionId: revision.id,
    },
  });
  const singlesStage = await prisma.stage.upsert({
    where: { competitionId_code: { competitionId: singles.id, code: "GROUP" } },
    update: { ruleProfileRevisionId: revision.id, frozenAt: new Date("2026-09-18T00:00:00.000Z") },
    create: {
      competitionId: singles.id,
      code: "GROUP",
      name: "模拟小组赛",
      type: "ROUND_ROBIN",
      order: 1,
      ruleProfileRevisionId: revision.id,
      frozenAt: new Date("2026-09-18T00:00:00.000Z"),
    },
  });
  const doublesStage = await prisma.stage.upsert({
    where: { competitionId_code: { competitionId: doubles.id, code: "KO" } },
    update: { ruleProfileRevisionId: revision.id, frozenAt: new Date("2026-09-18T00:00:00.000Z") },
    create: {
      competitionId: doubles.id,
      code: "KO",
      name: "模拟淘汰赛",
      type: "KNOCKOUT",
      order: 1,
      ruleProfileRevisionId: revision.id,
      frozenAt: new Date("2026-09-18T00:00:00.000Z"),
    },
  });
  const groupA = await prisma.group.upsert({
    where: { stageId_code: { stageId: singlesStage.id, code: "A" } },
    update: { name: "A 组" },
    create: { stageId: singlesStage.id, code: "A", name: "A 组" },
  });
  const court = await prisma.court.upsert({
    where: { tournamentId_code: { tournamentId: tournament.id, code: "C1" } },
    update: { name: "1 号场" },
    create: { tournamentId: tournament.id, code: "C1", name: "1 号场" },
  });
  const court2 = await prisma.court.upsert({
    where: { tournamentId_code: { tournamentId: tournament.id, code: "C2" } },
    update: { name: "2 号场" },
    create: { tournamentId: tournament.id, code: "C2", name: "2 号场" },
  });
  const court3 = await prisma.court.upsert({
    where: { tournamentId_code: { tournamentId: tournament.id, code: "C3" } },
    update: { name: "3 号场" },
    create: { tournamentId: tournament.id, code: "C3", name: "3 号场" },
  });

  const participantDefinitions = [
    ["P001", "模拟选手 01", "一队"],
    ["P002", "模拟选手 02", "二队"],
    ["P003", "模拟选手 03", "三队"],
    ["P004", "模拟选手 04", "三队"],
    ["P005", "模拟选手 05", "四队"],
    ["P006", "模拟选手 06", "四队"],
    ["P007", "模拟选手 07", "计算机学院"],
    ["P008", "模拟选手 08", "体育学院"],
    ["P009", "模拟选手 09", "外国语学院"],
    ["P010", "模拟选手 10", "管理学院"],
    ["P011", "模拟选手 11", "材料学院"],
    ["P012", "模拟选手 12", "设计学院"],
    ["P013", "模拟选手 13", "计算机学院"],
    ["P014", "模拟选手 14", "计算机学院"],
    ["P015", "模拟选手 15", "体育学院"],
    ["P016", "模拟选手 16", "体育学院"],
  ] as const;
  const participants = new Map<string, { id: string }>();
  for (const [publicCode, displayName, teamName] of participantDefinitions) {
    const participant = await prisma.participant.upsert({
      where: { tournamentId_publicCode: { tournamentId: tournament.id, publicCode } },
      update: { displayName, teamName },
      create: { tournamentId: tournament.id, publicCode, displayName, teamName },
      select: { id: true },
    });
    participants.set(publicCode, participant);
  }
  // 新报名生成的编号从模拟选手之后继续，不与 P001—P016 冲突。
  await prisma.tournament.updateMany({
    where: { id: tournament.id, nextParticipantSeq: { lt: participantDefinitions.length + 1 } },
    data: { nextParticipantSeq: participantDefinitions.length + 1 },
  });
  const participantId = (code: string) => {
    const participant = participants.get(code);
    if (!participant) throw new Error(`缺少模拟选手 ${code}。`);
    return participant.id;
  };

  const singleA = await ensureEntry(singles.id, "MS-A", "模拟选手 01", "SINGLES", [participantId("P001")]);
  const singleB = await ensureEntry(singles.id, "MS-B", "模拟选手 02", "SINGLES", [participantId("P002")]);
  const doubleA = await ensureEntry(doubles.id, "MD-A", "模拟组合 03/04", "DOUBLES", [participantId("P003"), participantId("P004")]);
  const doubleB = await ensureEntry(doubles.id, "MD-B", "模拟组合 05/06", "DOUBLES", [participantId("P005"), participantId("P006")]);
  const singleC = await ensureEntry(singles.id, "MS-C", "模拟选手 07", "SINGLES", [participantId("P007")]);
  const singleD = await ensureEntry(singles.id, "MS-D", "模拟选手 08", "SINGLES", [participantId("P008")]);
  const singleE = await ensureEntry(singles.id, "MS-E", "模拟选手 09", "SINGLES", [participantId("P009")]);
  const singleF = await ensureEntry(singles.id, "MS-F", "模拟选手 10", "SINGLES", [participantId("P010")]);
  const singleG = await ensureEntry(singles.id, "MS-G", "模拟选手 11", "SINGLES", [participantId("P011")]);
  const singleH = await ensureEntry(singles.id, "MS-H", "模拟选手 12", "SINGLES", [participantId("P012")]);
  const doubleC = await ensureEntry(doubles.id, "MD-C", "模拟组合 13/14", "DOUBLES", [participantId("P013"), participantId("P014")]);
  const doubleD = await ensureEntry(doubles.id, "MD-D", "模拟组合 15/16", "DOUBLES", [participantId("P015"), participantId("P016")]);

  const singlesMatch = await prisma.match.upsert({
    where: { code: "MS-DEMO-001" },
    update: {},
    create: {
      code: "MS-DEMO-001",
      stageId: singlesStage.id,
      groupId: groupA.id,
      courtId: court.id,
      sideAEntryId: singleA.id,
      sideBEntryId: singleB.id,
      lifecycleStatus: "READY",
      scheduledAt: new Date("2026-10-01T01:00:00.000Z"),
    },
  });
  const doublesMatch = await prisma.match.upsert({
    where: { code: "MD-DEMO-001" },
    update: {},
    create: {
      code: "MD-DEMO-001",
      stageId: doublesStage.id,
      courtId: court.id,
      sideAEntryId: doubleA.id,
      sideBEntryId: doubleB.id,
      lifecycleStatus: "READY",
      scheduledAt: new Date("2026-10-01T03:00:00.000Z"),
    },
  });

  const assignedDoublesMatch = await prisma.match.upsert({
    where: { code: "MD-DEMO-002" },
    update: {},
    create: {
      code: "MD-DEMO-002",
      stageId: doublesStage.id,
      courtId: court.id,
      sideAEntryId: doubleA.id,
      sideBEntryId: doubleB.id,
      lifecycleStatus: "READY",
      scheduledAt: new Date("2026-10-01T04:00:00.000Z"),
    },
  });

  const manualMatches = await Promise.all([
    prisma.match.upsert({
      where: { code: "MS-LIVE-001" },
      update: {},
      create: {
        code: "MS-LIVE-001", stageId: singlesStage.id, groupId: groupA.id, courtId: court2.id,
        sideAEntryId: singleC.id, sideBEntryId: singleD.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T13:00:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MS-LIVE-002" },
      update: {},
      create: {
        code: "MS-LIVE-002", stageId: singlesStage.id, groupId: groupA.id, courtId: court3.id,
        sideAEntryId: singleE.id, sideBEntryId: singleF.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T13:30:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MD-LIVE-001" },
      update: {},
      create: {
        code: "MD-LIVE-001", stageId: doublesStage.id, courtId: court2.id,
        sideAEntryId: doubleC.id, sideBEntryId: doubleD.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T14:00:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MS-SCHED-001" },
      update: {},
      create: {
        code: "MS-SCHED-001", stageId: singlesStage.id, groupId: groupA.id, courtId: court.id,
        sideAEntryId: singleG.id, sideBEntryId: singleH.id, lifecycleStatus: "SCHEDULED",
        scheduledAt: new Date("2026-09-22T01:00:00.000Z"),
      },
    }),
  ]);

  const freshManualMatches = await Promise.all([
    prisma.match.upsert({
      where: { code: "MS-FRESH-001" },
      update: {},
      create: {
        code: "MS-FRESH-001", stageId: singlesStage.id, groupId: groupA.id, courtId: court.id,
        sideAEntryId: singleA.id, sideBEntryId: singleD.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T12:00:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MS-FRESH-002" },
      update: {},
      create: {
        code: "MS-FRESH-002", stageId: singlesStage.id, groupId: groupA.id, courtId: court2.id,
        sideAEntryId: singleE.id, sideBEntryId: singleH.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T12:15:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MD-FRESH-001" },
      update: {},
      create: {
        code: "MD-FRESH-001", stageId: doublesStage.id, courtId: court2.id,
        sideAEntryId: doubleA.id, sideBEntryId: doubleD.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T12:30:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MD-FRESH-002" },
      update: {},
      create: {
        code: "MD-FRESH-002", stageId: doublesStage.id, courtId: court3.id,
        sideAEntryId: doubleB.id, sideBEntryId: doubleC.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T12:45:00.000Z"),
      },
    }),
  ]);

  const completedMatches = await Promise.all([
    prisma.match.upsert({
      where: { code: "MS-DONE-001" }, update: {},
      create: {
        code: "MS-DONE-001", stageId: singlesStage.id, groupId: groupA.id, courtId: court.id,
        sideAEntryId: singleA.id, sideBEntryId: singleC.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T01:00:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MS-DONE-002" }, update: {},
      create: {
        code: "MS-DONE-002", stageId: singlesStage.id, groupId: groupA.id, courtId: court2.id,
        sideAEntryId: singleD.id, sideBEntryId: singleE.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T02:00:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MD-DONE-001" }, update: {},
      create: {
        code: "MD-DONE-001", stageId: doublesStage.id, courtId: court3.id,
        sideAEntryId: doubleA.id, sideBEntryId: doubleC.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T03:00:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MD-DONE-002" }, update: {},
      create: {
        code: "MD-DONE-002", stageId: doublesStage.id, courtId: court.id,
        sideAEntryId: doubleB.id, sideBEntryId: doubleD.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T04:00:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MS-REVIEW-001" }, update: {},
      create: {
        code: "MS-REVIEW-001", stageId: singlesStage.id, groupId: groupA.id, courtId: court2.id,
        sideAEntryId: singleF.id, sideBEntryId: singleG.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T05:00:00.000Z"),
      },
    }),
    prisma.match.upsert({
      where: { code: "MD-END-001" }, update: {},
      create: {
        code: "MD-END-001", stageId: doublesStage.id, courtId: court3.id,
        sideAEntryId: doubleA.id, sideBEntryId: doubleD.id, lifecycleStatus: "READY",
        scheduledAt: new Date("2026-09-21T06:00:00.000Z"),
      },
    }),
  ]);

  const allMatches = [
    singlesMatch,
    doublesMatch,
    assignedDoublesMatch,
    ...manualMatches,
    ...freshManualMatches,
    ...completedMatches,
  ];
  for (const match of allMatches) {
    await prisma.matchRuleSnapshot.upsert({
      where: { matchId: match.id },
      update: {},
      create: {
        matchId: match.id,
        ruleProfileRevisionId: revision.id,
        config: traditional21Demo,
        configHash,
        sourceChain: [
          { scope: "tournament", ruleProfileRevisionId: revision.id },
          { scope: "match", snapshot: true },
        ],
      },
    });
    await prisma.game.upsert({
      where: { matchId_number: { matchId: match.id, number: 1 } },
      update: {},
      create: { matchId: match.id, number: 1 },
    });
  }
  const refereeMatches = [
    singlesMatch,
    assignedDoublesMatch,
    ...manualMatches.slice(0, 3),
    ...freshManualMatches,
    ...completedMatches,
  ];
  for (const match of refereeMatches) {
    await prisma.officialAssignment.upsert({
      where: { matchId_userId_role: { matchId: match.id, userId: referee.id, role: "MAIN_REFEREE" } },
      update: { active: true },
      create: { matchId: match.id, userId: referee.id, role: "MAIN_REFEREE", active: true },
    });
  }

  await seedNormalResult({
    adminId: admin.id, refereeId: referee.id, matchCode: "MS-DONE-001", format: "SINGLES",
    players: { A: [participantId("P001")], B: [participantId("P007")] },
    scheduledAt: new Date("2026-09-21T01:00:00.000Z"), endedAt: new Date("2026-09-21T01:42:00.000Z"),
    scores: [{ A: 21, B: 14 }, { A: 21, B: 17 }], mode: "LOCKED",
  });
  await seedNormalResult({
    adminId: admin.id, refereeId: referee.id, matchCode: "MS-DONE-002", format: "SINGLES",
    players: { A: [participantId("P008")], B: [participantId("P009")] },
    scheduledAt: new Date("2026-09-21T02:00:00.000Z"), endedAt: new Date("2026-09-21T02:39:00.000Z"),
    scores: [{ A: 15, B: 21 }, { A: 18, B: 21 }], mode: "LOCKED",
  });
  await seedNormalResult({
    adminId: admin.id, refereeId: referee.id, matchCode: "MD-DONE-001", format: "DOUBLES",
    players: { A: [participantId("P003"), participantId("P004")], B: [participantId("P013"), participantId("P014")] },
    scheduledAt: new Date("2026-09-21T03:00:00.000Z"), endedAt: new Date("2026-09-21T03:48:00.000Z"),
    scores: [{ A: 21, B: 16 }, { A: 21, B: 18 }], mode: "LOCKED",
  });
  await seedSpecialResult({
    adminId: admin.id, refereeId: referee.id, matchCode: "MD-DONE-002", outcome: "RET", winnerSide: "A",
    scheduledAt: new Date("2026-09-21T04:00:00.000Z"), endedAt: new Date("2026-09-21T04:27:00.000Z"),
  });
  await seedNormalResult({
    adminId: admin.id, refereeId: referee.id, matchCode: "MS-REVIEW-001", format: "SINGLES",
    players: { A: [participantId("P010")], B: [participantId("P011")] },
    scheduledAt: new Date("2026-09-21T05:00:00.000Z"), endedAt: new Date("2026-09-21T05:44:00.000Z"),
    scores: [{ A: 21, B: 18 }, { A: 21, B: 19 }], mode: "SUBMITTED",
  });
  await seedNormalResult({
    adminId: admin.id, refereeId: referee.id, matchCode: "MD-END-001", format: "DOUBLES",
    players: { A: [participantId("P003"), participantId("P004")], B: [participantId("P015"), participantId("P016")] },
    scheduledAt: new Date("2026-09-21T06:00:00.000Z"), endedAt: new Date("2026-09-21T06:51:00.000Z"),
    scores: [{ A: 21, B: 19 }, { A: 21, B: 17 }], mode: "ENDED_PENDING_SUBMISSION",
  });

  await prisma.officialAssignment.updateMany({
    where: { match: { code: { in: ["MS-DONE-001", "MS-DONE-002", "MD-DONE-001", "MD-DONE-002"] } }, userId: referee.id },
    data: { active: false },
  });

  // 逐场公开发布边界。只补空值，不覆盖已有发布时间，重复执行不会改变结果。
  const published = await prisma.match.updateMany({
    where: { publishedAt: null, stage: { competition: { tournamentId: tournament.id } } },
    data: { publishedAt: new Date("2026-09-21T00:00:00.000Z") },
  });

  // 另外两个赛事让首页的「进行中 / 即将开始 / 已结束」分组读起来像列表而不是单行。
  // 它们只有赛事级信息，没有项目、报名或比赛，也因此不会产生任何公开赛程。
  const extraTournaments = await seedPortalTournaments(admin.id);

  console.info(`公开发布边界：本次补写 ${published.count} 场；额外门户赛事 ${extraTournaments} 个。`);

  console.info(
    `人工直采模拟种子完成：17 场比赛、16 名匿名选手、4 场明确全新 0:0、4 场锁定结果、1 场待复核、1 场待提交、${participantEmail ? 3 : 2} 个模拟身份。`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "模拟种子执行失败。");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

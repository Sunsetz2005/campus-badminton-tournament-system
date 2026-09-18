import { auth } from "../src/server/auth/auth";
import { prisma } from "../src/db/client";
import { assertDemoSeedDatabase } from "../src/db/database-safety";
import { hashRuleConfig, traditional21Demo } from "../src/domain/rules/rule-profile";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`模拟种子缺少 ${name}。`);
  return value;
}

async function ensureAuthUser(email: string, password: string, name: string) {
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await auth.api.signUpEmail({ body: { email, password, name } });
    user = await prisma.user.findUnique({ where: { email } });
  }
  if (!user) throw new Error(`无法创建本地测试身份：${email}`);
  return prisma.user.update({
    where: { id: user.id },
    data: { name, status: "ACTIVE", emailVerified: true },
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
        create: { entryId: entry.id, participantId, slot: index + 1 },
      });
    }
    const members = await transaction.entryMember.findMany({ where: { entryId: entry.id } });
    if (members.length !== expected) {
      throw new Error(`${code} 已存在额外成员；种子不会删除既有数据，请人工检查。`);
    }
    return entry;
  });
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
  const referee = await ensureAuthUser(
    required("DEMO_REFEREE_EMAIL"),
    required("DEMO_REFEREE_PASSWORD"),
    "本地临场裁判",
  );

  const tournament = await prisma.tournament.upsert({
    where: { slug: "phase-1-demo" },
    update: { name: "阶段 1 匿名模拟赛", status: "PUBLISHED" },
    create: {
      slug: "phase-1-demo",
      name: "阶段 1 匿名模拟赛",
      timezone: "Asia/Shanghai",
      status: "PUBLISHED",
    },
  });

  await prisma.roleAssignment.upsert({
    where: { userId_tournamentId_role: { userId: admin.id, tournamentId: tournament.id, role: "ADMIN" } },
    update: {},
    create: { userId: admin.id, tournamentId: tournament.id, role: "ADMIN" },
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

  const participantDefinitions = [
    ["P001", "模拟选手 01", "一队"],
    ["P002", "模拟选手 02", "二队"],
    ["P003", "模拟选手 03", "三队"],
    ["P004", "模拟选手 04", "三队"],
    ["P005", "模拟选手 05", "四队"],
    ["P006", "模拟选手 06", "四队"],
  ] as const;
  const participants = new Map<string, { id: string }>();
  for (const [publicCode, displayName, teamName] of participantDefinitions) {
    const participant = await prisma.participant.upsert({
      where: { publicCode },
      update: { displayName, teamName },
      create: { publicCode, displayName, teamName },
      select: { id: true },
    });
    participants.set(publicCode, participant);
  }
  const participantId = (code: string) => {
    const participant = participants.get(code);
    if (!participant) throw new Error(`缺少模拟选手 ${code}。`);
    return participant.id;
  };

  const singleA = await ensureEntry(singles.id, "MS-A", "模拟选手 01", "SINGLES", [participantId("P001")]);
  const singleB = await ensureEntry(singles.id, "MS-B", "模拟选手 02", "SINGLES", [participantId("P002")]);
  const doubleA = await ensureEntry(doubles.id, "MD-A", "模拟组合 03/04", "DOUBLES", [participantId("P003"), participantId("P004")]);
  const doubleB = await ensureEntry(doubles.id, "MD-B", "模拟组合 05/06", "DOUBLES", [participantId("P005"), participantId("P006")]);

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

  for (const match of [singlesMatch, doublesMatch]) {
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
  await prisma.officialAssignment.upsert({
    where: { matchId_userId_role: { matchId: singlesMatch.id, userId: referee.id, role: "MAIN_REFEREE" } },
    update: { active: true },
    create: { matchId: singlesMatch.id, userId: referee.id, role: "MAIN_REFEREE", active: true },
  });

  console.info("阶段 1 模拟种子完成：1 场单打、1 场双打、6 名匿名选手、2 个本地测试身份。");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "模拟种子执行失败。");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

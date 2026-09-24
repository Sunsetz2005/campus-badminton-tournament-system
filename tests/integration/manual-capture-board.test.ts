import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import { loadVerifiedAggregate } from "@/server/services/match-state-service";

const expectedResults = [
  ["MS-DONE-001", "CONFIRMED"],
  ["MS-DONE-002", "CONFIRMED"],
  ["MD-DONE-001", "CONFIRMED"],
  ["MD-DONE-002", "CONFIRMED"],
  ["MS-REVIEW-001", "SUBMITTED"],
  ["MD-END-001", "MATCH_COMPLETE_PENDING_SUBMISSION"],
] as const;

describe("人工直采模拟数据与看板投影", () => {
  beforeAll(() => assertTestDatabaseUrl(process.env.DATABASE_URL));

  it("包含可开赛、待提交、待复核和已锁定结果", async () => {
    await expect(prisma.participant.count()).resolves.toBeGreaterThanOrEqual(16);
    await expect(prisma.match.count()).resolves.toBeGreaterThanOrEqual(17);
    await expect(prisma.match.count({ where: { lifecycleStatus: "READY" } })).resolves.toBeGreaterThanOrEqual(9);
    await expect(prisma.match.count({ where: { lifecycleStatus: "ENDED_PENDING_SUBMISSION" } })).resolves.toBeGreaterThanOrEqual(1);
    await expect(prisma.match.count({ where: { lifecycleStatus: "SUBMITTED", verificationStatus: "PENDING_REVIEW" } })).resolves.toBeGreaterThanOrEqual(1);
    await expect(prisma.match.count({ where: { lifecycleStatus: "SUBMITTED", verificationStatus: "LOCKED" } })).resolves.toBeGreaterThanOrEqual(4);
  });

  it("四场人工测试比赛都是真正的 0 事件、0:0 且已指派裁判", async () => {
    const freshCodes = ["MS-FRESH-001", "MS-FRESH-002", "MD-FRESH-001", "MD-FRESH-002"];
    const matches = await prisma.match.findMany({
      where: { code: { in: freshCodes } },
      select: {
        code: true,
        lifecycleStatus: true,
        version: true,
        events: { select: { id: true } },
        games: { orderBy: { number: "asc" }, select: { scoreA: true, scoreB: true, completed: true } },
        officialAssignments: { where: { active: true }, select: { id: true } },
      },
      orderBy: { code: "asc" },
    });
    expect(matches.map((match) => match.code)).toEqual([...freshCodes].sort());
    for (const match of matches) {
      expect(match, match.code).toMatchObject({ lifecycleStatus: "READY", version: 0 });
      expect(match.events, match.code).toHaveLength(0);
      expect(match.games, match.code).toEqual([{ scoreA: 0, scoreB: 0, completed: false }]);
      expect(match.officialAssignments.length, match.code).toBeGreaterThan(0);
    }
  });

  it("六场赛后样例都能由持久化事件重放到权威快照", async () => {
    for (const [code, phase] of expectedResults) {
      const match = await prisma.match.findUniqueOrThrow({ where: { code }, select: { id: true } });
      const aggregate = await prisma.$transaction((transaction) => loadVerifiedAggregate(transaction, match.id));
      expect(aggregate.state.phase, code).toBe(phase);
      expect(aggregate.events.length, code).toBeGreaterThan(0);
    }
  });

  it("正常完赛局分和特殊结果进入公开白名单数据", async () => {
    const normal = await prisma.match.findUniqueOrThrow({
      where: { code: "MS-DONE-001" },
      select: { games: { orderBy: { number: "asc" } }, outcomeType: true, verificationStatus: true },
    });
    expect(normal).toMatchObject({ outcomeType: "NORMAL", verificationStatus: "LOCKED" });
    expect(normal.games.map((game) => [game.scoreA, game.scoreB, game.completed])).toEqual([
      [21, 14, true],
      [21, 17, true],
    ]);

    await expect(prisma.match.findUniqueOrThrow({ where: { code: "MD-DONE-002" } })).resolves.toMatchObject({
      outcomeType: "RET",
      verificationStatus: "LOCKED",
    });
  });
});

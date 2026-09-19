import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/db/client";
import { assertTestDatabaseUrl } from "@/db/database-safety";
import { requireAssignedReferee } from "@/server/auth/authorization";
import { AppError } from "@/server/services/errors";
import { acquireScoringSession } from "@/server/services/scoring-session-service";

describe("真实数据库权限边界", () => {
  let refereeId: string;
  let adminId: string;
  let singlesMatchId: string;

  beforeAll(async () => {
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    const referee = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_REFEREE_EMAIL } });
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: process.env.DEMO_ADMIN_EMAIL } });
    const match = await prisma.match.findUniqueOrThrow({ where: { code: "MS-DEMO-001" } });
    refereeId = referee.id;
    adminId = admin.id;
    singlesMatchId = match.id;
  });

  afterEach(async () => {
    await prisma.scoringSession.deleteMany({ where: { matchId: singlesMatchId } });
    await prisma.auditLog.deleteMany({
      where: {
        action: { in: ["SCORING_SESSION_ACQUIRE", "SCORING_SESSION_ACQUIRED"] },
        actorUserId: { in: [refereeId, adminId] },
      },
    });
  });

  it("允许已指派裁判访问本人比赛", async () => {
    await expect(requireAssignedReferee(refereeId, "MS-DEMO-001")).resolves.toMatchObject({ code: "MS-DEMO-001" });
  });

  it("拒绝管理员仅凭管理员角色执裁", async () => {
    await expect(requireAssignedReferee(adminId, "MS-DEMO-001")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    } satisfies Partial<AppError>);
  });

  it("拒绝裁判操作未获指派的双打比赛", async () => {
    await expect(requireAssignedReferee(refereeId, "MD-DEMO-001")).rejects.toMatchObject({
      status: 403,
      code: "not_assigned",
    } satisfies Partial<AppError>);
  });

  it("同场只建立一个有效控制会话", async () => {
    const first = await acquireScoringSession(refereeId, "MS-DEMO-001", "11111111-1111-4111-8111-111111111111");
    expect(first.status).toBe("acquired");
    await expect(
      acquireScoringSession(refereeId, "MS-DEMO-001", "22222222-2222-4222-8222-222222222222"),
    ).rejects.toMatchObject({ status: 409, code: "controller_exists" } satisfies Partial<AppError>);
  });

  it("裁判越权取得控制权时不改变比赛状态并记录脱敏拒绝审计", async () => {
    const match = await prisma.match.findUniqueOrThrow({
      where: { code: "MD-DEMO-001" },
      select: { id: true },
    });
    const beforeSessions = await prisma.scoringSession.count({ where: { matchId: match.id } });

    await expect(
      acquireScoringSession(refereeId, "MD-DEMO-001", "77777777-7777-4777-8777-777777777777"),
    ).rejects.toMatchObject({ status: 403, code: "not_assigned" } satisfies Partial<AppError>);

    await expect(prisma.scoringSession.count({ where: { matchId: match.id } })).resolves.toBe(beforeSessions);
    const denial = await prisma.auditLog.findFirst({
      where: {
        actorUserId: refereeId,
        action: "SCORING_SESSION_ACQUIRE",
        targetId: match.id,
        outcome: "DENIED",
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(denial).not.toBeNull();
    expect(JSON.stringify(denial?.metadata)).toContain("not_assigned");
    expect(JSON.stringify(denial?.metadata)).not.toMatch(/password|secret|token|cookie/i);
  });

  it("并发重复拒绝在同一审计窗口只写入一次", async () => {
    const match = await prisma.match.findUniqueOrThrow({
      where: { code: "MD-DEMO-001" },
      select: { id: true },
    });

    const attempts = Array.from({ length: 8 }, (_, index) =>
      acquireScoringSession(
        refereeId,
        "MD-DEMO-001",
        `88888888-8888-4888-8${String(index).padStart(3, "0")}-888888888888`,
      ),
    );
    const results = await Promise.allSettled(attempts);
    expect(results.every((result) => result.status === "rejected")).toBe(true);

    await expect(
      prisma.auditLog.count({
        where: {
          actorUserId: refereeId,
          action: "SCORING_SESSION_ACQUIRE",
          targetId: match.id,
          outcome: "DENIED",
        },
      }),
    ).resolves.toBe(1);
  });
});

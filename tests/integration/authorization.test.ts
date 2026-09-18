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
});

import { beforeAll, describe, expect, it } from "vitest";

import { assertTestDatabaseUrl } from "@/db/database-safety";
import { getPublicTournament } from "@/server/services/public-tournament-service";

describe("公开查询白名单", () => {
  beforeAll(() => assertTestDatabaseUrl(process.env.DATABASE_URL));

  it("不返回账号、联系方式、内部 ID 或审计字段", async () => {
    const payload = await getPublicTournament("phase-1-demo");
    const text = JSON.stringify(payload);
    for (const forbidden of ["email", "password", "token", "userId", "participantId", "auditLogs"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(payload.competitions).toHaveLength(2);
  });
});

import { NextResponse } from "next/server";

import { assertTestDatabaseUrl } from "@/db/database-safety";
import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { parseControlToken, submitScoringCommand } from "@/server/services/scoring-command-service";
import { parseScoringCommandRequest } from "@/server/services/scoring-command-schema";
import { errorResponse } from "@/server/services/errors";

export async function POST(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const envelope = await parseScoringCommandRequest(request);
    const requestedDelay = Number(request.headers.get("x-test-response-delay-ms") ?? 0);
    if (requestedDelay > 0) {
      if (process.env.ENABLE_TEST_FAULT_INJECTION !== "true") {
        throw new Error("当前环境未启用测试故障注入。");
      }
      assertTestDatabaseUrl(process.env.DATABASE_URL);
    }
    const { matchCode } = await context.params;
    const result = await submitScoringCommand(
      user.id,
      matchCode,
      envelope,
      parseControlToken(request.headers.get("authorization")),
    );
    if (requestedDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(requestedDelay, 10_000)));
    }
    return NextResponse.json(result, {
      status: result.status === "accepted" ? 201 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, { route: "/api/matches/[matchCode]/commands", actorUserId });
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { parseControlToken } from "@/server/services/scoring-command-service";
import { AppError, errorResponse } from "@/server/services/errors";
import { heartbeatScoringSession } from "@/server/services/scoring-session-service";

const schema = z.object({ scoringSessionId: z.string().uuid(), takeoverGeneration: z.number().int().positive() });

export async function PUT(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "invalid_request", "心跳参数无效。");
    const { matchCode } = await context.params;
    return NextResponse.json(await heartbeatScoringSession(
      user.id,
      matchCode,
      parsed.data.scoringSessionId,
      parsed.data.takeoverGeneration,
      parseControlToken(request.headers.get("authorization")),
    ), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "/api/matches/[matchCode]/control/heartbeat", actorUserId });
  }
}

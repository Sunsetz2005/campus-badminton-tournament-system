import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { AppError, errorResponse } from "@/server/services/errors";
import { takeoverScoringSession } from "@/server/services/scoring-session-service";

const schema = z.object({ deviceSessionId: z.string().uuid(), reason: z.string().trim().min(1).max(500) });

export async function POST(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "invalid_request", "接管设备或原因无效。");
    const { matchCode } = await context.params;
    return NextResponse.json(await takeoverScoringSession(user.id, matchCode, parsed.data.deviceSessionId, parsed.data.reason), {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, { route: "/api/matches/[matchCode]/control/takeover", actorUserId });
  }
}

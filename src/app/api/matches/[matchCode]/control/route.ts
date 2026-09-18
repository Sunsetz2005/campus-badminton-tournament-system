import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { AppError, errorResponse } from "@/server/services/errors";
import { acquireScoringSession } from "@/server/services/scoring-session-service";

const requestSchema = z.object({
  deviceSessionId: z.string().uuid(),
});

export async function POST(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "invalid_request", "设备会话参数无效。");
    const { matchCode } = await context.params;
    const result = await acquireScoringSession(user.id, matchCode, parsed.data.deviceSessionId);
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

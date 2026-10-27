import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { AppError, errorResponse } from "@/server/services/errors";
import { parseControlToken } from "@/server/services/scoring-command-service";
import { acquireScoringSession, releaseScoringSession } from "@/server/services/scoring-session-service";

const requestSchema = z.object({
  deviceSessionId: z.string().uuid(),
  /** 共用裁判账号模式必填（赛务口径 O-2）。 */
  officiatingName: z.string().max(80).nullish(),
});

const releaseSchema = z.object({
  scoringSessionId: z.string().uuid(),
  takeoverGeneration: z.number().int().positive(),
});

export async function POST(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "invalid_request", "设备会话参数无效。");
    const { matchCode } = await context.params;
    const result = await acquireScoringSession(user.id, matchCode, parsed.data.deviceSessionId, parsed.data.officiatingName);
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, {
      route: "/api/matches/[matchCode]/control",
      actorUserId,
    });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const parsed = releaseSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "invalid_request", "释放会话参数无效。");
    const { matchCode } = await context.params;
    const result = await releaseScoringSession(
      user.id,
      matchCode,
      parsed.data.scoringSessionId,
      parsed.data.takeoverGeneration,
      parseControlToken(request.headers.get("authorization")),
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "/api/matches/[matchCode]/control", actorUserId });
  }
}

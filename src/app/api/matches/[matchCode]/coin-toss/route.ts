import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { drawCoinToss, parseControlToken } from "@/server/services/scoring-command-service";
import { AppError, errorResponse } from "@/server/services/errors";

const schema = z.object({ scoringSessionId: z.string().uuid(), takeoverGeneration: z.number().int().positive() });

/** 系统抛币：只有持有本场控制权的设备可以发起；同一比赛版本重复请求返回同一结果。 */
export async function POST(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError(400, "invalid_request", "抛币参数无效。");
    const { matchCode } = await context.params;
    const result = await drawCoinToss(user.id, matchCode, parsed.data, parseControlToken(request.headers.get("authorization")));
    return NextResponse.json(result, { status: result.status === "drawn" ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "/api/matches/[matchCode]/coin-toss", actorUserId });
  }
}

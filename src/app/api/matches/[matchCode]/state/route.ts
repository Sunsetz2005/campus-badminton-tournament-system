import { NextResponse } from "next/server";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { AppError, errorResponse } from "@/server/services/errors";
import { getAuthoritativeMatchState } from "@/server/services/match-state-service";

export async function GET(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const after = new URL(request.url).searchParams.get("afterVersion");
    const afterVersion = after === null ? undefined : Number(after);
    if (after !== null && (!Number.isInteger(afterVersion) || afterVersion! < 0)) {
      throw new AppError(400, "invalid_version", "afterVersion 必须是非负整数。");
    }
    const { matchCode } = await context.params;
    return NextResponse.json(await getAuthoritativeMatchState(user.id, matchCode, afterVersion), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, { route: "/api/matches/[matchCode]/state", actorUserId });
  }
}

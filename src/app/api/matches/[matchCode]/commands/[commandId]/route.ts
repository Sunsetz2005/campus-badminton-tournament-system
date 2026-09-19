import { NextResponse } from "next/server";
import { z } from "zod";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { getScoringCommandResult } from "@/server/services/scoring-command-service";
import { AppError, errorResponse } from "@/server/services/errors";

export async function GET(request: Request, context: { params: Promise<{ matchCode: string; commandId: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const { matchCode, commandId } = await context.params;
    if (!z.string().uuid().safeParse(commandId).success) throw new AppError(400, "invalid_command_id", "commandId 无效。");
    return NextResponse.json(await getScoringCommandResult(user.id, matchCode, commandId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, { route: "/api/matches/[matchCode]/commands/[commandId]", actorUserId });
  }
}

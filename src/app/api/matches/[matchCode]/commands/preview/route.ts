import { NextResponse } from "next/server";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { parseControlToken, previewScoringCommand } from "@/server/services/scoring-command-service";
import { parseScoringCommandRequest } from "@/server/services/scoring-command-schema";
import { errorResponse } from "@/server/services/errors";

export async function POST(request: Request, context: { params: Promise<{ matchCode: string }> }) {
  let actorUserId: string | undefined;
  try {
    const session = await getSessionFromHeaders(request.headers);
    const user = await requireActiveUser(session);
    actorUserId = user.id;
    const envelope = await parseScoringCommandRequest(request);
    const { matchCode } = await context.params;
    return NextResponse.json(await previewScoringCommand(
      user.id,
      matchCode,
      envelope,
      parseControlToken(request.headers.get("authorization")),
    ), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "/api/matches/[matchCode]/commands/preview", actorUserId });
  }
}

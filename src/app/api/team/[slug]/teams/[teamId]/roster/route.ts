import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { submitTeamRoster } from "@/server/services/team-service";

export const dynamic = "force-dynamic";

/** 队伍负责人提交或修改本队名单。身份与队伍归属一律从会话重新解析。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; teamId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, teamId } = await params;
    return NextResponse.json(await submitTeamRoster({ userId: user.id, mode: "TEAM_MANAGER" }, slug, teamId, await readJsonBody(request, 32 * 1024)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/team/[slug]/teams/[teamId]/roster" });
  }
}

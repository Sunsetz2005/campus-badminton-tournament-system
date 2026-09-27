import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { submitTeamRoster } from "@/server/services/team-service";

export const dynamic = "force-dynamic";

/** 管理员代录团体名单（与负责人提交共用同一服务与校验）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; teamId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, teamId } = await params;
    return NextResponse.json(await submitTeamRoster({ userId: user.id, mode: "ADMIN" }, slug, teamId, await readJsonBody(request, 32 * 1024)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/teams/[teamId]/roster" });
  }
}

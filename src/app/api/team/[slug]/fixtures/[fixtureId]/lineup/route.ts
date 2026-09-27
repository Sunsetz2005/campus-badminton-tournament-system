import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { submitLineup } from "@/server/services/team-tie-service";

export const dynamic = "force-dynamic";

/** 队伍负责人提交或修改本队在某场团体对抗的出场名单（盲交）。本队是哪一方由服务端按负责人绑定判定。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; fixtureId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, fixtureId } = await params;
    return NextResponse.json(await submitLineup({ userId: user.id, mode: "TEAM_MANAGER" }, slug, fixtureId, await readJsonBody(request, 16 * 1024)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/team/[slug]/fixtures/[fixtureId]/lineup" });
  }
}

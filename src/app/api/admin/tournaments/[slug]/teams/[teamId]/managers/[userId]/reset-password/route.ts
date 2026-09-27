import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { resetTeamManagerPassword } from "@/server/services/team-service";

export const dynamic = "force-dynamic";

/** 重置负责人口令：响应带一次性初始口令，禁止缓存。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; teamId: string; userId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, teamId, userId } = await params;
    return NextResponse.json(await resetTeamManagerPassword(user.id, slug, teamId, userId), { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/teams/[teamId]/managers/[userId]/reset-password" });
  }
}

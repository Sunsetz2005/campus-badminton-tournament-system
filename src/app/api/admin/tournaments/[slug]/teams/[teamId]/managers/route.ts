import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { provisionTeamManager } from "@/server/services/team-service";

export const dynamic = "force-dynamic";

/** 开通或绑定负责人。新建账号时响应里带一次性初始口令，因此禁止缓存；日志不记录请求体。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; teamId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, teamId } = await params;
    return NextResponse.json(await provisionTeamManager(user.id, slug, teamId, await readJsonBody(request)), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/teams/[teamId]/managers" });
  }
}

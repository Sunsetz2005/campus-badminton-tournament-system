import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { createChiefRefereeAccount } from "@/server/services/chief-referee-service";

export const dynamic = "force-dynamic";

/** 为本赛事开通裁判长账号；初始口令只在本次响应返回一次。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    const result = await createChiefRefereeAccount(user.id, slug, await readJsonBody(request, 16 * 1024));
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/chief-referees/accounts" });
  }
}

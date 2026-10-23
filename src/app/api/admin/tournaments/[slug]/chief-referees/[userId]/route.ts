import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { revokeChiefReferee } from "@/server/services/chief-referee-service";

export const dynamic = "force-dynamic";

/** 撤销本赛事裁判长，并吊销其在本赛事以裁判长身份持有的控制会话。幂等。 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ slug: string; userId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, userId } = await params;
    return NextResponse.json(await revokeChiefReferee(user.id, slug, userId));
  } catch (error) {
    return errorResponse(error, { route: "DELETE /api/admin/tournaments/[slug]/chief-referees/[userId]" });
  }
}

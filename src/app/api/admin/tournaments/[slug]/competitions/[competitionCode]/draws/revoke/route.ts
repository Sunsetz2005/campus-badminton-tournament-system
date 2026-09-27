import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { revokePublishedDraw } from "@/server/services/draw-service";
import { readJsonBody } from "@/server/services/http";

export const dynamic = "force-dynamic";

/** 撤销已发布抽签：只允许本赛事裁判长，且任何比赛都尚未开始。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; competitionCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, competitionCode } = await params;
    return NextResponse.json(await revokePublishedDraw(user.id, slug, competitionCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/competitions/[code]/draws/revoke" });
  }
}

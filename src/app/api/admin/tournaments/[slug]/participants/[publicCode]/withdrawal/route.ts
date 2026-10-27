import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { withdrawParticipant } from "@/server/services/withdrawal-service";

export const dynamic = "force-dynamic";

/** 裁判长登记选手退出或取消资格（赛务口径 W-2、W-4）：未开始的比赛以 WO 判给对手。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; publicCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, publicCode } = await params;
    return NextResponse.json(await withdrawParticipant(user.id, slug, publicCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/participants/[publicCode]/withdrawal" });
  }
}

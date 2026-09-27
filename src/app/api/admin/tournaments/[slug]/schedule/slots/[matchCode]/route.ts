import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { saveDraftSlot } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 手工调整一场比赛的草稿安排，返回立即复检结果。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string; matchCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, matchCode } = await params;
    return NextResponse.json(await saveDraftSlot(user.id, slug, matchCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "PATCH /api/admin/tournaments/[slug]/schedule/slots/[matchCode]" });
  }
}

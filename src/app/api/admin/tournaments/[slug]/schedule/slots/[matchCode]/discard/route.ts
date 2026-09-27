import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { discardDraftSlot } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 放弃一场比赛的草稿改动。 */
export async function POST(_request: Request, { params }: { params: Promise<{ slug: string; matchCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, matchCode } = await params;
    return NextResponse.json(await discardDraftSlot(user.id, slug, matchCode));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/schedule/slots/[matchCode]/discard" });
  }
}

import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { relayoutTie } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 整场团体对抗重排到指定开始时间与场地。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; fixtureId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, fixtureId } = await params;
    return NextResponse.json(await relayoutTie(user.id, slug, fixtureId, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/schedule/fixtures/[fixtureId]/relayout" });
  }
}

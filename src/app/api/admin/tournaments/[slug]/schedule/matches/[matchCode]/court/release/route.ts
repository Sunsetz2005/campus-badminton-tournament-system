import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { releaseSuspendedMatchCourt } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 裁判长让暂停中的比赛离场待续，腾出场地（赛务口径 S-9）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; matchCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, matchCode } = await params;
    return NextResponse.json(await releaseSuspendedMatchCourt(user.id, slug, matchCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/schedule/matches/[matchCode]/court/release" });
  }
}

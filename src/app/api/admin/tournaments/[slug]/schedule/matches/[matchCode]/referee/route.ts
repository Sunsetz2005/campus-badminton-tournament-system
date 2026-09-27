import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { replaceMatchReferee } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 裁判长临时更换一场比赛的主裁判（须写原因，吊销旧控制会话）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; matchCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, matchCode } = await params;
    return NextResponse.json(await replaceMatchReferee(user.id, slug, matchCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/schedule/matches/[matchCode]/referee" });
  }
}

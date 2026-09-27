import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { confirmGroupRanking } from "@/server/services/team-tie-service";

export const dynamic = "force-dynamic";

/** 裁判长确认小组名次并回填淘汰签位。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; competitionCode: string; groupCode: string }> },
) {
  try {
    const user = await requireRequestUser();
    const { slug, competitionCode, groupCode } = await params;
    return NextResponse.json(await confirmGroupRanking(user.id, slug, competitionCode, groupCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/competitions/[code]/groups/[groupCode]/ranking" });
  }
}

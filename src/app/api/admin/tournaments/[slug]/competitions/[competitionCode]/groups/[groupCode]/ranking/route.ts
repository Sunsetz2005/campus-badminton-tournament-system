import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { competitionEntryType, confirmIndividualGroupRanking } from "@/server/services/results-service";
import { confirmGroupRanking } from "@/server/services/team-tie-service";

export const dynamic = "force-dynamic";

/** 裁判长确认小组名次并回填淘汰签位：团体项目用团体积分榜，个人项目用校园演示排名方案。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; competitionCode: string; groupCode: string }> },
) {
  try {
    const user = await requireRequestUser();
    const { slug, competitionCode, groupCode } = await params;
    const body = await readJsonBody(request);
    const confirm = (await competitionEntryType(slug, competitionCode)) === "TEAM" ? confirmGroupRanking : confirmIndividualGroupRanking;
    return NextResponse.json(await confirm(user.id, slug, competitionCode, groupCode, body));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/competitions/[code]/groups/[groupCode]/ranking" });
  }
}

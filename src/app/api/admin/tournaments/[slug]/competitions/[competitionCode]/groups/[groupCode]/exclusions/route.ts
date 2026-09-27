import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { setRankingExclusion } from "@/server/services/results-service";

export const dynamic = "force-dynamic";

/** 裁判长处理特殊结果：排除或取消排除不能完成本组比赛的报名单位。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; competitionCode: string; groupCode: string }> },
) {
  try {
    const user = await requireRequestUser();
    const { slug, competitionCode, groupCode } = await params;
    return NextResponse.json(await setRankingExclusion(user.id, slug, competitionCode, groupCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/competitions/[code]/groups/[groupCode]/exclusions" });
  }
}

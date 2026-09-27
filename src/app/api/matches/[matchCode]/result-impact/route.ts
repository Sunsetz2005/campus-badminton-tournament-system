import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { AppError, errorResponse } from "@/server/services/errors";
import { getResultImpact } from "@/server/services/results-service";

export const dynamic = "force-dynamic";

/** 裁判长查看确认或重开某场比赛结果对晋级、名次与已发布榜单的影响（只读）。 */
export async function GET(request: Request, { params }: { params: Promise<{ matchCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { matchCode } = await params;
    const action = new URL(request.url).searchParams.get("action");
    if (action !== "CONFIRM" && action !== "REOPEN") throw new AppError(400, "invalid_action", "action 只能是 CONFIRM 或 REOPEN。");
    return NextResponse.json(await getResultImpact(user.id, matchCode, action), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "GET /api/matches/[matchCode]/result-impact" });
  }
}

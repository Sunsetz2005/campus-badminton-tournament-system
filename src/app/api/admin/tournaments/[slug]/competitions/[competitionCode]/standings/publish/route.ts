import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { publishStandings } from "@/server/services/results-service";

export const dynamic = "force-dynamic";

/** 发布名次榜单的新版本（历史版本保留）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; competitionCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, competitionCode } = await params;
    return NextResponse.json(await publishStandings(user.id, slug, competitionCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/competitions/[code]/standings/publish" });
  }
}

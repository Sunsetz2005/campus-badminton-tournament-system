import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { submitLineup } from "@/server/services/team-tie-service";

export const dynamic = "force-dynamic";

/** 赛事管理员代交一方的出场名单（名单交齐前）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; fixtureId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, fixtureId } = await params;
    return NextResponse.json(await submitLineup({ userId: user.id, mode: "ADMIN" }, slug, fixtureId, await readJsonBody(request, 16 * 1024)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/fixtures/[fixtureId]/lineup" });
  }
}

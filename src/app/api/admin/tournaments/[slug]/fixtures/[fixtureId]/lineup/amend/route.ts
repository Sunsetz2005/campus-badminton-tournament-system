import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { amendLineup } from "@/server/services/team-tie-service";

export const dynamic = "force-dynamic";

/** 名单公开后由裁判长修改尚未开始的小场，必须写原因。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; fixtureId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, fixtureId } = await params;
    return NextResponse.json(await amendLineup(user.id, slug, fixtureId, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/fixtures/[fixtureId]/lineup/amend" });
  }
}

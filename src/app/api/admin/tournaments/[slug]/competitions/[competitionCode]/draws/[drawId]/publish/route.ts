import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { publishDraw } from "@/server/services/draw-service";
import { readJsonBody } from "@/server/services/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string; competitionCode: string; drawId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, competitionCode, drawId } = await params;
    return NextResponse.json(await publishDraw(user.id, slug, competitionCode, drawId, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/competitions/[code]/draws/[drawId]/publish" });
  }
}

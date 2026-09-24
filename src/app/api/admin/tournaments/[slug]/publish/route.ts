import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { publishTournament } from "@/server/services/tournament-admin-service";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await publishTournament(user.id, slug));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/publish" });
  }
}

import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { updateTournamentSettings } from "@/server/services/tournament-admin-service";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    await updateTournamentSettings(user.id, slug, await readJsonBody(request, 64 * 1024));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, { route: "PATCH /api/admin/tournaments/[slug]/settings" });
  }
}

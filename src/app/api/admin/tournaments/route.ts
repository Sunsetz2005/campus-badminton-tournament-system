import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { createTournament } from "@/server/services/tournament-admin-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const user = await requireRequestUser();
    const tournament = await createTournament(user.id, await readJsonBody(request, 64 * 1024));
    return NextResponse.json(tournament, { status: 201 });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments" });
  }
}

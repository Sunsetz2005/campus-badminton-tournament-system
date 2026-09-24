import { NextResponse } from "next/server";

import { errorResponse } from "@/server/services/errors";
import { listPublicTournaments } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { tournaments: await listPublicTournaments() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

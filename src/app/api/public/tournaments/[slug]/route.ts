import { NextResponse } from "next/server";

import { errorResponse } from "@/server/services/errors";
import { getPublicTournament } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    return NextResponse.json(await getPublicTournament(slug), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, { route: "/api/public/tournaments/[slug]" });
  }
}

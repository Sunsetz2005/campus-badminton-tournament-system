import { NextResponse } from "next/server";

import { errorResponse } from "@/server/services/errors";
import { getPublicSchedule } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    return NextResponse.json(await getPublicSchedule(slug), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

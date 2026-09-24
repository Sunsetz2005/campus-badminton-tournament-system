import { NextResponse } from "next/server";

import { errorResponse } from "@/server/services/errors";
import { getPublicMatchDetail } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ matchCode: string; slug: string }> },
) {
  try {
    const { matchCode, slug } = await params;
    return NextResponse.json(
      await getPublicMatchDetail(slug, matchCode),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

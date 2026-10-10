import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { resetRefereePassword } from "@/server/services/referee-account-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string; userId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, userId } = await params;
    const result = await resetRefereePassword(user.id, slug, userId, await readJsonBody(request, 16 * 1024));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/referees/[userId]/password" });
  }
}

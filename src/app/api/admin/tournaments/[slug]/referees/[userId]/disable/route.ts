import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { disableRefereeAccount } from "@/server/services/referee-account-service";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ slug: string; userId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, userId } = await params;
    return NextResponse.json(await disableRefereeAccount(user.id, slug, userId));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/referees/[userId]/disable" });
  }
}

import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { removeTeamManager } from "@/server/services/team-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string; teamId: string; userId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, teamId, userId } = await params;
    return NextResponse.json(await removeTeamManager(user.id, slug, teamId, userId));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/teams/[teamId]/managers/[userId]/remove" });
  }
}

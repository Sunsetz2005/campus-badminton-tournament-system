import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { withdrawTeamRoster } from "@/server/services/team-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string; registrationId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, registrationId } = await params;
    return NextResponse.json(await withdrawTeamRoster(user.id, slug, registrationId, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/team/[slug]/registrations/[registrationId]/withdraw" });
  }
}

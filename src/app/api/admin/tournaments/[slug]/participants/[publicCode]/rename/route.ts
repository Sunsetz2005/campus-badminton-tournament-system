import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { renameParticipant } from "@/server/services/registration-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; publicCode: string }> },
) {
  try {
    const user = await requireRequestUser();
    const { slug, publicCode } = await params;
    return NextResponse.json(await renameParticipant(user.id, slug, publicCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/participants/[code]/rename" });
  }
}

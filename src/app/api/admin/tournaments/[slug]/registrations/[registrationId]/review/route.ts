import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { reviewRegistration } from "@/server/services/registration-service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; registrationId: string }> },
) {
  try {
    const user = await requireRequestUser();
    const { slug, registrationId } = await params;
    return NextResponse.json(await reviewRegistration(user.id, slug, registrationId, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/registrations/[id]/review" });
  }
}

import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { revokeRegistrationInvite } from "@/server/services/registration-invite-service";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ slug: string; inviteId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, inviteId } = await params;
    await revokeRegistrationInvite(user.id, slug, inviteId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/invites/[id]/revoke" });
  }
}

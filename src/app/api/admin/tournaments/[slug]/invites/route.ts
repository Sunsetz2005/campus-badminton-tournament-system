import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { createRegistrationInvite } from "@/server/services/registration-invite-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    const { invite, token } = await createRegistrationInvite(user.id, slug, await readJsonBody(request));
    // 明文令牌只在这一次响应里出现；服务端只保存摘要。
    return NextResponse.json({ invite, path: `/register/${token}` }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/invites" });
  }
}

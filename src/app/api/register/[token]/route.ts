import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { requestSource, submitInviteRegistration } from "@/server/services/registration-invite-service";

export const dynamic = "force-dynamic";

/** 匿名邀请报名入口：不需要登录，也不会创建任何账号。 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const result = await submitInviteRegistration(token, await readJsonBody(request, 8 * 1024), requestSource(await headers()));
    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    // 路由字段不含令牌，避免把邀请令牌写进日志。
    return errorResponse(error, { route: "POST /api/register/[token]" });
  }
}

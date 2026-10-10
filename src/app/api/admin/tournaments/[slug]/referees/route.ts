import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { createRefereeAccount, updateRefereeMode } from "@/server/services/referee-account-service";

export const dynamic = "force-dynamic";

/** 开通裁判员账号；口令只在本次响应返回一次（自定义口令不回显）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    const result = await createRefereeAccount(user.id, slug, await readJsonBody(request, 16 * 1024));
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/referees" });
  }
}

/** 切换执裁方式（共用裁判账号 / 逐场指派）。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await updateRefereeMode(user.id, slug, await readJsonBody(request, 16 * 1024)));
  } catch (error) {
    return errorResponse(error, { route: "PATCH /api/admin/tournaments/[slug]/referees" });
  }
}

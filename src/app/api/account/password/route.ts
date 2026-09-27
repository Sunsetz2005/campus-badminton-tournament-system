import { NextResponse } from "next/server";

import { changeOwnPassword } from "@/server/services/account-service";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { setCookies } = await changeOwnPassword(request.headers, await readJsonBody(request, 4 * 1024));
    const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    for (const cookie of setCookies) response.headers.append("set-cookie", cookie);
    return response;
  } catch (error) {
    // 路由字段不含请求体，避免口令进入日志。
    return errorResponse(error, { route: "POST /api/account/password" });
  }
}

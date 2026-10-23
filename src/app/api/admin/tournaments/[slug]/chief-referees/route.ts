import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { grantChiefReferee } from "@/server/services/chief-referee-service";

export const dynamic = "force-dynamic";

/** 把已有账号授予本赛事裁判长：`{ userId }` 或 `{ login }`（登录用户名或邮箱）。幂等。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await grantChiefReferee(user.id, slug, await readJsonBody(request, 16 * 1024)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/chief-referees" });
  }
}

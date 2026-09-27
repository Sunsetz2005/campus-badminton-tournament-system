import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { updateCourt } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 改场地名称，或关闭/重新开放场地。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string; courtCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, courtCode } = await params;
    return NextResponse.json(await updateCourt(user.id, slug, courtCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "PATCH /api/admin/tournaments/[slug]/schedule/courts/[courtCode]" });
  }
}

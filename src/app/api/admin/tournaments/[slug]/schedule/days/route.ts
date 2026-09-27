import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { replaceScheduleDays } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 整体替换比赛日与开放时段。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await replaceScheduleDays(user.id, slug, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/schedule/days" });
  }
}

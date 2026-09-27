import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { publishSchedule } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 发布草稿赛程（无硬冲突且警告已确认）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await publishSchedule(user.id, slug, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/schedule/publish" });
  }
}

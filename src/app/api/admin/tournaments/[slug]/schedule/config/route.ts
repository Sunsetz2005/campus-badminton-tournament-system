import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { updateScheduleConfig } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 赛程设置：预计时长、换场时间、淘汰赛每场对抗占用场地数、出场名单截止提前量。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await updateScheduleConfig(user.id, slug, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "PATCH /api/admin/tournaments/[slug]/schedule/config" });
  }
}

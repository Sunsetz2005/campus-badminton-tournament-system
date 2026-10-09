import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { logServerEvent } from "@/server/logging";
import { AppError, describeUnexpectedError, errorResponse } from "@/server/services/errors";
import { publishDraw } from "@/server/services/draw-service";
import { readJsonBody } from "@/server/services/http";
import { autoScheduleAfterDraw } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string; competitionCode: string; drawId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, competitionCode, drawId } = await params;
    const published = await publishDraw(user.id, slug, competitionCode, drawId, await readJsonBody(request));
    // 抽签已在独立事务中提交；自动排程只写草稿，失败时如实告知，不回滚抽签。
    let schedule: Awaited<ReturnType<typeof autoScheduleAfterDraw>> | { status: "FAILED"; message: string };
    try {
      schedule = await autoScheduleAfterDraw(user.id, slug, competitionCode);
    } catch (error) {
      logServerEvent("auto_schedule_failed", {
        route: "POST /api/admin/tournaments/[slug]/competitions/[code]/draws/[drawId]/publish",
        ...(error instanceof AppError ? { code: error.code } : describeUnexpectedError(error)),
      });
      schedule = {
        status: "FAILED",
        message: error instanceof AppError ? error.message : "自动生成赛程草稿失败，请到赛程排班页手动生成。",
      };
    }
    return NextResponse.json({ ...published, schedule });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/competitions/[code]/draws/[drawId]/publish" });
  }
}

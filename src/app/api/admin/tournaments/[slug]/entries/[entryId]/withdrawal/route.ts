import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { withdrawTeamEntry } from "@/server/services/withdrawal-service";

export const dynamic = "force-dynamic";

/** 裁判长登记团体报名单位整体退出（赛务口径 W-7）：未开始的对抗按认输计，小组成绩删除。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; entryId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, entryId } = await params;
    return NextResponse.json(await withdrawTeamEntry(user.id, slug, entryId, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/entries/[entryId]/withdrawal" });
  }
}

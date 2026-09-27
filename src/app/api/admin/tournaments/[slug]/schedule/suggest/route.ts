import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { suggestDraft } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 对选定范围内尚未开始的比赛生成自动排程建议（写入草稿）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await suggestDraft(user.id, slug, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/schedule/suggest" });
  }
}

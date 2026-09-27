import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { generateDrawDraft } from "@/server/services/draw-service";
import { readJsonBody } from "@/server/services/http";

export const dynamic = "force-dynamic";

/** 生成新的抽签草稿（随机种子由服务端生成，客户端不能指定）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; competitionCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, competitionCode } = await params;
    return NextResponse.json(await generateDrawDraft(user.id, slug, competitionCode, await readJsonBody(request)), { status: 201 });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/competitions/[code]/draws" });
  }
}

import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { recordResultOnly } from "@/server/services/results-service";

export const dynamic = "force-dynamic";

/** 管理员/编排员补录逐局结果（仅结果记录，不伪造回合过程），等待裁判长复核。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; matchCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, matchCode } = await params;
    return NextResponse.json(await recordResultOnly(user.id, slug, matchCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/matches/[matchCode]/result-only" });
  }
}

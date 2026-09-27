import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { reviewResultOnly } from "@/server/services/results-service";

export const dynamic = "force-dynamic";

/** 裁判长复核锁定、退回或重开（更正）仅结果记录。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; matchCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, matchCode } = await params;
    return NextResponse.json(await reviewResultOnly(user.id, slug, matchCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/matches/[matchCode]/result-only/review" });
  }
}

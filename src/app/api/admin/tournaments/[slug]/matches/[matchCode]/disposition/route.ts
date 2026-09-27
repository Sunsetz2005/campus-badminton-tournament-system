import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { recordResultDisposition } from "@/server/services/results-service";

export const dynamic = "force-dynamic";

/** 更正被后续已开始的比赛阻止时，裁判长登记人工处置决定（只追加记录，不改动比赛）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string; matchCode: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, matchCode } = await params;
    return NextResponse.json(await recordResultDisposition(user.id, slug, matchCode, await readJsonBody(request)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/matches/[matchCode]/disposition" });
  }
}

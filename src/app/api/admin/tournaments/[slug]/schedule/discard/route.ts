import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { discardDraft } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/** 放弃全部草稿改动。 */
export async function POST(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await discardDraft(user.id, slug));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/schedule/discard" });
  }
}

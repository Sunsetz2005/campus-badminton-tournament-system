import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { batchApproveRegistrations } from "@/server/services/registration-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    return NextResponse.json(await batchApproveRegistrations(user.id, slug, await readJsonBody(request, 32 * 1024)));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/registrations/batch-approve" });
  }
}

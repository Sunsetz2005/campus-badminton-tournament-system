import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { previewRegistrationImport } from "@/server/services/registration-import-service";
import { readImportUpload } from "@/server/services/upload";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    const { bytes } = await readImportUpload(request);
    return NextResponse.json(await previewRegistrationImport(user.id, slug, bytes));
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/imports/preview" });
  }
}

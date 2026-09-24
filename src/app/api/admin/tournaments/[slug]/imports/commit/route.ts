import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { AppError, errorResponse } from "@/server/services/errors";
import { commitRegistrationImport } from "@/server/services/registration-import-service";
import { readImportUpload } from "@/server/services/upload";

export const dynamic = "force-dynamic";

function count(value: FormDataEntryValue | null) {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) throw new AppError(400, "invalid_input", "缺少预览结果，请先预览。");
  return parsed;
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    const { bytes, form } = await readImportUpload(request);
    const contentHash = form.get("contentHash");
    if (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new AppError(400, "invalid_input", "缺少预览结果，请先预览。");
    }
    const result = await commitRegistrationImport(user.id, slug, bytes, {
      contentHash,
      newCount: count(form.get("newCount")),
      duplicateCount: count(form.get("duplicateCount")),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/imports/commit" });
  }
}

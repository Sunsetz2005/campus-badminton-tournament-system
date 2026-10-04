import { NextResponse } from "next/server";

import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { readJsonBody } from "@/server/services/http";
import { generateReportExport } from "@/server/services/report-export-service";

export const dynamic = "force-dynamic";

/** 生成一份导出文件并存档（内部报名名单或赛事数据表的草稿/正式版）。 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug } = await params;
    const created = await generateReportExport(user.id, slug, await readJsonBody(request));
    return NextResponse.json(
      {
        id: created.id,
        version: created.version,
        fileName: created.fileName,
        displayName: created.displayName,
        byteSize: created.byteSize,
        supersededVersion: created.supersededVersion,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, { route: "POST /api/admin/tournaments/[slug]/reports" });
  }
}

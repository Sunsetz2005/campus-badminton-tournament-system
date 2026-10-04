import { requireRequestUser } from "@/server/auth/request-user";
import { errorResponse } from "@/server/services/errors";
import { contentDisposition, getReportExportFile } from "@/server/services/report-export-service";

export const dynamic = "force-dynamic";

/** 下载已存档的导出文件。文件内容自生成起不可改写；已被替代的旧版同样可以下载备查。 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; exportId: string }> }) {
  try {
    const user = await requireRequestUser();
    const { slug, exportId } = await params;
    const file = await getReportExportFile(user.id, slug, exportId);
    return new Response(new Uint8Array(file.content), {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.content.length),
        "content-disposition": contentDisposition(file.fileName, file.displayName),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        etag: `"${file.sha256}"`,
      },
    });
  } catch (error) {
    return errorResponse(error, { route: "GET /api/admin/tournaments/[slug]/reports/[exportId]" });
  }
}

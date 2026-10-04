import { errorResponse } from "@/server/services/errors";
import { getPublicReportFile } from "@/server/services/public-report-service";
import { contentDisposition } from "@/server/services/report-export-service";

export const dynamic = "force-dynamic";

/** 公开下载当前正式版成绩册（booklet）或赛事数据表（data）。只读；不接受任何其他参数。 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string; kind: string }> }) {
  try {
    const { slug, kind } = await params;
    const file = await getPublicReportFile(slug, kind);
    return new Response(new Uint8Array(file.content), {
      headers: {
        "content-type": file.contentType,
        "content-length": String(file.content.length),
        "content-disposition": contentDisposition(file.fileName, file.displayName),
        // 文件内容由 SHA-256 唯一确定；更正后换成新版本，旧 ETag 自然失效。
        "cache-control": "public, max-age=60",
        etag: `"${file.sha256}"`,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error, { route: "GET /api/public/tournaments/[slug]/reports/[kind]" });
  }
}

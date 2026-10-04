import { headers } from "next/headers";

import { renderBookletHtml, escapeHtml } from "@/reports/booklet-html";
import { requireActiveUser, requireManagedTournament } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { AppError } from "@/server/services/errors";
import { REPORT_VIEW_ROLES } from "@/server/services/report-export-service";
import { captureReportSnapshot } from "@/server/services/report-snapshot-service";

export const dynamic = "force-dynamic";

// 打印网页只含内联样式：禁止任何脚本、外部资源、表单与被第三方嵌入。
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function page(status: number, message: string) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>成绩册</title><body style="font-family:sans-serif;padding:2rem"><p>${escapeHtml(message)}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "private, no-store" } },
  );
}

/**
 * A4 成绩册的打印网页：与 PDF 使用同一个模板，从当前数据的一致快照生成，本身不存档。
 * 需要可追溯的版本请在「成绩册与导出」页面生成 PDF。
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const edition = new URL(request.url).searchParams.get("edition") === "OFFICIAL" ? "OFFICIAL" : "DRAFT";
  const session = await getSessionFromHeaders(await headers());
  if (!session) {
    return Response.redirect(new URL(`/login?next=${encodeURIComponent(`/management/${slug}/reports`)}`, request.url), 303);
  }
  try {
    const user = await requireActiveUser(session);
    const { tournament } = await requireManagedTournament(user.id, slug, REPORT_VIEW_ROLES);
    const captured = await captureReportSnapshot(tournament.id, edition);
    const html = renderBookletHtml(
      captured.snapshot,
      { capturedAt: captured.capturedAt, snapshotHash: captured.snapshotHash, version: null },
      { screenNote: "打印预览（未存档）：按当前数据生成。用浏览器打印（⌘P / Ctrl+P），纸张选 A4、勾选「背景图形」。需要可追溯的版本，请回到「成绩册与导出」生成 PDF。" },
    );
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof AppError) return page(error.status, error.message);
    throw error;
  }
}

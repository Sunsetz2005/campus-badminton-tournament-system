import { readPosterFile } from "@/server/services/poster-service";

export const dynamic = "force-dynamic";

/**
 * 赛事海报的公开读取入口。文件名由服务端随机生成且只写一次（`wx`），
 * 同名内容永不变化，因此可以长期缓存。
 */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const poster = await readPosterFile(file);
  if (!poster) {
    return new Response("海报不存在。", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return new Response(new Uint8Array(poster.bytes), {
    headers: {
      "Content-Type": poster.contentType,
      "Content-Length": String(poster.bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": "inline",
    },
  });
}

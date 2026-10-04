import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { requireActiveUser } from "@/server/auth/authorization";
import { getSessionFromHeaders } from "@/server/auth/session";
import { AppError, errorResponse } from "@/server/services/errors";
import { MAX_POSTER_BYTES, uploadTournamentPoster } from "@/server/services/poster-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const session = await getSessionFromHeaders(await headers());
    const user = await requireActiveUser(session);
    const { slug } = await params;

    // 先按声明大小拒绝（留 64 KiB 给表单边界与说明文字），避免把超大请求体整个读进内存。
    if (Number(request.headers.get("content-length") ?? "0") > MAX_POSTER_BYTES + 64 * 1024) {
      throw new AppError(413, "poster_too_large", "海报文件超过 2 MiB 上限。");
    }
    const form = await request.formData();
    const file = form.get("poster");
    if (!(file instanceof File)) throw new AppError(400, "poster_missing", "请选择要上传的海报文件。");
    if (file.size > MAX_POSTER_BYTES) throw new AppError(413, "poster_too_large", "海报文件超过 2 MiB 上限。");

    const altValue = form.get("posterAlt");
    const result = await uploadTournamentPoster(user.id, slug, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      alt: typeof altValue === "string" ? altValue : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

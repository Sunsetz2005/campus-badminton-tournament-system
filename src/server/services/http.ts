import { AppError } from "@/server/services/errors";

/** 读取有大小上限的 JSON 请求体；超限或格式错误一律按 4xx 拒绝，不把原文写进日志。 */
export async function readJsonBody(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new AppError(413, "body_too_large", "请求内容过大。");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new AppError(413, "body_too_large", "请求内容过大。");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "请求格式无效。");
  }
}

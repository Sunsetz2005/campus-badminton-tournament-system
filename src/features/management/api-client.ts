"use client";

export interface ApiFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

/**
 * 管理端与报名页共用的请求封装。只有收到服务端确认才返回 ok；
 * 网络失败按「结果未知」提示，不假装成功。
 */
export async function sendJson<T>(url: string, method: "POST" | "PATCH", body?: unknown): Promise<ApiResult<T>> {
  return send<T>(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function sendForm<T>(url: string, form: FormData): Promise<ApiResult<T>> {
  return send<T>(url, { method: "POST", body: form });
}

async function send<T>(url: string, init: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    return { ok: false, error: { code: "network_error", message: "网络中断，未确认是否提交成功。请刷新页面核对后再操作。" } };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // 非 JSON 响应按失败处理。
  }
  if (response.ok) return { ok: true, data: payload as T };
  const error = (payload as { error?: ApiFailure } | null)?.error;
  return {
    ok: false,
    error: error ?? { code: `http_${response.status}`, message: "服务暂时不可用，请稍后重试。" },
  };
}

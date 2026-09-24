import { NextResponse } from "next/server";

import { logServerEvent } from "@/server/logging";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** 供界面继续操作的结构化信息（如身份候选人）；只放调用者本就有权看到的数据。 */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown, fields: Record<string, unknown> = {}) {
  if (error instanceof AppError) {
    logServerEvent("request_failed", {
      ...fields,
      status: error.status,
      code: error.code,
    });
    return NextResponse.json(
      { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } },
      { status: error.status },
    );
  }
  logServerEvent("request_failed", {
    ...fields,
    status: 500,
    code: "internal_error",
  });
  return NextResponse.json(
    { error: { code: "internal_error", message: "服务暂时不可用，请稍后重试。" } },
    { status: 500 },
  );
}

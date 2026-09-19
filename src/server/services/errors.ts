import { NextResponse } from "next/server";

import { logServerEvent } from "@/server/logging";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
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
      { error: { code: error.code, message: error.message } },
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

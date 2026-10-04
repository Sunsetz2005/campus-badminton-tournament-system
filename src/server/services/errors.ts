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
    ...describeUnexpectedError(error),
  });
  return NextResponse.json(
    { error: { code: "internal_error", message: "服务暂时不可用，请稍后重试。" } },
    { status: 500 },
  );
}

/**
 * 阶段 8：未知错误此前只记「500」，出了问题无从排查。这里只记错误类型、数据库/驱动错误码
 * 和截断后的消息（日志字段仍经 logServerEvent 脱敏），不记请求体与堆栈。
 */
export function describeUnexpectedError(error: unknown) {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = (error as { code?: unknown }).code;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return {
    errorName: error.name,
    ...(typeof code === "string" ? { errorCode: code } : {}),
    ...(typeof causeCode === "string" ? { causeCode } : {}),
    errorMessage: error.message.replace(/\s+/g, " ").slice(0, 300),
  };
}

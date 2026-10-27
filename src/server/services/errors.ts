import { NextResponse } from "next/server";

import { logServerEvent } from "@/server/logging";
import { classifyTransientDatabaseError, type TransientDatabaseFailure } from "@/server/services/transaction-retry";

/**
 * SF-01 / SF-03 / SF-04：可以原样重发的数据库失败，返回 503 + Retry-After，与真正的程序错误（500）分开。
 * 冲突与等连接超时发生在提交之前，事务已整体回滚，可以明确说「没有保存」；
 * 连接中途断开可能恰好落在提交时，结果未知，只提示重发——记分命令靠 commandId 幂等对账。
 */
const TRANSIENT_RESPONSES: Record<TransientDatabaseFailure, { code: string; message: string; retryAfterSeconds: number }> = {
  conflict: { code: "write_conflict", message: "同时提交的人较多，本次没有保存。请直接重新提交，不会重复记录。", retryAfterSeconds: 1 },
  busy: { code: "service_busy", message: "服务繁忙，本次没有保存。请稍等几秒后直接重新提交。", retryAfterSeconds: 2 },
  unavailable: { code: "database_unavailable", message: "数据库暂时连接不上，请稍后重新提交；记分会按原命令编号核对，不会重复记录。", retryAfterSeconds: 3 },
};

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
  const transient = classifyTransientDatabaseError(error);
  if (transient) {
    const response = TRANSIENT_RESPONSES[transient];
    logServerEvent("request_failed", {
      ...fields,
      status: 503,
      code: response.code,
      ...describeUnexpectedError(error),
    });
    return NextResponse.json(
      { error: { code: response.code, message: response.message, retryable: true } },
      { status: 503, headers: { "Retry-After": String(response.retryAfterSeconds) } },
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

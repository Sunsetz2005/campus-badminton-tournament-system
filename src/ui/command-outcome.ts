/**
 * R3-003：把「有结构、可核对的明确拒绝」和「结果未知」分开。
 *
 * HTTP 5xx、网络中断、超时、200 但响应结构不符，都不能证明命令没有落库，
 * 因此必须保留原 commandId 以便查询或按原 ID 重试；
 * 只有服务器给出可核对的业务拒绝时，才允许退出该待确认流程。
 */

export type UnknownReason = "NETWORK" | "TIMEOUT" | "SERVER_ERROR" | "MALFORMED_RESPONSE";

export type CommandOutcome =
  | { kind: "ACCEPTED"; commandId: string; version: number; state: unknown; events: unknown[] }
  | { kind: "DEFINITE_REJECTION"; status: number; code: string; message: string }
  | { kind: "UNKNOWN"; reason: UnknownReason; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACCEPTED_STATUSES = new Set(["accepted", "duplicate"]);

export interface CommandResponseInput {
  ok: boolean;
  status: number;
  body: unknown;
  /** 期望的 commandId：成功响应必须与原命令一致才允许核销。 */
  commandId: string;
}

/**
 * 成功响应必须同时满足：状态是 accepted/duplicate、commandId 与原命令一致、
 * version 与 state.version 自洽。任何一项不符都按结果未知处理，不清除待确认命令。
 */
export function classifyCommandResponse(input: CommandResponseInput): CommandOutcome {
  const { ok, status, body, commandId } = input;
  if (!ok) {
    const code = isPlainObject(body) && isPlainObject(body.error) && typeof body.error.code === "string"
      ? body.error.code
      : null;
    const message = isPlainObject(body) && isPlainObject(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : "服务器请求失败。";
    if (status >= 400 && status < 500 && code) {
      return { kind: "DEFINITE_REJECTION", status, code, message };
    }
    return {
      kind: "UNKNOWN",
      reason: "SERVER_ERROR",
      message: `服务器返回 ${status}，无法确定该命令是否已经落库。${message}`,
    };
  }
  if (!isPlainObject(body)) {
    return { kind: "UNKNOWN", reason: "MALFORMED_RESPONSE", message: "服务器响应不是有效的 JSON 对象。" };
  }
  if (typeof body.status !== "string" || !ACCEPTED_STATUSES.has(body.status)) {
    return { kind: "UNKNOWN", reason: "MALFORMED_RESPONSE", message: "服务器响应缺少可识别的命令状态。" };
  }
  if (body.commandId !== commandId) {
    return { kind: "UNKNOWN", reason: "MALFORMED_RESPONSE", message: "服务器响应的 commandId 与原命令不一致。" };
  }
  if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 0) {
    return { kind: "UNKNOWN", reason: "MALFORMED_RESPONSE", message: "服务器响应缺少有效版本号。" };
  }
  if (!isPlainObject(body.state) || body.state.version !== body.version) {
    return { kind: "UNKNOWN", reason: "MALFORMED_RESPONSE", message: "服务器响应缺少与版本一致的比赛状态。" };
  }
  return {
    kind: "ACCEPTED",
    commandId,
    version: body.version,
    state: body.state,
    events: Array.isArray(body.events) ? body.events : [],
  };
}

/** 请求根本没有得到响应（断网、超时、中止）时一律是结果未知。 */
export function classifyRequestFailure(error: unknown): Extract<CommandOutcome, { kind: "UNKNOWN" }> {
  const aborted = typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
  return {
    kind: "UNKNOWN",
    reason: aborted ? "TIMEOUT" : "NETWORK",
    message: aborted
      ? "请求超时，服务器可能已经处理该命令，正在按原 commandId 对账。"
      : "网络中断，服务器可能已经处理该命令，正在按原 commandId 对账。",
  };
}

/**
 * R3-002：界面采用哪个权威快照，由单调版本策略统一决定。
 *
 * 「命令是否已被服务器处理」和「界面应当显示哪个权威状态」是两件事：
 * 历史回执可以核销待确认命令，但绝不能把界面写回更旧的版本，
 * 也不能因为核销成功就把过期数据标成新鲜。
 */

export interface VersionedStatePayload {
  version: number;
  state: { version: number };
  events?: unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 响应必须带有自洽的版本与状态，才可能被当作权威快照采用。 */
export function parseVersionedStatePayload(body: unknown): VersionedStatePayload | null {
  if (!isPlainObject(body)) return null;
  const { version, state } = body;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return null;
  if (!isPlainObject(state)) return null;
  if (state.version !== version) return null;
  if (body.events !== undefined && !Array.isArray(body.events)) return null;
  return body as unknown as VersionedStatePayload;
}

export type SnapshotAdoption =
  | { kind: "APPLY"; payload: VersionedStatePayload }
  | { kind: "IGNORE_STALE"; version: number }
  | { kind: "INVALID_PAYLOAD" };

/**
 * 单调采用规则：只有版本不低于本机已知最新版本的合法快照才写入界面。
 * 迟到的旧版本响应（重复 POST 回执、乱序轮询、按原 commandId 找回的历史回执）一律忽略。
 */
export function decideSnapshotAdoption(latestKnownVersion: number, body: unknown): SnapshotAdoption {
  const payload = parseVersionedStatePayload(body);
  if (!payload) return { kind: "INVALID_PAYLOAD" };
  if (payload.version < latestKnownVersion) return { kind: "IGNORE_STALE", version: payload.version };
  return { kind: "APPLY", payload };
}

/**
 * R3-003：待确认命令的本地存储必须容错。
 *
 * 读取失败、JSON 损坏、写入被拒绝都不能崩溃，也不能把未确认的操作直接清空后显示同步成功。
 * 无法解析时保留原始内容并进入受控恢复，让裁判可以安全核对，而不是静默丢失一分。
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingEnvelope {
  commandId: string;
  occurredAt: string;
  expectedVersion: number;
  scoringSessionId: string;
  takeoverGeneration: number;
  type: string;
  payload: unknown;
}

export type PendingRead =
  | { kind: "NONE" }
  | { kind: "PENDING"; envelope: PendingEnvelope }
  | { kind: "UNREADABLE"; message: string };

function isPendingEnvelope(value: unknown): value is PendingEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.commandId === "string" && record.commandId.length > 0 &&
    typeof record.occurredAt === "string" &&
    typeof record.expectedVersion === "number" && Number.isInteger(record.expectedVersion) &&
    typeof record.scoringSessionId === "string" &&
    typeof record.takeoverGeneration === "number" &&
    typeof record.type === "string" && record.type.length > 0
  );
}

export function readPendingCommand(storage: StorageLike | null | undefined, key: string): PendingRead {
  if (!storage) return { kind: "UNREADABLE", message: "本机存储不可用，无法确认是否还有未完成的命令，已切换为只读核对。" };
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { kind: "UNREADABLE", message: "读取本机待确认命令失败，已切换为只读核对，请先在服务器端核对最近一次操作。" };
  }
  if (raw === null) return { kind: "NONE" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: "UNREADABLE",
      message: "本机待确认命令记录已损坏，未自动清除。请在比赛记录中核对最近一次操作是否已生效，再手动解除。",
    };
  }
  if (!isPendingEnvelope(parsed)) {
    return {
      kind: "UNREADABLE",
      message: "本机待确认命令记录缺少必要字段，未自动清除。请核对服务器记录后再继续操作。",
    };
  }
  return { kind: "PENDING", envelope: parsed };
}

export interface StorageWriteResult {
  ok: boolean;
  message?: string;
}

export function writePendingCommand(
  storage: StorageLike | null | undefined,
  key: string,
  envelope: PendingEnvelope,
): StorageWriteResult {
  if (!storage) return { ok: false, message: "本机存储不可用，无法登记待确认命令，已阻止本次提交。" };
  try {
    storage.setItem(key, JSON.stringify(envelope));
    return { ok: true };
  } catch {
    return { ok: false, message: "本机存储写入被拒绝，无法登记待确认命令，已阻止本次提交以免结果无法对账。" };
  }
}

/** 只有确定该命令已被核销（明确拒绝或已核对的成功回执）时才调用。 */
export function clearPendingCommand(storage: StorageLike | null | undefined, key: string): StorageWriteResult {
  if (!storage) return { ok: false, message: "本机存储不可用，无法清除待确认命令记录。" };
  try {
    storage.removeItem(key);
    return { ok: true };
  } catch {
    return { ok: false, message: "本机存储清除失败，待确认提示可能仍会出现，请刷新后再核对。" };
  }
}

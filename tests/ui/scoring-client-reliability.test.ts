import { describe, expect, it } from "vitest";

import { decideSnapshotAdoption, parseVersionedStatePayload } from "@/ui/authoritative-snapshot";
import { classifyCommandResponse, classifyRequestFailure } from "@/ui/command-outcome";
import {
  clearPendingCommand,
  readPendingCommand,
  writePendingCommand,
  type PendingEnvelope,
  type StorageLike,
} from "@/ui/pending-command-store";
import {
  createCommandId,
  detectCommandIdCapability,
  randomUuidFromSecureBytes,
} from "@/ui/secure-command-id";

function snapshotBody(version: number, extra: Record<string, unknown> = {}) {
  return { status: "accepted", version, state: { version, score: { A: 1, B: 0 } }, events: [], ...extra };
}

function envelope(commandId: string, expectedVersion = 8): PendingEnvelope {
  return {
    commandId,
    occurredAt: "2026-09-21T10:00:00.000Z",
    expectedVersion,
    scoringSessionId: "session-1",
    takeoverGeneration: 1,
    type: "RALLY_WON",
    payload: { side: "A" },
  };
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
}

describe("R3-002 权威快照采用使用单调版本策略", () => {
  it("已取得 v12 后，按原 commandId 找回的 v8 历史回执不得写回界面", () => {
    const decision = decideSnapshotAdoption(12, snapshotBody(8, { commandId: "cmd-old" }));
    expect(decision).toEqual({ kind: "IGNORE_STALE", version: 8 });
  });

  it("重复 POST 返回较旧的已存回执同样被忽略", () => {
    expect(decideSnapshotAdoption(12, snapshotBody(11, { status: "duplicate" })).kind).toBe("IGNORE_STALE");
  });

  it("等于或高于已知版本的合法快照才被采用", () => {
    expect(decideSnapshotAdoption(12, snapshotBody(12)).kind).toBe("APPLY");
    expect(decideSnapshotAdoption(12, snapshotBody(13)).kind).toBe("APPLY");
  });

  it("版本与状态不自洽、缺状态或非法版本的响应不被当作权威快照", () => {
    expect(decideSnapshotAdoption(0, { version: 9, state: { version: 8 } }).kind).toBe("INVALID_PAYLOAD");
    expect(decideSnapshotAdoption(0, { version: 9 }).kind).toBe("INVALID_PAYLOAD");
    expect(decideSnapshotAdoption(0, { version: -1, state: { version: -1 } }).kind).toBe("INVALID_PAYLOAD");
    expect(decideSnapshotAdoption(0, { version: 1.5, state: { version: 1.5 } }).kind).toBe("INVALID_PAYLOAD");
    expect(decideSnapshotAdoption(0, "not json object").kind).toBe("INVALID_PAYLOAD");
    expect(parseVersionedStatePayload({ version: 3, state: { version: 3 }, events: "x" })).toBeNull();
  });

  it("命令回执被核销与界面采用快照是两条独立判定", () => {
    const body = snapshotBody(8, { commandId: "cmd-old" });
    // 命令确实已被服务器处理，可以核销；但界面版本仍停在 12。
    expect(classifyCommandResponse({ ok: true, status: 200, body, commandId: "cmd-old" }).kind).toBe("ACCEPTED");
    expect(decideSnapshotAdoption(12, body).kind).toBe("IGNORE_STALE");
  });
});

describe("R3-003 明确拒绝与结果未知必须分开", () => {
  it("服务器落库后代理返回 502/504 属于结果未知", () => {
    for (const status of [500, 502, 503, 504]) {
      const outcome = classifyCommandResponse({ ok: false, status, body: null, commandId: "cmd-1" });
      expect(outcome).toMatchObject({ kind: "UNKNOWN", reason: "SERVER_ERROR" });
    }
  });

  it("网络中断与超时都属于结果未知", () => {
    expect(classifyRequestFailure(new TypeError("Failed to fetch"))).toMatchObject({ reason: "NETWORK" });
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyRequestFailure(aborted)).toMatchObject({ reason: "TIMEOUT" });
  });

  it("200 但 JSON 无效、缺 state、版本不符或 commandId 不符都不算成功", () => {
    const cases: unknown[] = [
      "<html>gateway</html>",
      { status: "accepted", version: 3, commandId: "cmd-1" },
      { status: "accepted", version: 3, state: { version: 2 }, commandId: "cmd-1" },
      { status: "accepted", version: 3, state: { version: 3 }, commandId: "other" },
      { version: 3, state: { version: 3 }, commandId: "cmd-1" },
    ];
    for (const body of cases) {
      expect(classifyCommandResponse({ ok: true, status: 200, body, commandId: "cmd-1" })).toMatchObject({
        kind: "UNKNOWN",
        reason: "MALFORMED_RESPONSE",
      });
    }
  });

  it("有结构的 4xx 业务拒绝才是明确拒绝", () => {
    const outcome = classifyCommandResponse({
      ok: false,
      status: 409,
      body: { error: { code: "conflict", message: "比赛版本已更新。" } },
      commandId: "cmd-1",
    });
    expect(outcome).toEqual({ kind: "DEFINITE_REJECTION", status: 409, code: "conflict", message: "比赛版本已更新。" });
  });

  it("4xx 但没有可核对错误码时仍按结果未知处理", () => {
    expect(classifyCommandResponse({ ok: false, status: 404, body: "<html>", commandId: "cmd-1" })).toMatchObject({
      kind: "UNKNOWN",
      reason: "SERVER_ERROR",
    });
  });

  it("commandId、版本与状态全部核对通过才允许核销", () => {
    const outcome = classifyCommandResponse({
      ok: true,
      status: 200,
      body: snapshotBody(8, { commandId: "cmd-1", status: "duplicate" }),
      commandId: "cmd-1",
    });
    expect(outcome).toMatchObject({ kind: "ACCEPTED", commandId: "cmd-1", version: 8 });
  });
});

describe("R3-003 本地存储容错", () => {
  const key = "badminton-pending:MD-DEMO-002";

  it("没有待确认命令时返回 NONE", () => {
    expect(readPendingCommand(memoryStorage(), key)).toEqual({ kind: "NONE" });
  });

  it("JSON 损坏时不清空记录，进入受控恢复", () => {
    const storage = memoryStorage({ [key]: "{not-json" });
    const read = readPendingCommand(storage, key);
    expect(read.kind).toBe("UNREADABLE");
    expect(storage.data[key]).toBe("{not-json");
  });

  it("字段缺失的待确认记录同样不被当成没有待办", () => {
    const storage = memoryStorage({ [key]: JSON.stringify({ commandId: "cmd-1" }) });
    expect(readPendingCommand(storage, key).kind).toBe("UNREADABLE");
    expect(storage.data[key]).toBeDefined();
  });

  it("读取抛错时进入只读核对而不是崩溃", () => {
    const storage: StorageLike = {
      getItem: () => { throw new DOMException("denied"); },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readPendingCommand(storage, key).kind).toBe("UNREADABLE");
    expect(readPendingCommand(null, key).kind).toBe("UNREADABLE");
  });

  it("setItem 被拒绝时阻止提交，而不是提交后无法对账", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new DOMException("QuotaExceededError"); },
      removeItem: () => {},
    };
    const result = writePendingCommand(storage, key, envelope("cmd-1"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("阻止本次提交");
  });

  it("不同标签页各自的键互不影响，旧控制会话的待确认命令不会被复用", () => {
    const storage = memoryStorage();
    writePendingCommand(storage, "badminton-pending:MD-DEMO-002", envelope("cmd-a"));
    writePendingCommand(storage, "badminton-pending:MS-DEMO-001", envelope("cmd-b"));
    const first = readPendingCommand(storage, "badminton-pending:MD-DEMO-002");
    const second = readPendingCommand(storage, "badminton-pending:MS-DEMO-001");
    expect(first.kind === "PENDING" && first.envelope.commandId).toBe("cmd-a");
    expect(second.kind === "PENDING" && second.envelope.commandId).toBe("cmd-b");
    clearPendingCommand(storage, "badminton-pending:MD-DEMO-002");
    expect(readPendingCommand(storage, "badminton-pending:MD-DEMO-002")).toEqual({ kind: "NONE" });
    expect(readPendingCommand(storage, "badminton-pending:MS-DEMO-001").kind).toBe("PENDING");
  });
});

describe("R3-005 命令 ID 的安全随机能力检测", () => {
  const bytesOnly = {
    getRandomValues: <T extends ArrayBufferView>(array: T) => {
      const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let index = 0; index < view.length; index += 1) view[index] = (index * 37 + 11) % 256;
      return array;
    },
  };

  it("安全上下文下优先使用 crypto.randomUUID", () => {
    const capability = detectCommandIdCapability({ randomUUID: () => "uuid", getRandomValues: bytesOnly.getRandomValues }, true);
    expect(capability).toEqual({ available: true, source: "CRYPTO_RANDOM_UUID" });
  });

  it("非安全上下文缺少 randomUUID 时使用 getRandomValues，并给出 HTTPS 提示", () => {
    const capability = detectCommandIdCapability(bytesOnly, false);
    expect(capability).toMatchObject({ available: true, source: "CRYPTO_GET_RANDOM_VALUES" });
    expect(capability.available && "advisory" in capability && capability.advisory).toContain("HTTPS");
  });

  it("两种安全随机源都缺失时不可写入，并给出可理解的原因", () => {
    const capability = detectCommandIdCapability({}, false);
    expect(capability.available).toBe(false);
    expect(capability.available === false && capability.reason).toContain("只读");
    expect(() => createCommandId({}, false)).toThrow(/只读/);
    expect(detectCommandIdCapability(undefined, true).available).toBe(false);
  });

  it("兼容路径生成的 UUID 符合 RFC 4122 第 4 版格式且不使用 Math.random", () => {
    const value = randomUuidFromSecureBytes(bytesOnly);
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createCommandId(bytesOnly, false)).toMatch(/^[0-9a-f]{8}-/);
  });
});

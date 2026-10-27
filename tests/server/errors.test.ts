import { afterEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { AppError, errorResponse } from "@/server/services/errors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("结构化错误日志", () => {
  it("记录错误代码与路由并脱敏请求字段", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = errorResponse(new AppError(403, "forbidden", "无权操作。"), {
      route: "/api/example",
      actorUserId: "user-1",
      authorization: "Bearer should-not-appear",
      nested: { password: "should-not-appear" },
    });

    expect(response.status).toBe(403);
    expect(info).toHaveBeenCalledOnce();
    const logged = JSON.parse(String(info.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({
      event: "request_failed",
      status: 403,
      code: "forbidden",
      route: "/api/example",
      actorUserId: "user-1",
      authorization: "[REDACTED]",
      nested: { password: "[REDACTED]" },
    });
    expect(JSON.stringify(logged)).not.toContain("should-not-appear");
  });
});

describe("可重发的数据库失败返回 503（SF-01 / SF-03 / SF-04）", () => {
  function prismaError(code: string, message = "模拟错误", meta?: Record<string, unknown>) {
    return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test", meta });
  }

  it.each([
    ["P2034 重试耗尽", prismaError("P2034"), "write_conflict", "1"],
    ["P2028 等连接超时", prismaError("P2028"), "service_busy", "2"],
    ["P1001 库不可达", prismaError("P1001"), "database_unavailable", "3"],
    ["P2039 连接被终止", prismaError("P2039", "Database error. Code: `57P01`. Message: `terminating connection due to administrator command`"), "database_unavailable", "3"],
    ["pg 连接中途断开", new Error("Connection terminated unexpectedly"), "database_unavailable", "3"],
  ])("%s", async (_label, error, code, retryAfter) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = errorResponse(error, { route: "/api/example" });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe(retryAfter);
    const body = await response.json();
    expect(body.error).toMatchObject({ code, retryable: true });
  });

  it("其他未知错误仍是 500", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const response = errorResponse(new TypeError("bug"));
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("internal_error");
    expect(errorResponse(prismaError("P2002")).status).toBe(500);
  });
});

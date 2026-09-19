import { afterEach, describe, expect, it, vi } from "vitest";

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

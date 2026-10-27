import { describe, expect, it } from "vitest";

import { publicCacheTtlFromEnv, SharedReadCache } from "@/server/cache/shared-read-cache";
import { AppError } from "@/server/services/errors";

describe("公开查询短时共享缓存（SF-06）", () => {
  it("同一时刻的并发请求只查一次，过期后重新查", async () => {
    let now = 0;
    let loads = 0;
    const cache = new SharedReadCache(2_000, 100, () => now);
    const load = async () => {
      loads += 1;
      return { loads };
    };
    const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
    now = 1_999;
    await cache.get("k", load);
    expect(loads).toBe(1);
    now = 2_000;
    expect(await cache.get("k", load)).toEqual({ loads: 2 });
  });

  it("业务 404 会缓存，数据库故障不缓存", async () => {
    const cache = new SharedReadCache(2_000, 100, () => 0);
    let calls = 0;
    const notFound = async () => {
      calls += 1;
      throw new AppError(404, "tournament_not_found", "不存在");
    };
    await expect(cache.get("a", notFound)).rejects.toBeInstanceOf(AppError);
    await expect(cache.get("a", notFound)).rejects.toBeInstanceOf(AppError);
    expect(calls).toBe(1);
    const failing = async () => {
      calls += 1;
      throw new Error("Connection terminated unexpectedly");
    };
    await expect(cache.get("b", failing)).rejects.toThrow();
    await expect(cache.get("b", failing)).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it("TTL 为 0 时不缓存；生产默认 2 秒，其他环境默认关闭", async () => {
    const cache = new SharedReadCache(0);
    let loads = 0;
    await cache.get("k", async () => ++loads);
    await cache.get("k", async () => ++loads);
    expect(loads).toBe(2);
    expect(publicCacheTtlFromEnv(undefined, "production")).toBe(2_000);
    expect(publicCacheTtlFromEnv(undefined, "development")).toBe(0);
    expect(publicCacheTtlFromEnv("500", "test")).toBe(500);
    expect(publicCacheTtlFromEnv("x", "production")).toBe(2_000);
  });
});

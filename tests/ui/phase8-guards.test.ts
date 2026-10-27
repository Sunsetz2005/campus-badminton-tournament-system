import { describe, expect, it } from "vitest";

import {
  checkWriteOrigin,
  DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE,
  publicRateLimitFromEnv,
  TokenBucketRateLimiter,
} from "@/server/security/request-guard";
import { sanitizeLogFields } from "@/server/logging";
import { describeWakeLock, wakeLockAvailability } from "@/ui/screen-wake-lock";

const base = {
  method: "POST",
  origin: null as string | null,
  secFetchSite: null as string | null,
  requestHosts: ["192.168.1.20:3000", null] as (string | null)[],
  trustedOrigins: ["http://localhost:3000"],
};

describe("阶段 8：写请求来源校验", () => {
  it("安全方法一律放行", () => {
    expect(checkWriteOrigin({ ...base, method: "GET", origin: "https://evil.example" })).toEqual({ allowed: true });
  });

  it("Origin 与请求 Host 相同即放行（手机经局域网 IP 访问）", () => {
    expect(checkWriteOrigin({ ...base, origin: "http://192.168.1.20:3000" }).allowed).toBe(true);
  });

  it("反向代理转发的 x-forwarded-host 也视为本站", () => {
    expect(checkWriteOrigin({
      ...base,
      origin: "https://match.example.edu",
      requestHosts: ["app:3000", "match.example.edu"],
    }).allowed).toBe(true);
  });

  it("配置信任的来源放行", () => {
    expect(checkWriteOrigin({ ...base, origin: "http://localhost:3000" }).allowed).toBe(true);
  });

  it("跨站 Origin 拒绝，端口不同也算跨站", () => {
    expect(checkWriteOrigin({ ...base, origin: "https://evil.example" })).toEqual({ allowed: false, reason: "cross_origin" });
    expect(checkWriteOrigin({ ...base, origin: "http://192.168.1.20:4000" }).allowed).toBe(false);
  });

  it("字面量 null 与不可解析的 Origin 拒绝", () => {
    expect(checkWriteOrigin({ ...base, origin: "null" })).toEqual({ allowed: false, reason: "opaque_origin" });
    expect(checkWriteOrigin({ ...base, origin: "not a url" })).toEqual({ allowed: false, reason: "opaque_origin" });
  });

  it("没有 Origin 时按 Sec-Fetch-Site 判定；两者都没有（非浏览器客户端）放行", () => {
    expect(checkWriteOrigin({ ...base, secFetchSite: "same-origin" }).allowed).toBe(true);
    expect(checkWriteOrigin({ ...base, secFetchSite: "cross-site" }).allowed).toBe(false);
    expect(checkWriteOrigin({ ...base, secFetchSite: "same-site" }).allowed).toBe(false);
    expect(checkWriteOrigin({ ...base }).allowed).toBe(true);
  });
});

describe("阶段 8：公开查询限流", () => {
  it("突发额度用完后按每分钟额度匀速放行，并给出重试秒数（SF-06）", () => {
    // 每分钟 60 次 = 每秒补 1 个，突发上限 3。
    const limiter = new TokenBucketRateLimiter(60, 3);
    expect(limiter.hit("a", 0)).toEqual({ allowed: true, remaining: 2 });
    limiter.hit("a", 0);
    expect(limiter.hit("a", 0)).toEqual({ allowed: true, remaining: 0 });
    expect(limiter.hit("a", 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.hit("b", 0).allowed).toBe(true);
    expect(limiter.hit("a", 1_000).allowed).toBe(true);
    expect(limiter.hit("a", 1_000).allowed).toBe(false);
  });

  it("同一来源持续超量时，一分钟内放行总数不超过额度，且不会在某一时刻集中放行（SF-06）", () => {
    const limiter = new TokenBucketRateLimiter(600);
    const admittedAt: number[] = [];
    // 300 名观众各每 10 秒请求一次，共 1800 次/分钟，全部同一来源；连续两分钟。
    for (let t = 0; t < 120_000; t += 10_000 / 300) {
      if (limiter.hit("nat", Math.floor(t)).allowed) admittedAt.push(t);
    }
    // 第一分钟多出的只是初始突发额度（600 / 6 = 100），之后稳定在每分钟 600 次。
    expect(admittedAt.filter((t) => t < 60_000).length).toBeLessThanOrEqual(700 + 1);
    expect(admittedAt.filter((t) => t >= 60_000).length).toBeLessThanOrEqual(600 + 1);
    // 固定窗口下每分钟开头 20 秒放行全部 600 次；令牌桶下约为 20 秒补充的 200 次。
    const secondMinuteHead = admittedAt.filter((t) => t >= 60_000 && t < 80_000).length;
    expect(secondMinuteHead).toBeLessThan(220);
  });

  it("键数达到上限时不跟踪新来源（放行而不是误伤），补满的桶会被清理", () => {
    const limiter = new TokenBucketRateLimiter(60, 1, 2);
    limiter.hit("a", 0);
    limiter.hit("b", 0);
    expect(limiter.hit("c", 10).allowed).toBe(true);
    expect(limiter.hit("c", 20).allowed).toBe(true);
    expect(limiter.hit("d", 2_000)).toEqual({ allowed: true, remaining: 0 });
    expect(limiter.hit("d", 2_001).allowed).toBe(false);
  });

  it("环境变量非法时回落默认值，0 表示关闭", () => {
    expect(publicRateLimitFromEnv(undefined)).toBe(DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE);
    expect(publicRateLimitFromEnv("abc")).toBe(DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE);
    expect(publicRateLimitFromEnv("-1")).toBe(DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE);
    expect(publicRateLimitFromEnv("0")).toBe(0);
    expect(publicRateLimitFromEnv("120")).toBe(120);
  });
});

describe("阶段 8：日志脱敏", () => {
  it("凭据与个人信息字段一律替换，嵌套与数组同样处理", () => {
    expect(sanitizeLogFields({
      route: "/api/x",
      controlToken: "t",
      email: "a@b.c",
      nested: [{ studentId: "2026001", contact: "138", realName: "张三", code: "ok" }],
    })).toEqual({
      route: "/api/x",
      controlToken: "[REDACTED]",
      email: "[REDACTED]",
      nested: [{ studentId: "[REDACTED]", contact: "[REDACTED]", realName: "[REDACTED]", code: "ok" }],
    });
  });
});

describe("阶段 8：屏幕常亮的人工替代提示", () => {
  it("非安全上下文与不支持的浏览器分别给出提示", () => {
    expect(wakeLockAvailability({ isSecureContext: false, hasWakeLock: true })).toBe("INSECURE_CONTEXT");
    expect(wakeLockAvailability({ isSecureContext: true, hasWakeLock: false })).toBe("UNSUPPORTED");
    expect(wakeLockAvailability({ isSecureContext: true, hasWakeLock: true })).toBeNull();
    expect(describeWakeLock("INSECURE_CONTEXT").hint).toMatch(/HTTPS/);
    expect(describeWakeLock("UNSUPPORTED").hint).toMatch(/自动锁定/);
    expect(describeWakeLock("DENIED").hint).toMatch(/低电量/);
    expect(describeWakeLock("ACTIVE").hint).toBeNull();
  });
});

describe("阶段 8：公开页面的限流上限", () => {
  it("页面默认上限高于接口，自定义值与关闭同样生效", async () => {
    const { DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE } = await import("@/server/security/request-guard");
    expect(DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE).toBeGreaterThan(DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE);
    expect(publicRateLimitFromEnv(undefined, DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE)).toBe(DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE);
    expect(publicRateLimitFromEnv("x", DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE)).toBe(DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE);
    expect(publicRateLimitFromEnv("0", DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE)).toBe(0);
  });
});

describe("阶段 8：导入限制", () => {
  it("导入文件为空或超过 256 KiB 时拒绝，不尝试解码", async () => {
    const { decodeImportBytes } = await import("@/server/services/registration-import-service");
    const { IMPORT_LIMITS } = await import("@/domain/registration/import-plan");
    expect(() => decodeImportBytes(new Uint8Array())).toThrow(expect.objectContaining({ status: 400, code: "import_empty" }));
    expect(() => decodeImportBytes(new Uint8Array(IMPORT_LIMITS.maxBytes + 1))).toThrow(
      expect.objectContaining({ status: 413, code: "import_too_large" }),
    );
    expect(decodeImportBytes(new TextEncoder().encode("姓名\n张三"))).toBe("姓名\n张三");
  });

  it("声明长度超限的导入请求在读取表单前被拒绝", async () => {
    const { readImportUpload } = await import("@/server/services/upload");
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-length": String(10 * 1024 * 1024) },
      body: "x",
    });
    await expect(readImportUpload(request)).rejects.toMatchObject({ status: 413, code: "import_too_large" });
  });
});

describe("阶段 8：登录受信来源", () => {
  it("生产只信任显式配置；开发另信任本机局域网地址与 localhost", async () => {
    const { configuredTrustedOrigins, developmentLanOrigins, parseOriginList } = await import("@/server/security/trusted-origins");
    expect(parseOriginList("http://a.test:3000/, bad, https://b.test")).toEqual(["http://a.test:3000", "https://b.test"]);
    expect(configuredTrustedOrigins({
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://match.example.edu",
      APP_TRUSTED_ORIGINS: "https://m.example.edu",
    } as NodeJS.ProcessEnv)).toEqual(["https://match.example.edu", "https://m.example.edu"]);
    const lan = developmentLanOrigins("http://127.0.0.1:3000", {
      en0: [{ family: "IPv4", address: "192.168.1.20", internal: false } as never],
      lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true } as never],
      utun: [{ family: "IPv6", address: "fe80::1", internal: false } as never],
    });
    expect(lan.sort()).toEqual(["http://127.0.0.1:3000", "http://192.168.1.20:3000", "http://localhost:3000"]);
    const dev = configuredTrustedOrigins({ NODE_ENV: "development", BETTER_AUTH_URL: "http://127.0.0.1:3000" } as NodeJS.ProcessEnv);
    expect(dev).toContain("http://localhost:3000");
  });
});

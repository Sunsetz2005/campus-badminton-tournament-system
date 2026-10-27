/**
 * 请求入口的两道轻量防护，供 `src/proxy.ts` 调用；纯函数，不读数据库、不读会话。
 *
 * 1. 写请求来源校验（防请求伪造）：浏览器跨站提交会带上受害者的会话 Cookie，
 *    所以非 GET 的 `/api/*` 必须来自本站页面。判定只看浏览器无法被网页脚本伪造的
 *    `Origin` 与 `Sec-Fetch-Site`；两者都没有的请求不是浏览器发起的，也就带不上
 *    别人的 Cookie，放行交给后面的会话与权限校验。
 * 2. 公开查询按来源限流：进程内令牌桶，只是「尽力而为」。来源取自
 *    `x-forwarded-for`，没有可信反向代理时可被伪造；校园网出口 NAT 会让很多人共用
 *    一个地址，所以默认额度按「一个出口后面有上百名观众轮询」来放宽。真正的限流应在
 *    反向代理上做。
 */

export type OriginDecision = { allowed: true } | { allowed: false; reason: "cross_origin" | "opaque_origin" };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string) {
  return SAFE_METHODS.has(method.toUpperCase());
}

function hostOf(value: string) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * @param requestHosts 请求的 `Host` 与反向代理转发的 `x-forwarded-host`；跨站网页无法给
 *   本站请求加这类自定义头（会先被 CORS 预检拦下），所以把它们当作本站地址是安全的。
 * @param trustedOrigins 额外信任的完整来源，如 `BETTER_AUTH_URL`
 */
export function checkWriteOrigin(input: {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  requestHosts: readonly (string | null)[];
  trustedOrigins: readonly string[];
}): OriginDecision {
  if (isSafeMethod(input.method)) return { allowed: true };

  if (input.origin !== null) {
    // 沙箱 iframe、data: 页面等会发送字面量 "null"，无法确认来自本站。
    if (input.origin === "null") return { allowed: false, reason: "opaque_origin" };
    const originHost = hostOf(input.origin);
    if (!originHost) return { allowed: false, reason: "opaque_origin" };
    const requestHosts = input.requestHosts
      .map((host) => host?.split(",")[0]?.trim().toLowerCase())
      .filter((host): host is string => Boolean(host));
    if (requestHosts.includes(originHost)) return { allowed: true };
    if (input.trustedOrigins.some((trusted) => hostOf(trusted) === originHost)) return { allowed: true };
    return { allowed: false, reason: "cross_origin" };
  }

  const site = input.secFetchSite?.toLowerCase() ?? null;
  // "none" 是用户直接在地址栏发起的请求；"same-site" 是同一注册域下的其他子域，也拒绝。
  if (site === null || site === "same-origin" || site === "none") return { allowed: true };
  return { allowed: false, reason: "cross_origin" };
}

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * 令牌桶（SF-06）：每个来源一个桶，按「每分钟额度 / 60」的速度匀速补充，桶容量是突发上限。
 *
 * 阶段 8 原用固定窗口：所有观众共用一个出口时，窗口一开就同时放行整整一分钟的额度，
 * M6 经 nginx 实测每个窗口的 600 次放行挤在开头约 18 秒，正好压在裁判记分上（P99 10 秒、16 次 500）。
 * 令牌桶把放行摊平到整分钟，每分钟总额度不变。
 * 键数有上限，满了先清已补满（等同空闲）的桶，仍满则不再跟踪新键（放行而不是误伤）。
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly refillPerMs: number;
  private readonly capacity: number;

  constructor(
    limitPerMinute: number,
    burst = Math.max(1, Math.ceil(limitPerMinute / 6)),
    private readonly maxKeys = 10_000,
  ) {
    this.refillPerMs = limitPerMinute / 60_000;
    this.capacity = Math.max(1, Math.min(burst, limitPerMinute));
  }

  hit(key: string, now: number): RateLimitDecision {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      if (this.buckets.size >= this.maxKeys) return { allowed: true, remaining: this.capacity - 1 };
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.refillPerMs);
      bucket.updatedAt = now;
    }
    if (bucket.tokens < 1) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000)) };
    }
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }

  private sweep(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }
}

/** 公开 JSON 接口（`/api/public/*`）：给程序读取用，额度较紧。 */
export const DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE = 600;
/**
 * 公开页面（`/public/*`）：观众浏览器每 10 秒自动刷新一次。校园网出口 NAT 后几百名观众共用一个地址，
 * 阶段 8 基准里 300 名同出口观众合计每分钟约 1800 次；页面刷新被 429 会让观众页面失效，
 * 所以这里只设一个防单一来源滥用的高上限（约 500 名同出口观众），日常限流交给反向代理。
 */
export const DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE = 3000;

/** 读取限流环境变量；非法值回落默认，`0` 表示关闭（只用于本机基准测试）。 */
export function publicRateLimitFromEnv(raw: string | undefined, fallback = DEFAULT_PUBLIC_RATE_LIMIT_PER_MINUTE) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return value;
}

/** 与报名邀请限流同一口径：没有可信反向代理时，这个值只能尽力而为。 */
export function requestSourceKey(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

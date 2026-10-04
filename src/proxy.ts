import { NextResponse, type NextRequest } from "next/server";

import {
  checkWriteOrigin,
  DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE,
  FixedWindowRateLimiter,
  publicRateLimitFromEnv,
  requestSourceKey,
} from "@/server/security/request-guard";
import { configuredTrustedOrigins } from "@/server/security/trusted-origins";

/**
 * 阶段 8：请求入口的两道轻量防护（判定逻辑见 `request-guard.ts`）。
 * 这里不做会话与权限判断——那一律在路由与服务里由服务端重新解析。
 */

// 进程内计数：多实例部署时各算各的，重启后清零。
function limiterFor(limit: number) {
  return limit > 0 ? new FixedWindowRateLimiter(limit, 60_000) : null;
}
const publicApiLimiter = limiterFor(publicRateLimitFromEnv(process.env.PUBLIC_RATE_LIMIT_PER_MINUTE));
const publicPageLimiter = limiterFor(
  publicRateLimitFromEnv(process.env.PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE, DEFAULT_PUBLIC_PAGE_RATE_LIMIT_PER_MINUTE),
);

/** 与 next.config.ts 的 proxyClientMaxBodySize 一致。 */
const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

const trustedOrigins = configuredTrustedOrigins();

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Better Auth 的 /api/auth/* 自带来源校验（trustedOrigins），这里不重复拦截。
  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) {
    const decision = checkWriteOrigin({
      method: request.method,
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
      requestHosts: [request.headers.get("host"), request.headers.get("x-forwarded-host")],
      trustedOrigins,
    });
    if (!decision.allowed) {
      return NextResponse.json(
        { error: { code: "cross_origin_rejected", message: "请求来源不是本站页面，已拒绝。请从本站页面重新操作。" } },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (Number(request.headers.get("content-length") ?? "0") > MAX_API_BODY_BYTES) {
      return NextResponse.json(
        { error: { code: "payload_too_large", message: "请求内容超过 4 MiB 上限。" } },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const limiter = pathname.startsWith("/api/public/") ? publicApiLimiter : pathname.startsWith("/public/") ? publicPageLimiter : null;
  if (limiter && request.method === "GET") {
    const result = limiter.hit(requestSourceKey(request.headers), Date.now());
    if (!result.allowed) {
      const headers = { "Retry-After": String(result.retryAfterSeconds), "Cache-Control": "no-store" };
      const message = `访问过于频繁，请 ${result.retryAfterSeconds} 秒后再试。`;
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: { code: "rate_limited", message } }, { status: 429, headers })
        : new NextResponse(message, { status: 429, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*", "/public/:path*"],
};

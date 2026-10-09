import type { NextConfig } from "next";

/**
 * 阶段 8：全站基础安全响应头。不设 CSP——Next 的内联脚本需要逐请求 nonce，
 * 贸然加上会让页面失效；这一项留给正式部署在反向代理上与 HTTPS 一起配置。
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // 本站页面不需要被任何站点嵌入，防点击劫持（包括嵌入裁判工作台诱导误点）。
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    authInterrupts: true,
    // proxy 会把请求体缓冲在内存里；本站最大的合法上传是 10 MiB 海报（加表单边界）。超出部分会被截断，
    // 所以 proxy 里另按 Content-Length 以 413 提前拒绝（见 src/proxy.ts），海报以外的接口仍限 4 MiB。
    proxyClientMaxBodySize: "11mb",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

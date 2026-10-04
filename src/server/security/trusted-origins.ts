import os from "node:os";

/**
 * 登录（Better Auth）与写接口共用的受信来源。
 *
 * - 生产环境只信任显式配置：`BETTER_AUTH_URL` 与 `APP_TRUSTED_ORIGINS`（逗号分隔的完整来源）。
 * - 开发环境另外信任同一端口上的 localhost、127.0.0.1 和本机当前的局域网 IPv4 地址，
 *   这样同一 Wi-Fi 下的手机可以用 `http://Mac局域网IP:3000` 登录。地址取自本机网卡，
 *   不取自请求头，不能被外部伪造；换网络后需重启开发服务才会更新。
 */
export function parseOriginList(raw: string | undefined) {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    });
}

export function developmentLanOrigins(baseUrl: string, interfaces = os.networkInterfaces()) {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const port = base.port ? `:${base.port}` : "";
  const hosts = new Set(["localhost", "127.0.0.1"]);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) hosts.add(entry.address);
    }
  }
  return [...hosts].map((host) => `${base.protocol}//${host}${port}`);
}

export function configuredTrustedOrigins(env: NodeJS.ProcessEnv = process.env) {
  const base = env.BETTER_AUTH_URL?.trim();
  const origins = new Set<string>(parseOriginList([base, env.APP_TRUSTED_ORIGINS].filter(Boolean).join(",")));
  if (env.NODE_ENV !== "production" && base) {
    for (const origin of developmentLanOrigins(base)) origins.add(origin);
  }
  return [...origins];
}

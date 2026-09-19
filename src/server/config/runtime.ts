const INSECURE_DEVELOPMENT_AUTH_SECRET = "local-development-only-change-before-production-2026";

export function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}。`);
  return value;
}

export function assertRuntimeSecurity() {
  const secret = requireEnvironment("BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("BETTER_AUTH_SECRET 至少需要 32 个字符。");

  if (process.env.NODE_ENV !== "production") return;

  if (process.env.ENABLE_TEST_FAULT_INJECTION === "true") {
    throw new Error("生产环境禁止启用测试故障注入。");
  }

  const demoConfigured =
    process.env.ALLOW_DEMO_ACCOUNTS === "true" ||
    Boolean(process.env.DEMO_ADMIN_PASSWORD) ||
    Boolean(process.env.DEMO_REFEREE_PASSWORD);
  if (demoConfigured) throw new Error("生产环境检测到示例账号配置，拒绝启动。");
  if (secret === INSECURE_DEVELOPMENT_AUTH_SECRET || secret.includes("请替换")) {
    throw new Error("生产环境仍在使用示例认证密钥，拒绝启动。");
  }
}

export const developmentAuthSecret = INSECURE_DEVELOPMENT_AUTH_SECRET;

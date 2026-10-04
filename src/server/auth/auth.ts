import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";

import { prisma } from "@/db/client";
import { assertRuntimeSecurity, requireEnvironment } from "@/server/config/runtime";
import { configuredTrustedOrigins } from "@/server/security/trusted-origins";

assertRuntimeSecurity();

export const auth = betterAuth({
  appName: "校园羽毛球赛事管理系统",
  baseURL: requireEnvironment("BETTER_AUTH_URL"),
  secret: requireEnvironment("BETTER_AUTH_SECRET"),
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
  },
  // 允许用用户名登录；用户名只能由管理员在库里设定，公众注册仍关闭。
  plugins: [username()],
  advanced: {
    database: {
      generateId: "uuid",
    },
  },
  // 阶段 8：生产只信任显式配置；开发另信任本机局域网地址，供同一 Wi-Fi 的手机登录。
  trustedOrigins: configuredTrustedOrigins(),
});

export type AuthSession = typeof auth.$Infer.Session;

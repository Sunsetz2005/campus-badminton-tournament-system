import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth } from "better-auth";

import { prisma } from "@/db/client";
import { assertRuntimeSecurity, requireEnvironment } from "@/server/config/runtime";

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
  advanced: {
    database: {
      generateId: "uuid",
    },
  },
  trustedOrigins: [requireEnvironment("BETTER_AUTH_URL")],
});

export type AuthSession = typeof auth.$Infer.Session;

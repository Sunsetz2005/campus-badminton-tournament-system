import { spawnSync } from "node:child_process";

import { assertTestDatabaseUrl } from "../src/db/database-safety";

try {
  assertTestDatabaseUrl(process.env.DATABASE_URL);
} catch {
  console.error("生产启动安全测试仅允许使用有效且数据库名以 _test 结尾的 DATABASE_URL。");
  process.exit(1);
}

const build = spawnSync("pnpm", ["run", "build"], {
  env: {
    ...process.env,
    ALLOW_DEMO_ACCOUNTS: "false",
    BETTER_AUTH_SECRET: "production-startup-test-secret-with-more-than-32-characters",
    DEMO_ADMIN_EMAIL: "",
    DEMO_ADMIN_PASSWORD: "",
    DEMO_REFEREE_EMAIL: "",
    DEMO_REFEREE_PASSWORD: "",
    DEMO_PARTICIPANT_EMAIL: "",
    DEMO_PARTICIPANT_PASSWORD: "",
    ENABLE_PUBLIC_UI_PREVIEW: "false",
    ENABLE_TEST_FAULT_INJECTION: "false",
  },
  stdio: "inherit",
});

if (build.error) {
  console.error("无法启动生产构建命令。");
  process.exit(1);
}
process.exit(build.status ?? 1);

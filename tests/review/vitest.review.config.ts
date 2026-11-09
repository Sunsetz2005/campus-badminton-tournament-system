// 复判探针配置（非产品测试）：只运行 tests/review/*.probe.ts，不进入 pnpm test 的 include（tests/**/*.test.ts）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  root,
  resolve: { alias: { "@": path.join(root, "src") } },
  test: { environment: "node", include: ["tests/review/**/*.probe.ts"], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});

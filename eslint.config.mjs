import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  // `.claude/`（含各工作树及其 .next 产物）与 `.local/` 是本机未跟踪目录，不属于本仓库源码。
  globalIgnores([".next/**", "coverage/**", "playwright-report/**", "test-results/**", "src/generated/**", ".claude/**", ".local/**"]),
]);

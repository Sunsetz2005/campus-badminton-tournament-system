// 复判探针配置（非产品测试）：在原配置上加时钟平移 setup。
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config";

export default mergeConfig(base, defineConfig({ test: { setupFiles: ["tests/review/fake-clock-2026-10-30.setup.ts"] } }));

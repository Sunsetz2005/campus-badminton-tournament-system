import { afterEach, describe, expect, it } from "vitest";

import { assertRuntimeSecurity, developmentAuthSecret } from "@/server/config/runtime";

const original = {
  nodeEnv: process.env.NODE_ENV,
  secret: process.env.BETTER_AUTH_SECRET,
  allowDemo: process.env.ALLOW_DEMO_ACCOUNTS,
  adminPassword: process.env.DEMO_ADMIN_PASSWORD,
  refereePassword: process.env.DEMO_REFEREE_PASSWORD,
  participantPassword: process.env.DEMO_PARTICIPANT_PASSWORD,
};
const mutableEnvironment = process.env as Record<string, string | undefined>;

afterEach(() => {
  mutableEnvironment.NODE_ENV = original.nodeEnv;
  process.env.BETTER_AUTH_SECRET = original.secret;
  process.env.ALLOW_DEMO_ACCOUNTS = original.allowDemo;
  process.env.DEMO_ADMIN_PASSWORD = original.adminPassword;
  process.env.DEMO_REFEREE_PASSWORD = original.refereePassword;
  process.env.DEMO_PARTICIPANT_PASSWORD = original.participantPassword;
});

describe("生产运行安全门禁", () => {
  it("拒绝生产环境中的示例账号配置", () => {
    mutableEnvironment.NODE_ENV = "production";
    process.env.BETTER_AUTH_SECRET = "production-secret-with-more-than-32-characters";
    process.env.ALLOW_DEMO_ACCOUNTS = "true";
    expect(() => assertRuntimeSecurity()).toThrow("示例账号配置");
  });

  it("拒绝生产环境残留参赛选手模拟密码", () => {
    mutableEnvironment.NODE_ENV = "production";
    process.env.BETTER_AUTH_SECRET = "production-secret-with-more-than-32-characters";
    process.env.ALLOW_DEMO_ACCOUNTS = "false";
    delete process.env.DEMO_ADMIN_PASSWORD;
    delete process.env.DEMO_REFEREE_PASSWORD;
    process.env.DEMO_PARTICIPANT_PASSWORD = "demo-participant-password";
    expect(() => assertRuntimeSecurity()).toThrow("示例账号配置");
  });

  it("拒绝生产环境继续使用已知开发密钥", () => {
    mutableEnvironment.NODE_ENV = "production";
    process.env.ALLOW_DEMO_ACCOUNTS = "false";
    delete process.env.DEMO_ADMIN_PASSWORD;
    delete process.env.DEMO_REFEREE_PASSWORD;
    delete process.env.DEMO_PARTICIPANT_PASSWORD;
    process.env.BETTER_AUTH_SECRET = developmentAuthSecret;
    expect(() => assertRuntimeSecurity()).toThrow("示例认证密钥");
  });
});

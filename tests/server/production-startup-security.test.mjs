import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

const READY_PATTERN = /Ready in|Local:\s+http/i;

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配生产启动测试端口。");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function productionEnvironment(port, overrides = {}) {
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_SECRET: "production-startup-test-secret-with-more-than-32-characters",
    ...overrides,
  };
  delete environment.DEMO_ADMIN_PASSWORD;
  delete environment.DEMO_REFEREE_PASSWORD;
  if (!("ALLOW_DEMO_ACCOUNTS" in overrides)) delete environment.ALLOW_DEMO_ACCOUNTS;
  return environment;
}

async function startProductionServer(environment, port) {
  const child = spawn("pnpm", ["start", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let ready = false;
  let exited = false;
  let exitCode = null;
  const append = (chunk) => {
    output += chunk.toString();
    ready ||= READY_PATTERN.test(output);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`等待生产服务状态超时。\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const stop = async () => {
    if (exited) return;
    child.kill("SIGTERM");
    await waitFor(() => exited, 5_000).catch(() => child.kill("SIGKILL"));
  };

  return {
    child,
    get output() {
      return output;
    },
    get ready() {
      return ready;
    },
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    waitFor,
    stop,
  };
}

test("非法生产配置在服务 Ready 前终止进程", { timeout: 20_000 }, async () => {
  const port = await getFreePort();
  const server = await startProductionServer(
    productionEnvironment(port, { ALLOW_DEMO_ACCOUNTS: "true" }),
    port,
  );
  try {
    await server.waitFor(() => server.exited || server.ready, 10_000);
    assert.equal(server.ready, false, server.output);
    assert.equal(server.exited, true, server.output);
    assert.notEqual(server.exitCode, 0, server.output);
    assert.match(server.output, /生产环境检测到示例账号配置/);
  } finally {
    await server.stop();
  }
});

test("合规生产配置可启动且健康检查成功", { timeout: 20_000 }, async () => {
  const port = await getFreePort();
  const server = await startProductionServer(productionEnvironment(port), port);
  try {
    await server.waitFor(() => server.exited || server.ready, 10_000);
    assert.equal(server.exited, false, server.output);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  } finally {
    await server.stop();
  }
});

test("生产环境拒绝测试故障注入开关", { timeout: 20_000 }, async () => {
  const port = await getFreePort();
  const server = await startProductionServer(
    productionEnvironment(port, { ENABLE_TEST_FAULT_INJECTION: "true" }),
    port,
  );
  try {
    await server.waitFor(() => server.exited || server.ready, 10_000);
    assert.equal(server.ready, false, server.output);
    assert.equal(server.exited, true, server.output);
    assert.notEqual(server.exitCode, 0, server.output);
    assert.match(server.output, /生产环境禁止启用测试故障注入/);
  } finally {
    await server.stop();
  }
});

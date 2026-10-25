/**
 * 被测服务：与阶段 8 演练相同，用生产构建（`pnpm run stress:build`）以 `next start` 起在 BETTER_AUTH_URL 的端口。
 * 起服务时去掉示例账号变量（生产门禁会拒绝），故障注入在生产模式下被 `assertRuntimeSecurity` 禁止，因此这里固定关闭。
 * stdout/stderr 全部写入运行目录的 server.log，结束时扫描未处理异常。
 *
 * `--external` 模式不起进程，只连接已在运行的实例（服务器 L3、经 nginx 的路径）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";

import { sleep } from "./clock";

export interface ServerOptions {
  origin: string;
  logFile: string;
  publicRateLimitPerMinute?: string;
  external?: boolean;
}

export class Server {
  private child: ChildProcess | null = null;
  private log: WriteStream;
  readonly url: URL;
  starts: { readyMs: number; at: string }[] = [];

  constructor(readonly options: ServerOptions) {
    this.url = new URL(options.origin);
    this.log = createWriteStream(options.logFile, { flags: "a" });
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  private env() {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("DEMO_")) delete env[key];
    return {
      ...env,
      // 仿真进程自己把 DATABASE_URL 改成了只读会话；服务用原始连接串。
      DATABASE_URL: process.env.STRESS_SERVER_DATABASE_URL ?? process.env.DATABASE_URL,
      NODE_ENV: "production",
      ALLOW_DEMO_ACCOUNTS: "false",
      ENABLE_TEST_FAULT_INJECTION: "false",
      ENABLE_PUBLIC_UI_PREVIEW: "false",
      BETTER_AUTH_SECRET: "production-startup-test-secret-with-more-than-32-characters",
      ...(this.options.publicRateLimitPerMinute ? { PUBLIC_RATE_LIMIT_PER_MINUTE: this.options.publicRateLimitPerMinute } : {}),
    };
  }

  async start() {
    const started = Date.now();
    let exited = false;
    if (!this.options.external) {
      // 端口上已有服务（例如上一轮崩溃遗留、连着另一个库）就拒绝启动：否则就绪检查会打到那个服务上，数据写进别的库。
      const stale = await fetch(`${this.url.origin}/api/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
      if (stale) throw new Error(`${this.url.origin} 已有服务在监听（上一轮遗留？），先停掉再运行。`);
      const child = spawn(
        "pnpm",
        ["exec", "tsx", "scripts/start-production-server.ts", "--", "--hostname", this.url.hostname, "--port", this.url.port || "3200"],
        { env: this.env() as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: false },
      );
      this.child = child;
      child.stdout?.pipe(this.log, { end: false });
      child.stderr?.pipe(this.log, { end: false });
      child.once("exit", (code, signal) => {
        exited = true;
        this.log.write(`\n[stress] server exited code=${code} signal=${signal}\n`);
      });
      // 仿真进程意外退出时不留下被测服务。
      process.once("exit", () => {
        if (!exited) child.kill("SIGKILL");
      });
      // 被信号终止时 Node 不触发 exit 事件：先关掉被测服务再退出。
      for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
        process.once(signal, () => {
          if (!exited) child.kill("SIGKILL");
          process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15));
        });
      }
    }
    for (;;) {
      try {
        const response = await fetch(`${this.url.origin}/api/health`);
        if (response.ok) break;
      } catch {
        // 尚未监听
      }
      if (exited) throw new Error("被测服务进程启动后退出，见运行目录 server.log。");
      if (Date.now() - started > 90_000) throw new Error("被测服务 90 秒内未就绪，见运行目录 server.log。");
      await sleep(250);
    }
    const readyMs = Date.now() - started;
    this.starts.push({ readyMs, at: new Date().toISOString() });
    return readyMs;
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(15_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    this.child = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await fetch(`${this.url.origin}/api/health`);
        await sleep(250);
      } catch {
        return;
      }
    }
  }

  async close() {
    await this.stop();
    await new Promise<void>((resolve) => this.log.end(resolve));
  }

  /** 服务端日志里的未处理异常（errorResponse 对非 AppError 打印的内容、进程级错误）。 */
  static scanLog(file: string) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { unexpected: 0, samples: [] as string[] };
    }
    const lines = text.split("\n");
    const hits = lines.filter((line) => /unexpected|Unhandled|TypeError|ReferenceError|PrismaClient|DriverAdapterError|FATAL|ECONN/i.test(line));
    return { unexpected: hits.length, samples: hits.slice(0, 20).map((line) => line.slice(0, 300)) };
  }
}

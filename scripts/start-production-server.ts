import { spawn } from "node:child_process";

import { assertRuntimeSecurity } from "../src/server/config/runtime";

(process.env as Record<string, string | undefined>).NODE_ENV = "production";
assertRuntimeSecurity();

const nextArguments = process.argv.slice(2);
if (nextArguments[0] === "--") nextArguments.shift();
if (!nextArguments.includes("--hostname") && !nextArguments.includes("-H")) {
  nextArguments.unshift("--hostname", "0.0.0.0");
}
const child = spawn("pnpm", ["exec", "next", "start", ...nextArguments], {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

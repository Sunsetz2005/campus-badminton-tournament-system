import { spawn } from "node:child_process";
import { Client } from "pg";

import { assertTestDatabaseUrl, databaseNameFromUrl } from "../src/db/database-safety";

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} 退出码为 ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  assertTestDatabaseUrl(databaseUrl);
  const databaseName = databaseNameFromUrl(databaseUrl);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";

  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  const existing = await client.query<{ exists: boolean }>(
    "select exists(select 1 from pg_database where datname = $1) as exists",
    [databaseName],
  );
  if (!existing.rows[0]?.exists) {
    if (!/^[a-z0-9_]+$/.test(databaseName)) throw new Error("测试数据库名包含不安全字符。");
    await client.query(`create database "${databaseName}"`);
  }
  await client.end();

  await run("pnpm", ["exec", "prisma", "migrate", "deploy"]);
  await run("pnpm", ["exec", "tsx", "prisma/seed.ts"]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "测试数据库准备失败。");
  process.exitCode = 1;
});

export function databaseNameFromUrl(value: string | undefined) {
  if (!value) throw new Error("缺少 DATABASE_URL。");
  const parsed = new URL(value);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!name) throw new Error("DATABASE_URL 未指定数据库名。");
  return name;
}

export function assertTestDatabaseUrl(value: string | undefined): asserts value is string {
  if (!value) {
    throw new Error("缺少 DATABASE_URL。请先按 .env.test.example 创建 .env.test。");
  }
  const name = databaseNameFromUrl(value);
  if (!name.endsWith("_test")) {
    throw new Error(`自动化测试只能使用以 _test 结尾的数据库，当前为 ${name}。`);
  }
}

export function assertDemoSeedDatabase(value: string | undefined): asserts value is string {
  const name = databaseNameFromUrl(value);
  if (!name.endsWith("_test") && name !== "badminton_tournament_dev") {
    throw new Error(`模拟种子只允许写入 badminton_tournament_dev 或 *_test，当前为 ${name}。`);
  }
}

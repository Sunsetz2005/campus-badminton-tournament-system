/**
 * 必须是仿真入口的第一个 import：在 `src/db/client` 创建连接池之前，把本进程的 DATABASE_URL 改成
 * 「默认只读事务」的会话（`default_transaction_read_only=on`）。仿真进程里任何经 Prisma 的写入都会被数据库拒绝，
 * 从机制上保证「写入只经 HTTP 接口」。被测服务用原始连接串（见 server.ts 的 STRESS_SERVER_DATABASE_URL）。
 */
import { assertTestDatabaseUrl, databaseNameFromUrl } from "../../../src/db/database-safety";

const original = process.env.DATABASE_URL;
assertTestDatabaseUrl(original);
if (!/stress/.test(databaseNameFromUrl(original!))) {
  throw new Error("仿真只连接库名含 stress 的 _test 库（例如 badminton_tournament_stress_test），请检查 .env.stress。");
}
process.env.STRESS_SERVER_DATABASE_URL = original;
const url = new URL(original!);
url.searchParams.set("options", "-c default_transaction_read_only=on");
process.env.DATABASE_URL = url.toString();

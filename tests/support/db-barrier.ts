import { prisma } from "@/db/client";

/**
 * 确定性并发测试的数据库屏障（CON-001）。
 * 不靠随机 Promise.all 碰运气：第三个连接占住某一行的行锁，让被测事务停在指定位置，
 * 再用 pg_blocking_pids 确认它确实已被这把锁挡住，之后才放行。
 */

/** 屏障：在独立连接上持有某一行的行锁，直到 release() 才回滚释放。 */
export async function holdRowLock(table: "fixtures", id: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const done = prisma
    .$transaction(
      async (transaction) => {
        const [row] = await transaction.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await transaction.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1::uuid FOR UPDATE`, id);
        ready(row.pid);
        await released;
        // 屏障只是占锁，不写任何东西；抛错让事务回滚。
        throw new Error("barrier released");
      },
      { timeout: 60_000, maxWait: 10_000 },
    )
    .catch((error: Error) => {
      if (error.message !== "barrier released") throw error;
    });
  return { pid: await pid, release, done };
}

/** 等到有后端正被指定连接阻塞在锁上（确定性地确认对方已经走到屏障处）。 */
export async function waitUntilBlockedBy(blockerPid: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))`;
    if (Number(row.count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待事务到达屏障超时");
}

/** 一个 promise 在给定时间内是否已经结束（用于判断它是否也被锁住）。 */
export async function settledWithin<T>(promise: Promise<T>, ms: number) {
  const marker = Symbol("pending");
  const result = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), ms)),
  ]);
  return result !== marker;
}

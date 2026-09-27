import { Prisma } from "@/generated/prisma/client";

/**
 * 可串行化事务的有界重试。
 *
 * PostgreSQL 在 Serializable 隔离级别下遇到读写依赖冲突或死锁时会中止事务并要求客户端重试
 * （SQLSTATE 40001 / 40P01）。同一类冲突会以三种形状出现：
 * - 查询中途被中止：Prisma 报 `P2034`；
 * - 冲突发生在 `$queryRaw` 里：`P2010`，`meta.code` 带原始 SQLSTATE；
 * - 提交时才被中止：`@prisma/adapter-pg` 直接抛出 `DriverAdapterError`，`cause.kind` 为 `TransactionWriteConflict`
 *   （它把 40001 与 40P01 都映射成这一类）。
 * 事务整体回滚，重跑整段工作不会重复写入。
 * 其他错误（包括业务 AppError、唯一约束冲突）一律原样抛出，不重试。
 */
export const DEFAULT_TRANSACTION_ATTEMPTS = 8;

const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

export function isRetryableTransactionError(error: unknown) {
  if (error instanceof Error && error.name === "DriverAdapterError") {
    return (error.cause as { kind?: unknown } | undefined)?.kind === "TransactionWriteConflict";
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code === "P2010") {
    const code = (error.meta as { code?: unknown } | undefined)?.code;
    return typeof code === "string" && RETRYABLE_SQLSTATES.has(code);
  }
  return false;
}

function pause(attempt: number) {
  // 指数退避加抖动（10、20、40…ms，封顶 400ms），避免多个冲突方同时重试再次撞在一起。
  const base = Math.min(10 * 2 ** (attempt - 1), 400);
  return new Promise((resolve) => setTimeout(resolve, base + Math.floor(Math.random() * base)));
}

export async function transactWithRetry<T>(work: () => Promise<T>, maxAttempts = DEFAULT_TRANSACTION_ATTEMPTS): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await work();
    } catch (error) {
      attempt += 1;
      if (!isRetryableTransactionError(error) || attempt >= maxAttempts) throw error;
      await pause(attempt);
    }
  }
}

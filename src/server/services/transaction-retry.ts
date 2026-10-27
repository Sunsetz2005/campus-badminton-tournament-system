import { Prisma } from "@/generated/prisma/client";

/**
 * 可串行化事务的有界重试。
 *
 * PostgreSQL 在 Serializable 隔离级别下遇到读写依赖冲突或死锁时会中止事务并要求客户端重试
 * （SQLSTATE 40001 / 40P01）。同一类冲突会以三种形状出现：
 * - 查询中途被中止：Prisma 报 `P2034`；
 * - 冲突发生在 `$queryRaw` 里：`P2010`，原始 SQLSTATE 在 `meta.code`，或（经 `@prisma/adapter-pg` 时）在
 *   `meta.driverAdapterError.cause` 的 `originalCode` / `kind`——CON-001 的小组行锁在可串行化事务里就以后者出现；
 * - 提交时才被中止：`@prisma/adapter-pg` 直接抛出 `DriverAdapterError`，`cause.kind` 为 `TransactionWriteConflict`
 *   （它把 40001 与 40P01 都映射成这一类）。
 * 事务整体回滚，重跑整段工作不会重复写入。
 * 其他错误（包括业务 AppError、唯一约束冲突）一律原样抛出，不重试。
 *
 * 阶段 8 基准：6 场比赛同时无间隔记分时，不同比赛之间也会因共享索引页上的谓词锁互相中止；
 * 原先 8 次（总退避约 1 秒）每轮约有 3/258 条命令重试耗尽成 500，改为 12 次（最坏总退避约 3—5 秒）。
 */
export const DEFAULT_TRANSACTION_ATTEMPTS = 12;

const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

export function isRetryableTransactionError(error: unknown) {
  if (error instanceof Error && error.name === "DriverAdapterError") {
    return (error.cause as { kind?: unknown } | undefined)?.kind === "TransactionWriteConflict";
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code === "P2010") {
    const meta = error.meta as
      | { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } }
      | undefined;
    const cause = meta?.driverAdapterError?.cause;
    const code = meta?.code ?? cause?.originalCode;
    return (typeof code === "string" && RETRYABLE_SQLSTATES.has(code)) || cause?.kind === "TransactionWriteConflict";
  }
  return false;
}

/**
 * SF-03 / SF-04：可以原样重发的数据库失败。数据层由事务回滚与 commandId 幂等保证不重不丢，
 * 这些失败交给 `errorResponse` 返回 503，客户端据此提示「暂时中断、正在重试」，而不是当成程序错误。
 * - `conflict`：重试耗尽仍冲突（见 `isRetryableTransactionError`）；
 * - `busy`：`P2028` 等连接超过 maxWait 或事务超时被回滚；
 * - `unavailable`：库不可达、连接被终止或实例拒绝新连接（M4 停库、`pg_terminate_backend` 实测形状）。
 */
export type TransientDatabaseFailure = "conflict" | "busy" | "unavailable";

const UNAVAILABLE_PRISMA_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);
const UNAVAILABLE_SQLSTATES = new Set(["57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08004", "08006"]);
const UNAVAILABLE_DRIVER_KINDS = new Set(["DatabaseNotReachable", "ConnectionClosed", "SocketTimeout", "TooManyConnections"]);
const UNAVAILABLE_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);
const UNAVAILABLE_MESSAGES = [/connection terminated/i, /can't reach database server/i, /terminating connection/i];

export function classifyTransientDatabaseError(error: unknown): TransientDatabaseFailure | null {
  if (isRetryableTransactionError(error)) return "conflict";
  if (!(error instanceof Error)) return null;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2028") return "busy";
    if (UNAVAILABLE_PRISMA_CODES.has(error.code)) return "unavailable";
    const meta = error.meta as { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } } | undefined;
    const sqlState = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
    if (typeof sqlState === "string" && UNAVAILABLE_SQLSTATES.has(sqlState)) return "unavailable";
    if (UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(error.message))) return "unavailable";
    return null;
  }
  if (error instanceof Prisma.PrismaClientInitializationError) return "unavailable";
  if (error.name === "DriverAdapterError") {
    const cause = error.cause as { kind?: unknown; originalCode?: unknown } | undefined;
    if (typeof cause?.kind === "string" && UNAVAILABLE_DRIVER_KINDS.has(cause.kind)) return "unavailable";
    if (typeof cause?.originalCode === "string" && UNAVAILABLE_SQLSTATES.has(cause.originalCode)) return "unavailable";
    return null;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (UNAVAILABLE_NODE_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code))) return "unavailable";
  if (UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(error.message))) return "unavailable";
  return null;
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

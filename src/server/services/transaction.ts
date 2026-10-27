import { prisma } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";
import { transactWithRetry } from "@/server/services/transaction-retry";

export interface InteractiveTransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * SF-01：所有交互式事务统一走有界重试。
 *
 * 默认隔离级别（Read Committed）不会序列化失败，但死锁（40P01）同样以 P2034 报出；
 * 并发仿真 M3 里团体出场名单提交与小场「取得控制」锁顺序相反成环，名单提交没有重试，直接 500。
 * 事务整体回滚后重跑整段工作不会重复写入；业务 AppError 与唯一约束冲突不重试（见 `transactWithRetry`）。
 * 调用方不得在事务回调里做不可回滚的外部副作用（写文件、发消息），现有回调都只读写数据库。
 */
export function runTransaction<T>(
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
  options?: InteractiveTransactionOptions,
): Promise<T> {
  return transactWithRetry(() => prisma.$transaction(work, options));
}

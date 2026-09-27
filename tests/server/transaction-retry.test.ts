import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/server/services/errors";
import { isRetryableTransactionError, transactWithRetry } from "@/server/services/transaction-retry";

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("模拟错误", { code, clientVersion: "test", meta });
}

describe("可串行化事务的有界重试", () => {
  it("只把可串行化冲突与死锁当作可重试", () => {
    expect(isRetryableTransactionError(prismaError("P2034"))).toBe(true);
    expect(isRetryableTransactionError(prismaError("P2010", { code: "40001" }))).toBe(true);
    expect(isRetryableTransactionError(prismaError("P2010", { code: "40P01" }))).toBe(true);
    expect(isRetryableTransactionError(prismaError("P2010", { code: "23505" }))).toBe(false);
    expect(isRetryableTransactionError(prismaError("P2002"))).toBe(false);
    expect(isRetryableTransactionError(new AppError(409, "controller_exists", "已有控制"))).toBe(false);
    expect(isRetryableTransactionError(new Error("网络错误"))).toBe(false);
    // @prisma/adapter-pg 在提交时被中止会直接抛出驱动适配器错误。
    const writeConflict = Object.assign(new Error("TransactionWriteConflict"), { name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict" } });
    const otherAdapterError = Object.assign(new Error("ConnectionClosed"), { name: "DriverAdapterError", cause: { kind: "ConnectionClosed" } });
    expect(isRetryableTransactionError(writeConflict)).toBe(true);
    expect(isRetryableTransactionError(otherAdapterError)).toBe(false);
  });

  it("冲突后重跑整段工作并返回成功结果", async () => {
    let calls = 0;
    const result = await transactWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw prismaError("P2034");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("业务错误与唯一约束冲突不重试，原样抛出", async () => {
    let calls = 0;
    const business = new AppError(409, "controller_exists", "已有控制");
    await expect(transactWithRetry(async () => {
      calls += 1;
      throw business;
    })).rejects.toBe(business);
    expect(calls).toBe(1);
    const unique = prismaError("P2002");
    await expect(transactWithRetry(async () => {
      calls += 1;
      throw unique;
    })).rejects.toBe(unique);
    expect(calls).toBe(2);
  });

  it("次数有上限：持续冲突时抛出最后一次错误，不无限重试", async () => {
    let calls = 0;
    await expect(transactWithRetry(async () => {
      calls += 1;
      throw prismaError("P2034");
    }, 3)).rejects.toMatchObject({ code: "P2034" });
    expect(calls).toBe(3);
  });
});

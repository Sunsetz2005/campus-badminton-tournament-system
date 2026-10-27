import { AppError } from "@/server/services/errors";

/**
 * SF-06：公开查询的进程内短时共享缓存。
 *
 * 观众每 10 秒轮询一次公开赛程、看板与比赛详情；几百名观众请求的是同一份数据，
 * L3 实测每条公开赛程查询都要占一条数据库连接，集中到来时把裁判记分挤到等连接超时。
 * 这里按键缓存几秒，并把同一时刻的并发请求合并成一次查询（single-flight）。
 * - 只缓存成功结果与业务 404 一类的 `AppError`；数据库故障等其他错误不缓存，下一次重新查。
 * - 只用于不依赖访问者身份的公开数据；不得放入任何会话或权限相关的结果。
 * - 生产默认 2 秒；开发与测试默认关闭，避免「刚写入就读」的用例读到旧值。`PUBLIC_CACHE_TTL_MS` 可覆盖，`0` 关闭。
 */
export class SharedReadCache {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const at = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > at) return cached.value as Promise<T>;
    if (this.entries.size >= this.maxKeys) this.sweep(at);
    const value = load();
    const entry = { expiresAt: at + this.ttlMs, value: value as Promise<unknown> };
    if (this.entries.size < this.maxKeys) this.entries.set(key, entry);
    value.catch((error: unknown) => {
      if (!(error instanceof AppError) && this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  private sweep(at: number) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) this.entries.delete(key);
    }
  }
}

export function publicCacheTtlFromEnv(raw: string | undefined, nodeEnv: string | undefined) {
  const fallback = nodeEnv === "production" ? 2_000 : 0;
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export const publicReadCache = new SharedReadCache(publicCacheTtlFromEnv(process.env.PUBLIC_CACHE_TTL_MS, process.env.NODE_ENV));

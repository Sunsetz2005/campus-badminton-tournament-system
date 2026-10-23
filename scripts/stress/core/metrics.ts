/**
 * 请求指标：按「接口类别」聚合成功率、错误码分布与延迟分位；同时保留脱敏的逐条请求日志供复现。
 * 日志里不记 Cookie、令牌、口令和请求体，只记方法、路径模板、状态、错误码、耗时与调用方标签。
 */
import { createWriteStream, type WriteStream } from "node:fs";

export interface RequestRecord {
  at: number;
  actor: string;
  method: string;
  route: string;
  status: number;
  code: string | null;
  ms: number;
  note?: string;
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]);
}

export function latencySummary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: percentile(sorted, 1),
  };
}

export class Metrics {
  private byRoute = new Map<string, { latencies: number[]; statuses: Map<string, number> }>();
  private log: WriteStream | null;
  readonly startedAt = Date.now();
  total = 0;
  serverErrors = 0;
  rateLimited = 0;

  constructor(logFile: string | null) {
    this.log = logFile ? createWriteStream(logFile) : null;
  }

  record(entry: RequestRecord) {
    this.total += 1;
    if (entry.status >= 500) this.serverErrors += 1;
    if (entry.status === 429) this.rateLimited += 1;
    const bucket = this.byRoute.get(`${entry.method} ${entry.route}`) ?? { latencies: [] as number[], statuses: new Map<string, number>() };
    bucket.latencies.push(entry.ms);
    const key = entry.code ? `${entry.status}:${entry.code}` : String(entry.status);
    bucket.statuses.set(key, (bucket.statuses.get(key) ?? 0) + 1);
    this.byRoute.set(`${entry.method} ${entry.route}`, bucket);
    this.log?.write(`${JSON.stringify(entry)}\n`);
  }

  summary() {
    const routes = [...this.byRoute.entries()]
      .map(([route, bucket]) => ({
        route,
        ...latencySummary(bucket.latencies),
        statuses: Object.fromEntries([...bucket.statuses.entries()].sort()),
      }))
      .sort((a, b) => b.count - a.count);
    return { total: this.total, serverErrors: this.serverErrors, rateLimited: this.rateLimited, durationMs: Date.now() - this.startedAt, routes };
  }

  close() {
    return new Promise<void>((resolve) => (this.log ? this.log.end(resolve) : resolve()));
  }
}

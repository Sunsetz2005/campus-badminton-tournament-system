/**
 * 仿真 HTTP 客户端：每个「设备/人」一个实例，自带 Cookie、来源头与可选的模拟来源地址。
 *
 * - 写请求带 `Origin`，与浏览器一致，才能通过 `src/proxy.ts` 的来源校验；
 * - `clientIp` 非空时附带 `x-forwarded-for`：只在没有反向代理的本机实例上有效，用来把不同模拟客户端分成不同来源
 *   （登录限流、公开限流都按来源计数）。§13.2 的同出口场景让所有客户端共用一个地址或不设该头；
 * - 每次请求都记入 Metrics；业务错误码从 `{ error: { code } }` 里取。
 */
import type { Metrics } from "./metrics";

export interface CallResult<T = unknown> {
  status: number;
  ok: boolean;
  json: T | null;
  code: string | null;
  message: string | null;
  ms: number;
  headers: Headers;
  /** 原始响应正文；非 JSON（如公开页面 HTML）时用于检查是否泄露。 */
  text?: string;
}

export interface CallOptions {
  /** 指标里用的路径模板（不含具体编号），缺省用实际路径。 */
  route?: string;
  headers?: Record<string, string>;
  /** 超时即中断（客户端视角的「响应未知」）。 */
  timeoutMs?: number;
  note?: string;
  /** 服务重启注入期间照常发出（用于记录停机窗口内的错误码）；其他请求在停机期间等待恢复。 */
  duringOutage?: boolean;
}

/**
 * 服务重启注入（§7「中途重启服务进程」）：停机期间普通请求原地等待，像现场设备反复重试直到服务恢复；
 * 停机前已在途、因连接断开失败的请求，在恢复后原样重发一次（记分命令带原 commandId，服务端幂等）。
 */
class Outage {
  static current: { promise: Promise<void>; release: () => void; startedAt: number } | null = null;
  static lastEndedAt = 0;
}

export function beginOutage() {
  let release = () => undefined as void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  Outage.current = { promise, release, startedAt: Date.now() };
}

export function endOutage() {
  Outage.current?.release();
  Outage.current = null;
  Outage.lastEndedAt = Date.now();
}

/** 登录与改口令的记录（§13.2 / §13.9：集中登录的 429 次数与全部登入耗时）。 */
export interface AuthRecord {
  at: number;
  actor: string;
  kind: "sign-in" | "change-password";
  rateLimited: number;
  ms: number;
  ok: boolean;
}
export const authLog: AuthRecord[] = [];

async function retryAfter(result: CallResult) {
  const value = Number(result.headers.get("retry-after") ?? result.headers.get("x-retry-after") ?? "3");
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, Number.isFinite(value) ? value : 3) * 1000 + 50));
}

export class HttpError extends Error {
  constructor(readonly result: CallResult, readonly where: string) {
    super(`${where} → ${result.status}${result.code ? ` ${result.code}` : ""}${result.message ? `：${result.message}` : ""}`);
  }
}

export class Client {
  private cookies = new Map<string, string>();
  userId: string | null = null;

  constructor(
    readonly origin: string,
    readonly actor: string,
    readonly metrics: Metrics,
    readonly clientIp: string | null = null,
  ) {}

  get signedIn() {
    return this.cookies.size > 0;
  }

  /** 复制登录态：用于「同一台平板交给下一名裁判」或「复制标签页」这类共享 Cookie 的情形。 */
  cloneAs(actor: string, clientIp = this.clientIp) {
    const copy = new Client(this.origin, actor, this.metrics, clientIp);
    copy.cookies = new Map(this.cookies);
    copy.userId = this.userId;
    return copy;
  }

  clearCookies() {
    this.cookies.clear();
    this.userId = null;
  }

  private cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private storeCookies(headers: Headers) {
    for (const raw of headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";");
      const index = pair.indexOf("=");
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((item) => /max-age=0\b/i.test(item.trim())) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call<T = unknown>(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<CallResult<T>> {
    if (Outage.current && !options.duringOutage) await Outage.current.promise;
    const issuedAt = Date.now();
    const result = await this.callOnce<T>(method, path, body, options);
    if (result.code === "network_error" && !options.duringOutage && (Outage.current || Outage.lastEndedAt >= issuedAt)) {
      if (Outage.current) await Outage.current.promise;
      return this.callOnce<T>(method, path, body, options);
    }
    return result;
  }

  private async callOnce<T = unknown>(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<CallResult<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (this.clientIp) headers["x-forwarded-for"] = this.clientIp;
    if (method !== "GET" && method !== "HEAD") headers.Origin = this.origin;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const controller = options.timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller?.signal,
        redirect: "manual",
      });
    } catch (error) {
      const ms = performance.now() - started;
      const aborted = controller?.signal.aborted ?? false;
      const code = aborted ? "client_timeout" : "network_error";
      this.metrics.record({ at: Date.now(), actor: this.actor, method, route: options.route ?? path, status: 0, code, ms, note: options.note });
      return { status: 0, ok: false, json: null, code, message: error instanceof Error ? error.message : String(error), ms, headers: new Headers() };
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.storeCookies(response.headers);
    const text = await response.text();
    const ms = performance.now() - started;
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
    const code = response.ok ? null : (error?.code ?? (json as { code?: string } | null)?.code ?? null);
    const message = response.ok ? null : (error?.message ?? (json as { message?: string } | null)?.message ?? (text.slice(0, 200) || null));
    this.metrics.record({ at: Date.now(), actor: this.actor, method, route: options.route ?? path, status: response.status, code, ms, note: options.note });
    return { status: response.status, ok: response.ok, json: json as T, code, message, ms, headers: response.headers, text };
  }

  /** 失败即抛 HttpError：用于「这一步不该失败」的流程调用。 */
  async must<T = unknown>(method: string, path: string, body?: unknown, options: CallOptions = {}): Promise<T> {
    const result = await this.call<T>(method, path, body, options);
    if (!result.ok) throw new HttpError(result, `${this.actor} ${method} ${options.route ?? path}`);
    return result.json as T;
  }

  /**
   * 用户名或邮箱登录。遇到 429（Better Auth 登录限流：每来源 10 秒 3 次）时按 Retry-After 退避重试，
   * 并把每次 429 记进指标——这是 §13.2 要观察的现象，不是脚本错误。
   */
  async signIn(login: string, password: string, options: { maxWaitMs?: number } = {}) {
    const byEmail = login.includes("@");
    const path = byEmail ? "/api/auth/sign-in/email" : "/api/auth/sign-in/username";
    const body = byEmail ? { email: login, password } : { username: login, password };
    const started = Date.now();
    const deadline = started + (options.maxWaitMs ?? 120_000);
    let rateLimited = 0;
    for (;;) {
      const result = await this.call<{ user?: { id: string } }>("POST", path, body, { route: "/api/auth/sign-in" });
      if (result.ok) {
        this.userId = result.json?.user?.id ?? null;
        authLog.push({ at: started, actor: this.actor, kind: "sign-in", rateLimited, ms: Date.now() - started, ok: true });
        return { rateLimited, ms: Date.now() - started };
      }
      if (result.status === 429 && Date.now() < deadline) {
        rateLimited += 1;
        await retryAfter(result);
        continue;
      }
      authLog.push({ at: started, actor: this.actor, kind: "sign-in", rateLimited, ms: Date.now() - started, ok: false });
      throw new HttpError(result, `${this.actor} 登录`);
    }
  }

  /** 修改口令：与登录同一条限流规则（每来源 10 秒 3 次），遇 429 同样退避重试并记录。 */
  async changePassword(currentPassword: string, newPassword: string, options: { maxWaitMs?: number } = {}) {
    const started = Date.now();
    const deadline = started + (options.maxWaitMs ?? 120_000);
    let rateLimited = 0;
    for (;;) {
      const result = await this.call("POST", "/api/account/password", { currentPassword, newPassword }, { route: "/api/account/password" });
      if (result.ok) {
        authLog.push({ at: started, actor: this.actor, kind: "change-password", rateLimited, ms: Date.now() - started, ok: true });
        return { rateLimited };
      }
      if (result.status === 429 && Date.now() < deadline) {
        rateLimited += 1;
        await retryAfter(result);
        continue;
      }
      authLog.push({ at: started, actor: this.actor, kind: "change-password", rateLimited, ms: Date.now() - started, ok: false });
      throw new HttpError(result, `${this.actor} 修改口令`);
    }
  }

  async signOut() {
    await this.call("POST", "/api/auth/sign-out", {}, { route: "/api/auth/sign-out" });
    this.clearCookies();
  }
}

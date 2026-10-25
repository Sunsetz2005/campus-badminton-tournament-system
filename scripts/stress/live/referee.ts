/**
 * 一场比赛的执裁（§4 第 7 步）：取得控制 → 系统抛币 → 开局设置 → 逐分 → 间歇/换边 → 局间设置 → 结束 → 提交 → 释放。
 * 与浏览器工作台一致：一次只在途一条命令；每 30 秒（真实时间）心跳；命令失败按错误类型处理——
 * `409 conflict` 先取权威状态再继续，网络错误/5xx 先按原 commandId 对账再决定是否重发（不换 ID，避免重复记分）。
 */
import { randomUUID } from "node:crypto";

import type { Clock } from "../core/clock";
import { sleep } from "../core/clock";
import type { Client, CallResult } from "../core/http";
import type { Rng } from "../core/rng";
import { Narrative, type RuleShape } from "./narrative";

type Side = "A" | "B";

export interface MatchStateView {
  version: number;
  phase: string;
  format: "SINGLES" | "DOUBLES";
  players: { A: string[]; B: string[] };
  ruleConfig: RuleShape & { intervalSeconds: number; betweenGamesSeconds: number };
  currentGame: number;
  score: { A: number; B: number };
  gamesWon: { A: number; B: number };
  servingSide: Side | null;
  nextGameServingSide: Side | null;
  pendingObligations: { id: string; type: string }[];
  specialOutcome: { type: string } | null;
}

export interface Control {
  sessionId: string;
  controlToken: string;
  takeoverGeneration: number;
}

export interface CommandLog {
  commandId: string;
  type: string;
  status: number;
  code: string | null;
  version: number | null;
  ms: number;
}

export interface MatchRunResult {
  matchCode: string;
  outcome: "submitted" | "stopped" | "failed";
  reason?: string;
  finalPhase: string | null;
  finalVersion: number | null;
  gamesWon: { A: number; B: number } | null;
  commands: number;
  /** 服务端受理（201 accepted 或对账/重发得到 duplicate）的 commandId，判定「请求↔事件一一对应」用。 */
  acceptedCommandIds: string[];
  rejected: Record<string, number>;
  narrative: ReturnType<Narrative["describe"]>;
  startedAt: number;
  endedAt: number;
  /** 执裁的仿真裁判（人）与其账号；共用账号模式下账号都是同一个。 */
  official?: string;
  officialUserId?: string;
  /** 中途换人时每段的执裁人（逐场指派模式下判定按时间切分核对）。 */
  officialSegments?: { key: string; userId: string; from: number }[];
}

const HEARTBEAT_MS = 30_000;

export class MatchDriver {
  control: Control | null = null;
  state: MatchStateView | null = null;
  commands: CommandLog[] = [];
  private rejected: Record<string, number> = {};
  private accepted = new Set<string>();
  private lastHeartbeat = 0;

  constructor(
    readonly client: Client,
    readonly matchCode: string,
    readonly deviceSessionId: string,
    readonly narrative: Narrative,
    readonly clock: Clock,
    readonly rng: Rng,
  ) {}

  private bump(result: CallResult) {
    if (!result.ok) {
      const key = `${result.status}:${result.code ?? "?"}`;
      this.rejected[key] = (this.rejected[key] ?? 0) + 1;
    }
  }

  async acquire() {
    const result = await this.client.call<Control & { status: string }>("POST", `/api/matches/${this.matchCode}/control`, { deviceSessionId: this.deviceSessionId }, {
      route: "/api/matches/[code]/control",
    });
    this.bump(result);
    if (!result.ok) return result;
    this.control = result.json!;
    this.lastHeartbeat = Date.now();
    return result;
  }

  async refresh() {
    const result = await this.client.call<{ state?: MatchStateView }>("GET", `/api/matches/${this.matchCode}/state`, undefined, { route: "/api/matches/[code]/state" });
    if (result.ok && result.json?.state) this.state = result.json.state;
    return result;
  }

  private auth() {
    return { Authorization: `Bearer ${this.control!.controlToken}` };
  }

  async heartbeatIfDue(force = false) {
    if (!this.control || (!force && Date.now() - this.lastHeartbeat < HEARTBEAT_MS)) return null;
    const result = await this.client.call("PUT", `/api/matches/${this.matchCode}/control/heartbeat`, {
      scoringSessionId: this.control.sessionId,
      takeoverGeneration: this.control.takeoverGeneration,
    }, { route: "/api/matches/[code]/control/heartbeat", headers: this.auth() });
    this.bump(result);
    if (result.ok) this.lastHeartbeat = Date.now();
    return result;
  }

  async release() {
    if (!this.control) return null;
    const result = await this.client.call("DELETE", `/api/matches/${this.matchCode}/control`, {
      scoringSessionId: this.control.sessionId,
      takeoverGeneration: this.control.takeoverGeneration,
    }, { route: "/api/matches/[code]/control", headers: this.auth() });
    this.bump(result);
    this.control = null;
    return result;
  }

  /** 已受理的 commandId（注入会把多个驱动的结果并成一条）。 */
  acceptedIds() {
    return [...this.accepted];
  }

  markAccepted(commandId: string) {
    this.accepted.add(commandId);
  }

  /** 按当前状态拼一条命令信封；注入用它构造重复、过期版本、乱序等请求。 */
  envelope(type: string, payload: Record<string, unknown>, overrides: { commandId?: string; expectedVersion?: number } = {}) {
    return {
      commandId: overrides.commandId ?? randomUUID(),
      occurredAt: new Date().toISOString(),
      expectedVersion: overrides.expectedVersion ?? this.state!.version,
      scoringSessionId: this.control!.sessionId,
      takeoverGeneration: this.control!.takeoverGeneration,
      type,
      payload,
    };
  }

  /** 原样发一次命令信封（不重试、不对账）；受理则记入 accepted 并采用新状态。 */
  async post(envelope: ReturnType<MatchDriver["envelope"]>, options: { timeoutMs?: number; note?: string; control?: Control; duringOutage?: boolean } = {}) {
    const control = options.control ?? this.control!;
    const result = await this.client.call<{ state?: MatchStateView; status?: string }>("POST", `/api/matches/${this.matchCode}/commands`, envelope, {
      route: "/api/matches/[code]/commands",
      headers: { Authorization: `Bearer ${control.controlToken}` },
      note: options.note ?? envelope.type,
      timeoutMs: options.timeoutMs,
      duringOutage: options.duringOutage,
    });
    this.commands.push({ commandId: envelope.commandId, type: envelope.type, status: result.status, code: result.code, version: result.json?.state?.version ?? null, ms: result.ms });
    this.bump(result);
    if (result.ok) {
      this.accepted.add(envelope.commandId);
      if (result.json?.state && (!this.state || result.json.state.version >= this.state.version)) this.state = result.json.state;
    }
    return result;
  }

  /** 发一条命令；返回成功后的新状态，失败返回 null（并已按错误类型恢复本地状态）。 */
  async send(type: string, payload: Record<string, unknown>): Promise<CallResult<{ state?: MatchStateView; status?: string }>> {
    const envelope = {
      commandId: randomUUID(),
      occurredAt: new Date().toISOString(),
      expectedVersion: this.state!.version,
      scoringSessionId: this.control!.sessionId,
      takeoverGeneration: this.control!.takeoverGeneration,
      type,
      payload,
    };
    // 5xx / 网络错误按时间重试（与工作台一致：响应未知时一直按原 ID 对账），上限 90 秒，足以跨过数据库重启这类短停机。
    const giveUpAt = Date.now() + 90_000;
    for (let attempt = 0; attempt < 200 && Date.now() < giveUpAt; attempt += 1) {
      const result = await this.client.call<{ state?: MatchStateView; status?: string }>("POST", `/api/matches/${this.matchCode}/commands`, envelope, {
        route: "/api/matches/[code]/commands",
        headers: this.auth(),
        note: type,
      });
      this.commands.push({ commandId: envelope.commandId, type, status: result.status, code: result.code, version: result.json?.state?.version ?? null, ms: result.ms });
      this.bump(result);
      if (result.ok) {
        this.accepted.add(envelope.commandId);
        if (result.json?.state) this.state = result.json.state;
        return result;
      }
      if (result.status === 0 || result.status >= 500) {
        // 响应未知：先按原 ID 对账，已受理就采用其结果，否则原样重发（服务端按 commandId 幂等）。
        await sleep(Math.min(2000, 200 * (attempt + 1)));
        const lookup = await this.client.call<{ state?: MatchStateView; status?: string }>("GET", `/api/matches/${this.matchCode}/commands/${envelope.commandId}`, undefined, {
          route: "/api/matches/[code]/commands/[id]",
        });
        if (lookup.ok && lookup.json?.state) {
          this.accepted.add(envelope.commandId);
          this.state = lookup.json.state;
          return lookup;
        }
        continue;
      }
      if (result.status === 409 && result.code === "conflict") await this.refresh();
      return result;
    }
    return { status: 0, ok: false, json: null, code: "retry_exhausted", message: "多次重发仍失败", ms: 0, headers: new Headers() };
  }

  private setupPayload(servingSide: Side) {
    const state = this.state!;
    const receivingSide: Side = servingSide === "A" ? "B" : "A";
    const server = this.rng.pick(state.players[servingSide]);
    const receiver = this.rng.pick(state.players[receivingSide]);
    if (state.format === "SINGLES") return { serverPlayerId: server, receiverPlayerId: receiver, logicalCourts: null };
    const partner = (side: Side, player: string) => state.players[side].find((id) => id !== player)!;
    // 0:0 时发球员在右区，接发球员在其对角（右区）。
    return {
      serverPlayerId: server,
      receiverPlayerId: receiver,
      logicalCourts: {
        [servingSide]: { R: server, L: partner(servingSide, server) },
        [receivingSide]: { R: receiver, L: partner(receivingSide, receiver) },
      },
    };
  }

  /** 从当前状态一直打到提交（或遇到无法继续的拒绝）。 */
  /**
   * `onPhase` 在每一步之前调用；返回 "pause" 时本驱动停下（不释放控制），结局记为 stopped、reason 为 paused——
   * 注入在此做交接或并发请求，之后可由同一个或另一个驱动接着 play()。
   */
  async play(options: { onRally?: () => Promise<void>; onPhase?: (state: MatchStateView) => Promise<"continue" | "pause"> } = {}): Promise<MatchRunResult> {
    const startedAt = Date.now();
    const finish = (outcome: MatchRunResult["outcome"], reason?: string): MatchRunResult => ({
      matchCode: this.matchCode,
      outcome,
      reason,
      finalPhase: this.state?.phase ?? null,
      finalVersion: this.state?.version ?? null,
      gamesWon: this.state?.gamesWon ?? null,
      commands: this.commands.length,
      acceptedCommandIds: [...this.accepted],
      rejected: this.rejected,
      narrative: this.narrative.describe(),
      startedAt,
      endedAt: Date.now(),
    });
    if (!this.state) await this.refresh();
    let guard = 0;
    while (this.state && guard < 2000) {
      guard += 1;
      await this.heartbeatIfDue();
      if (options.onPhase && (await options.onPhase(this.state)) === "pause") return finish("stopped", "paused");
      const state = this.state;
      const rule = state.ruleConfig;
      let result: CallResult | null = null;
      switch (state.phase) {
        case "AWAITING_COIN_TOSS": {
          const toss = await this.client.call<{ winnerSide: Side }>("POST", `/api/matches/${this.matchCode}/coin-toss`, {
            scoringSessionId: this.control!.sessionId,
            takeoverGeneration: this.control!.takeoverGeneration,
          }, { route: "/api/matches/[code]/coin-toss", headers: this.auth() });
          this.bump(toss);
          if (!toss.ok) return finish("stopped", `coin-toss ${toss.status} ${toss.code}`);
          const winnerSide = toss.json!.winnerSide;
          const serve = this.rng.chance(0.7);
          result = await this.send("RECORD_COIN_TOSS", {
            valid: true,
            winnerSide,
            winnerChoice: serve ? { kind: "SERVICE", decision: this.rng.chance(0.85) ? "SERVE" : "RECEIVE" } : { kind: "END", end: this.rng.chance(0.5) ? "END_1" : "END_2" },
            loserChoice: serve ? { kind: "END", end: this.rng.chance(0.5) ? "END_1" : "END_2" } : { kind: "SERVICE", decision: this.rng.chance(0.85) ? "SERVE" : "RECEIVE" },
          });
          break;
        }
        case "AWAITING_OPENING_SETUP":
          result = await this.send("CONFIRM_OPENING_SETUP", this.setupPayload(state.servingSide!));
          break;
        case "AWAITING_NEXT_GAME_SETUP":
          await this.clock.wait(rule.betweenGamesSeconds);
          await this.heartbeatIfDue();
          result = await this.send("CONFIRM_NEXT_GAME_SETUP", this.setupPayload(state.nextGameServingSide ?? state.servingSide!));
          break;
        case "OBLIGATIONS_PENDING":
        case "GAME_COMPLETE": {
          const obligation = state.pendingObligations[0];
          if (!obligation) return finish("failed", `${state.phase} 没有待办`);
          if (obligation.type === "INTERVAL") {
            await this.clock.wait(rule.intervalSeconds);
            result = await this.send("ACKNOWLEDGE_INTERVAL", { obligationId: obligation.id });
          } else if (obligation.type === "CHANGE_ENDS") {
            await this.clock.wait(8);
            result = await this.send("CONFIRM_CHANGE_ENDS", { obligationId: obligation.id });
          } else {
            return finish("failed", `未处理的待办 ${obligation.type}`);
          }
          break;
        }
        case "IN_PROGRESS": {
          await this.clock.wait(this.rng.logNormal(this.clock.profile.rallyMedianSeconds, this.clock.profile.rallySigma));
          if (options.onRally) await options.onRally();
          result = await this.send("RALLY_WON", { side: this.narrative.next(state, rule) });
          break;
        }
        case "MATCH_COMPLETE_PENDING_SUBMISSION":
        case "SPECIAL_OUTCOME_PENDING_SUBMISSION":
          result = await this.send("SUBMIT_RESULT", { reason: "仿真：比赛结束提交" });
          break;
        case "SUBMITTED":
        case "CONFIRMED":
          await this.release();
          return finish("submitted");
        case "PAUSED":
          return finish("stopped", "比赛处于暂停");
        default:
          return finish("failed", `未知相位 ${state.phase}`);
      }
      if (result && !result.ok) {
        if (result.status === 409 && result.code === "conflict") continue;
        await this.refresh();
        return finish("stopped", `${result.status} ${result.code} ${result.message ?? ""}`.trim());
      }
    }
    return finish("failed", "循环保护触发");
  }
}

/**
 * 「我的执裁」视图缓存：调度器与裁判长都只依据这份系统给出的数据选择下一场（§12.5 取舍 2）。
 * 读取的是页面同源的 `loadOfficiatingTournament`（只读），与裁判在「我的执裁」页面上看到的一致；
 * 多个场地协程共用一份，每 `ttlMs` 刷新一次，避免每块场地各查一次。
 */
import { loadOfficiatingTournament } from "../../../src/server/services/officiating-service";
import { playersOfMatches } from "../core/db";

export type OfficiatingView = Awaited<ReturnType<typeof loadOfficiatingTournament>>;
export type OfficiatingMatch = OfficiatingView["matches"][number];

export class OfficiatingCache {
  private value: OfficiatingView | null = null;
  private loadedAt = 0;
  private pending: Promise<OfficiatingView> | null = null;
  private players = new Map<string, string[]>();

  constructor(readonly userId: string, readonly slug: string, readonly ttlMs = 1500) {}

  async get(force = false): Promise<OfficiatingView> {
    if (!force && this.value && Date.now() - this.loadedAt < this.ttlMs) return this.value;
    if (!this.pending) {
      this.pending = loadOfficiatingTournament(this.userId, this.slug).then((value) => {
        this.value = value;
        this.loadedAt = Date.now();
        this.pending = null;
        return value;
      }, (error) => {
        this.pending = null;
        throw error;
      });
    }
    return this.pending;
  }

  invalidate() {
    this.loadedAt = 0;
  }

  /** 上场人员（参赛者编号）。团体小场在出场名单公开前为空。缓存非空结果。 */
  async playersOf(codes: string[]) {
    const missing = codes.filter((code) => !this.players.get(code)?.length);
    if (missing.length) {
      for (const [code, list] of await playersOfMatches(missing)) this.players.set(code, list);
    }
    return new Map(codes.map((code) => [code, this.players.get(code) ?? []]));
  }
}

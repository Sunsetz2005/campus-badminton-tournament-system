/**
 * 「我的执裁」视图缓存：调度器与裁判长都只依据这份系统给出的数据选择下一场（§12.5 取舍 2）。
 * 读取的是页面同源的 `loadOfficiatingTournament`（只读），与裁判在「我的执裁」页面上看到的一致；
 * 多个场地协程共用一份，每 `ttlMs` 刷新一次，避免每块场地各查一次。
 */
import { loadOfficiatingTournament } from "../../../src/server/services/officiating-service";
import { matchStatusOf } from "../../../src/server/services/schedule-facts";
import { matchesOfTournament, playerListsOfMatches } from "../core/db";

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
    const missing = codes.filter((code) => !this.players.has(code));
    const fresh = new Map<string, string[]>();
    if (missing.length) {
      // 只缓存双方人员都已确定的场次；名单未交齐的团体小场每次重查。
      for (const [code, item] of await playerListsOfMatches(missing)) {
        fresh.set(code, item.ids);
        if (item.complete) this.players.set(code, item.ids);
      }
    }
    return new Map(codes.map((code) => [code, this.players.get(code) ?? fresh.get(code) ?? []]));
  }
}

/** 调度器需要的最小字段（「我的执裁」与赛程排班页都给得出）。 */
export interface VenueMatch {
  code: string;
  status: string;
  court: { id: string } | null;
  sideA: string;
  scheduledAt: Date | string | null;
  /** 逐场指派模式下本场的主裁判（赛程排班页显示的指派）。 */
  refereeUserId?: string | null;
}

export interface MatchSource {
  get(force?: boolean): Promise<{ matches: VenueMatch[] }>;
  invalidate(): void;
  playersOf(codes: string[]): Promise<Map<string, string[]>>;
}

/**
 * 逐场指派模式下的「现场看板」：每名裁判的「我的执裁」只列本人的比赛，场地调度要看整块场地的安排，
 * 相当于场地边的赛程排班页（管理员 / 编排员可见，含指派的主裁判）。只读。
 */
export class GlobalScheduleView implements MatchSource {
  private value: { matches: VenueMatch[] } | null = null;
  private loadedAt = 0;
  private pending: Promise<{ matches: VenueMatch[] }> | null = null;
  private players = new OfficiatingCache("", "");

  constructor(readonly tournamentId: string, readonly ttlMs = 1500) {}

  async get(force = false) {
    if (!force && this.value && Date.now() - this.loadedAt < this.ttlMs) return this.value;
    if (!this.pending) {
      this.pending = matchesOfTournament(this.tournamentId).then((rows) => {
        const matches: VenueMatch[] = rows.map((row) => ({
          code: row.code,
          status: matchStatusOf(row),
          court: row.courtId ? { id: row.courtId } : null,
          sideA: row.sideAEntryId && row.sideBEntryId ? "已确定" : "待定",
          scheduledAt: row.scheduledAt,
          refereeUserId: row.officialAssignments[0]?.userId ?? null,
        }));
        this.value = { matches };
        this.loadedAt = Date.now();
        this.pending = null;
        return this.value;
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

  playersOf(codes: string[]) {
    return this.players.playersOf(codes);
  }
}

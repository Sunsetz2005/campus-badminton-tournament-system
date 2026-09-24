import type { NamePublicationPolicy } from "@/generated/prisma/enums";
import type {
  CorrectionState,
  PublicEntry,
  PublicGameScore,
  PublicMatchPreview,
  PublicMatchTime,
  ScheduleDateOption,
  TournamentPhaseValue,
} from "@/features/public-results/model";
import { AppError } from "@/server/services/errors";

/**
 * Prisma 行 → 公开 DTO 的适配器。
 *
 * 这里是「公开投影」的唯一实现：页面和 API 都不得直接序列化 Prisma 对象。
 * 三条硬规则：
 *   1. 未进行的局不渲染成 0:0，只有真正已创建的当前局才允许显示真实 0:0。
 *   2. 总局分与权威胜方由服务端给出，界面不自行判胜。
 *   3. 姓名、成员和代表队由赛事的 `namePolicy` 决定，不能先下发真实值再靠 CSS 隐藏。
 */

/** 服务端把 `Tournament.timezone` 当作日程边界来源；无效时 fail closed，不猜设备时区或 UTC。 */
export function assertIanaTimeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  } catch {
    throw new AppError(500, "invalid_tournament_timezone", "赛事时区配置无效，无法生成公开赛程。");
  }
  return timezone;
}

const isoDayFormatters = new Map<string, Intl.DateTimeFormat>();
const dayLabelFormatters = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) {
  const existing = cache.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat(locale, { ...options, timeZone });
  cache.set(timeZone, created);
  return created;
}

/** 赛事时区下的自然日 `YYYY-MM-DD`；设备时区不能让比赛悄悄跨日。 */
export function scheduleDateIn(timeZone: string, value: Date): string {
  return formatter(isoDayFormatters, "en-CA", timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function scheduleDateOption(timeZone: string, isoDay: string): ScheduleDateOption {
  const at = new Date(`${isoDay}T12:00:00Z`);
  return {
    date: isoDay,
    dayLabel: formatter(dayLabelFormatters, "zh-CN", timeZone, { month: "long", day: "numeric" }).format(at),
    weekdayLabel: formatter(weekdayFormatters, "zh-CN", timeZone, { weekday: "short" }).format(at),
  };
}

/** `Match.publishedAt` 之外的另一道边界：`@db.Date` 序列化成不带时刻的自然日。 */
export function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

// --- 姓名与代表队的公开策略 -------------------------------------------------

type EntryRow = {
  code: string;
  displayName: string;
  members: readonly { slot: number; participant: { publicCode: string; displayName: string; teamName: string | null } }[];
};

/**
 * `CODES_ONLY` 时只公开编号；`DISPLAY_NAMES` 才公开姓名与代表队。
 * 未获批准的姓名根本不会离开服务端。
 */
export function projectEntry(entry: EntryRow | null, policy: NamePublicationPolicy): PublicEntry | null {
  if (!entry) return null;
  const namesPublic = policy === "DISPLAY_NAMES";
  const members = entry.members.map((member) => ({
    publicCode: member.participant.publicCode,
    displayName: namesPublic ? member.participant.displayName : member.participant.publicCode,
  }));
  const teamNames = namesPublic
    ? [...new Set(entry.members.map((member) => member.participant.teamName).filter((name): name is string => Boolean(name)))]
    : [];

  return {
    code: entry.code,
    displayName: namesPublic ? entry.displayName : entry.code,
    teamName: teamNames.length ? teamNames.join("／") : null,
    members,
  };
}

// --- 权威状态（只在服务端读取，不整体下发） ---------------------------------

interface AuthoritativeFacts {
  gamesWon: { A: number; B: number } | null;
  stoppedGame: number | null;
  winnerSide: "A" | "B" | null;
}

/**
 * 从 `MatchSnapshot.state` 中只取三件公开必需的事实：总局分、权威胜方和被特殊结果中断的局。
 * 引擎状态里的发接发、站位、球员 ID、待办和抛币事实一律不进入公开 DTO。
 */
function authoritativeFacts(state: unknown): AuthoritativeFacts {
  const empty: AuthoritativeFacts = { gamesWon: null, stoppedGame: null, winnerSide: null };
  if (!state || typeof state !== "object") return empty;
  const snapshot = state as Record<string, unknown>;

  const rawGamesWon = snapshot.gamesWon;
  let gamesWon: AuthoritativeFacts["gamesWon"] = null;
  if (rawGamesWon && typeof rawGamesWon === "object") {
    const pair = rawGamesWon as Record<string, unknown>;
    if (typeof pair.A === "number" && typeof pair.B === "number") gamesWon = { A: pair.A, B: pair.B };
  }

  const special = snapshot.specialOutcome;
  let winnerSide: "A" | "B" | null = null;
  let stoppedGame: number | null = null;
  if (special && typeof special === "object") {
    const outcome = special as Record<string, unknown>;
    if (outcome.winnerSide === "A" || outcome.winnerSide === "B") winnerSide = outcome.winnerSide;
    if (typeof snapshot.currentGame === "number") stoppedGame = snapshot.currentGame;
  } else if (gamesWon && gamesWon.A !== gamesWon.B) {
    const phase = snapshot.phase;
    const ended = phase === "MATCH_COMPLETE_PENDING_SUBMISSION" || phase === "SUBMITTED" || phase === "CONFIRMED";
    if (ended) winnerSide = gamesWon.A > gamesWon.B ? "A" : "B";
  }

  return { gamesWon, stoppedGame, winnerSide };
}

// --- 逐局比分 ---------------------------------------------------------------

type GameRow = { number: number; scoreA: number; scoreB: number; completed: boolean };

/**
 * 局数由冻结规则的 `bestOf` 决定，不固定三局。
 * 尚未开赛的比赛全部显示为未进行；不把种子创建的 0:0 占位行当作真实比分。
 */
export function projectGames(
  games: readonly GameRow[],
  bestOf: number,
  lifecycle: PublicMatchPreview["lifecycle"],
  stoppedGame: number | null,
): PublicGameScore[] {
  const started = lifecycle !== "SCHEDULED" && lifecycle !== "READY";
  const byNumber = new Map(games.map((game) => [game.number, game]));
  const highest = Math.max(bestOf, ...games.map((game) => game.number), 1);

  return Array.from({ length: highest }, (_unused, index) => {
    const number = index + 1;
    const row = byNumber.get(number);
    if (!row || !started) {
      return { number, scoreA: null, scoreB: null, status: "NOT_STARTED" as const };
    }
    const status: PublicGameScore["status"] = row.completed
      ? "COMPLETED"
      : stoppedGame === number
        ? "STOPPED"
        : "IN_PROGRESS";
    return { number, scoreA: row.scoreA, scoreB: row.scoreB, status };
  });
}

// --- 时间语义 ---------------------------------------------------------------

/**
 * 当前数据模型只有 `Match.scheduledAt`，因此只能产出 `FIXED` 与 `TBD`。
 * `ESTIMATED` / `DELAYED` / `AFTER_MATCH` 需要原计划时间与前序比赛引用，
 * 阶段 4-0 没有这些列，不得凭当前时间或比分猜测。
 */
export function projectTime(scheduledAt: Date | null, scheduleDate: string): PublicMatchTime {
  if (scheduledAt) return { type: "FIXED", scheduledAt: scheduledAt.toISOString() };
  return { type: "TBD", scheduleDate };
}

// --- 公开更正标记 -----------------------------------------------------------

type RevisionRow = { revision: number; status: "PENDING" | "RETURNED" | "LOCKED" | "SUPERSEDED" };

/**
 * 公开更正是独立于结果有效性的一维；内部 `reason` 默认不公开。
 * 出现过被替代的版本且当前已有锁定结果 → 已公开更正；
 * 锁定之后又出现待复核/被退回 → 更正处理中。
 */
export function projectCorrectionState(revisions: readonly RevisionRow[]): CorrectionState {
  if (revisions.length < 2) return "NONE";
  const ordered = [...revisions].sort((first, second) => first.revision - second.revision);
  const latest = ordered[ordered.length - 1];
  const hadLocked = ordered.some((revision) => revision.status === "LOCKED" || revision.status === "SUPERSEDED");
  if (!hadLocked) return "NONE";
  if (latest.status === "PENDING" || latest.status === "RETURNED") return "UNDER_REVIEW";
  if (latest.status === "LOCKED") return "CORRECTED";
  return "NONE";
}

// --- 规则摘要 ---------------------------------------------------------------

export interface RuleSummary {
  bestOf: number;
  text: string;
}

/**
 * 只显示允许公开的赛制信息。三个内置 profile 仍是演示配置，
 * 未获赛事正式采纳前不得称为正式规程。
 */
export function projectRuleSummary(config: unknown): RuleSummary {
  const fallback: RuleSummary = { bestOf: 3, text: "规则快照缺失，赛制以现场公告为准。" };
  if (!config || typeof config !== "object") return fallback;
  const rule = config as Record<string, unknown>;
  const bestOf = typeof rule.bestOf === "number" ? rule.bestOf : null;
  const targetPoints = typeof rule.targetPoints === "number" ? rule.targetPoints : null;
  const winBy = typeof rule.winBy === "number" ? rule.winBy : null;
  const capPoints = typeof rule.capPoints === "number" ? rule.capPoints : null;
  if (bestOf === null || targetPoints === null) return fallback;

  const parts = [bestOf > 1 ? `${bestOf} 局 ${Math.ceil(bestOf / 2)} 胜` : "单局定胜负", `每局 ${targetPoints} 分`];
  if (winBy !== null) parts.push(`需净胜 ${winBy} 分`);
  if (capPoints !== null) parts.push(`封顶 ${capPoints} 分`);
  return { bestOf, text: parts.join(" · ") };
}

// --- 单场比赛 ---------------------------------------------------------------

export interface MatchRow {
  code: string;
  lifecycleStatus: PublicMatchPreview["lifecycle"];
  outcomeType: PublicMatchPreview["outcome"] | null;
  verificationStatus: PublicMatchPreview["verification"];
  scheduledAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  version: number;
  updatedAt: Date;
  court: { code: string; name: string } | null;
  group: { code: string; name: string } | null;
  sideAEntry: EntryRow | null;
  sideBEntry: EntryRow | null;
  games: readonly GameRow[];
  ruleSnapshot: { config: unknown } | null;
  snapshot: { state: unknown } | null;
  resultRevisions: readonly RevisionRow[];
}

export interface MatchContext {
  competitionCode: string;
  competitionName: string;
  namePolicy: NamePublicationPolicy;
  scheduleOrder: number;
  stageCode: string;
  stageName: string;
  timeZone: string;
  updatedAt: Date;
}

export function projectMatch(match: MatchRow, context: MatchContext): PublicMatchPreview {
  const facts = authoritativeFacts(match.snapshot?.state);
  const rule = projectRuleSummary(match.ruleSnapshot?.config);
  const scheduleDate = match.scheduledAt ? scheduleDateIn(context.timeZone, match.scheduledAt) : "";
  const stageName = match.group ? `${context.stageName} · ${match.group.name}` : context.stageName;

  return {
    code: match.code,
    competitionCode: context.competitionCode,
    competitionName: context.competitionName,
    correctionState: projectCorrectionState(match.resultRevisions),
    court: match.court?.name ?? null,
    endedAt: match.endedAt?.toISOString() ?? null,
    games: projectGames(match.games, rule.bestOf, match.lifecycleStatus, facts.stoppedGame),
    gamesWon: facts.gamesWon,
    lastSyncedAt: context.updatedAt.toISOString(),
    lifecycle: match.lifecycleStatus,
    outcome: match.outcomeType ?? "NORMAL",
    // 单调公开投影修订号。它与只随计分命令推进的 scoreVersion 不同：
    // 排期、场地或更正标记变化不会推进 scoreVersion，但会推进这里。
    projectionRevision: match.updatedAt.getTime(),
    publicCorrectionNote: null,
    ruleSummary: rule.text,
    scheduleDate,
    scheduleOrder: context.scheduleOrder,
    scoreVersion: match.version,
    sideA: projectEntry(match.sideAEntry, context.namePolicy),
    sideB: projectEntry(match.sideBEntry, context.namePolicy),
    stageCode: context.stageCode,
    stageName,
    startedAt: match.startedAt?.toISOString() ?? null,
    time: projectTime(match.scheduledAt, scheduleDate),
    verification: match.verificationStatus,
    winnerSide: facts.winnerSide,
  };
}

export type { TournamentPhaseValue };

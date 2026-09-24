export type MatchLifecycle = "SCHEDULED" | "READY" | "IN_PROGRESS" | "SUSPENDED" | "ENDED_PENDING_SUBMISSION" | "SUBMITTED";
export type VerificationState = "UNVERIFIED" | "PENDING_REVIEW" | "DISPUTED" | "SUPERSEDED" | "LOCKED";
export type OutcomeType = "NORMAL" | "WO" | "RET" | "DSQ" | "ABANDONED" | "BYE";
export type CorrectionState = "NONE" | "CORRECTED" | "UNDER_REVIEW";
export type PreviewScenario = "ready" | "loading" | "empty" | "error" | "stale";

export type PublicMatchTime =
  | { type: "FIXED" | "ESTIMATED"; scheduledAt: string }
  | { type: "DELAYED"; scheduledAt: string; originalScheduledAt: string }
  | { type: "AFTER_MATCH"; scheduleDate: string; precedingMatchCode: string }
  | { type: "TBD"; scheduleDate: string };

export interface PublicMember {
  publicCode: string;
  displayName: string;
}

export interface PublicEntry {
  code: string;
  displayName: string;
  /** 代表队在 `CODES_ONLY` 姓名政策下不公开，此时为 null。 */
  teamName: string | null;
  members: readonly PublicMember[];
}

export interface PublicGameScore {
  number: number;
  scoreA: number | null;
  scoreB: number | null;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "STOPPED";
}

export interface PublicMatchPreview {
  code: string;
  competitionCode: string;
  competitionName: string;
  correctionState: CorrectionState;
  court: string | null;
  endedAt: string | null;
  games: readonly PublicGameScore[];
  gamesWon: { A: number; B: number } | null;
  lastSyncedAt: string;
  lifecycle: MatchLifecycle;
  outcome: OutcomeType;
  projectionRevision: number;
  publicCorrectionNote: string | null;
  ruleSummary: string;
  scheduleDate: string;
  scheduleOrder: number;
  scoreVersion: number;
  sideA: PublicEntry | null;
  sideB: PublicEntry | null;
  stageCode: string;
  stageName: string;
  startedAt: string | null;
  time: PublicMatchTime;
  verification: VerificationState;
  winnerSide: "A" | "B" | null;
}

export interface ScheduleDateOption {
  date: string;
  dayLabel: string;
  weekdayLabel: string;
}

export type TournamentPhaseValue =
  | "PREPARING"
  | "REGISTRATION_OPEN"
  | "REGISTRATION_CLOSED"
  | "RUNNING"
  | "FINISHED";

export interface PublicTournamentPreview {
  announcement: string | null;
  dates: readonly ScheduleDateOption[];
  name: string;
  phase: TournamentPhaseValue;
  slug: string;
  subtitle: string | null;
  /** 已由服务端按 IANA 标识校验过的赛事时区；全部公开时间以它为准。 */
  timezone: string;
  updatedAt: string;
  venue: string | null;
}

/** 首页赛事列表用的卡片投影；不含任何比赛明细。 */
export interface PublicTournamentCard {
  endDate: string | null;
  liveMatchCount: number;
  name: string;
  organizer: string | null;
  phase: TournamentPhaseValue;
  posterAlt: string | null;
  posterPath: string | null;
  publishedMatchCount: number;
  slug: string;
  startDate: string | null;
  subtitle: string | null;
  summary: string | null;
  timezone: string;
  venue: string | null;
}

export const lifecycleLabels: Record<MatchLifecycle, string> = {
  SCHEDULED: "已排期",
  READY: "待开赛",
  IN_PROGRESS: "进行中",
  SUSPENDED: "已暂停",
  ENDED_PENDING_SUBMISSION: "已结束待提交",
  SUBMITTED: "已提交",
};

export const verificationLabels: Record<VerificationState, string> = {
  UNVERIFIED: "尚未确认",
  PENDING_REVIEW: "待裁判长复核",
  DISPUTED: "争议处理中",
  SUPERSEDED: "已被新版本替代",
  LOCKED: "正式结果",
};

export const outcomeLabels: Record<OutcomeType, string> = {
  NORMAL: "常规完成",
  WO: "弃权",
  RET: "退赛",
  DSQ: "取消资格",
  ABANDONED: "比赛中止",
  BYE: "轮空",
};

export const correctionLabels: Record<CorrectionState, string> = {
  NONE: "无公开更正",
  CORRECTED: "已公开更正",
  UNDER_REVIEW: "更正处理中",
};

export const previewScenarioLabels: Record<PreviewScenario, string> = {
  ready: "正常数据",
  loading: "加载中",
  empty: "当日无赛程",
  error: "接口失败",
  stale: "数据可能过期",
};

export const tournamentPhaseLabels: Record<TournamentPhaseValue, string> = {
  PREPARING: "筹备中",
  REGISTRATION_OPEN: "报名进行中",
  REGISTRATION_CLOSED: "报名已截止",
  RUNNING: "进行中",
  FINISHED: "已结束",
};

/** 首页分组。phase 由组织者显式推进，不按当前时间推导。 */
export type TournamentBucket = "RUNNING" | "UPCOMING" | "FINISHED";

export const tournamentBucketLabels: Record<TournamentBucket, string> = {
  RUNNING: "进行中",
  UPCOMING: "即将开始",
  FINISHED: "已结束",
};

export function tournamentBucket(phase: TournamentPhaseValue): TournamentBucket {
  if (phase === "RUNNING") return "RUNNING";
  if (phase === "FINISHED") return "FINISHED";
  return "UPCOMING";
}

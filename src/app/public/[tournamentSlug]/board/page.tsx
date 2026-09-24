import { notFound } from "next/navigation";

import { MatchBoardAutoRefresh } from "@/components/match-board-auto-refresh";
import { getPublicTournament, isPublicTournamentSlug } from "@/server/services/public-tournament-service";
import { AppError } from "@/server/services/errors";
import { StatusBadge, type StatusTone } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

type Tournament = Awaited<ReturnType<typeof getPublicTournament>>;
type PublicMatch = Tournament["competitions"][number]["stages"][number]["matches"][number] & {
  competitionCode: string;
  competitionName: string;
};
type BoardGroup = "LIVE" | "ACTION" | "UPCOMING" | "DONE";

const groupCopy: Record<BoardGroup, { eyebrow: string; title: string; empty: string }> = {
  LIVE: { eyebrow: "COURTS NOW", title: "正在进行", empty: "当前没有进行中的比赛。" },
  ACTION: { eyebrow: "ACTION REQUIRED", title: "赛后待处理", empty: "当前没有待提交或待复核结果。" },
  UPCOMING: { eyebrow: "UP NEXT", title: "待开赛", empty: "当前没有待开赛比赛。" },
  DONE: { eyebrow: "FINAL RESULTS", title: "已完成", empty: "当前没有已锁定结果。" },
};

function boardGroup(match: PublicMatch): BoardGroup {
  if (match.verificationStatus === "LOCKED") return "DONE";
  if (match.lifecycleStatus === "IN_PROGRESS" || match.lifecycleStatus === "SUSPENDED") return "LIVE";
  if (match.lifecycleStatus === "ENDED_PENDING_SUBMISSION" || match.lifecycleStatus === "SUBMITTED") return "ACTION";
  return "UPCOMING";
}

function statusPresentation(match: PublicMatch): { label: string; detail?: string; tone: StatusTone } {
  if (match.verificationStatus === "LOCKED") return { label: "已完成", detail: "结果已锁定", tone: "ok" };
  if (match.lifecycleStatus === "SUBMITTED") return { label: "待复核", detail: "裁判长确认", tone: "warn" };
  if (match.lifecycleStatus === "ENDED_PENDING_SUBMISSION") return { label: "待提交", detail: "主裁判提交", tone: "warn" };
  if (match.lifecycleStatus === "IN_PROGRESS") return { label: "进行中", tone: "danger" };
  if (match.lifecycleStatus === "SUSPENDED") return { label: "已暂停", tone: "warn" };
  if (match.lifecycleStatus === "READY") return { label: "全新 0:0", detail: "可直接开赛", tone: "info" };
  return { label: "已排期", tone: "neutral" };
}

function matchTime(value: Date | null, timezone: string) {
  if (!value) return "时间待定";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function gameScore(match: PublicMatch) {
  const games = match.games.filter((game) => game.completed || game.scoreA > 0 || game.scoreB > 0);
  if (games.length === 0) return match.outcomeType && match.outcomeType !== "NORMAL" ? match.outcomeType : "—";
  return games.map((game) => `${game.scoreA}:${game.scoreB}`).join(" · ");
}

function gameWins(match: PublicMatch) {
  return match.games.reduce((wins, game) => {
    if (!game.completed || game.scoreA === game.scoreB) return wins;
    if (game.scoreA > game.scoreB) wins.A += 1;
    else wins.B += 1;
    return wins;
  }, { A: 0, B: 0 });
}

function MatchCard({ match, timezone }: { match: PublicMatch; timezone: string }) {
  const presentation = statusPresentation(match);
  const wins = gameWins(match);
  return (
    <article className="board-match-card" data-testid={`board-match-${match.code}`}>
      <div className="board-match-meta">
        <span>{matchTime(match.scheduledAt, timezone)}</span>
        <span>{match.court?.name ?? "场地待定"}</span>
        <StatusBadge detail={presentation.detail} tone={presentation.tone}>{presentation.label}</StatusBadge>
      </div>
      <div className="board-match-code">{match.competitionCode} · {match.code}</div>
      <div className="board-sides">
        <strong className={wins.A > wins.B ? "is-winner" : undefined}>{match.sideAEntry?.displayName ?? "待定"}</strong>
        <span className="board-versus">{wins.A || wins.B ? `${wins.A} — ${wins.B}` : "VS"}</span>
        <strong className={wins.B > wins.A ? "is-winner" : undefined}>{match.sideBEntry?.displayName ?? "待定"}</strong>
      </div>
      <div className="board-score" aria-label={`${match.code} 局分`}>{gameScore(match)}</div>
    </article>
  );
}

export default async function MatchBoardPage({
  params,
}: {
  params: Promise<{ tournamentSlug: string }>;
}) {
  const { tournamentSlug } = await params;
  if (!isPublicTournamentSlug(tournamentSlug)) notFound();

  let tournament: Tournament;
  try {
    tournament = await getPublicTournament(tournamentSlug);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  const matches: PublicMatch[] = tournament.competitions.flatMap((competition) =>
    competition.stages.flatMap((stage) =>
      stage.matches.map((match) => ({ ...match, competitionCode: competition.code, competitionName: competition.name })),
    ),
  );
  const grouped = Object.fromEntries(
    (["LIVE", "ACTION", "UPCOMING", "DONE"] as const).map((group) => [
      group,
      matches
        .filter((match) => boardGroup(match) === group)
        .sort((left, right) => {
          const leftTime = left.scheduledAt?.getTime() ?? 0;
          const rightTime = right.scheduledAt?.getTime() ?? 0;
          return group === "DONE" ? rightTime - leftTime : leftTime - rightTime;
        }),
    ]),
  ) as Record<BoardGroup, PublicMatch[]>;

  return (
    <section className="match-board-page">
      <div className="section-heading board-heading">
        <div>
          <p className="eyebrow">COURTS NOW</p>
          <h1>现场看板</h1>
          <p>{tournament.name} · 数据来自服务端公开白名单，按状态分组展示现场进度、赛后待处理和已锁定结果。</p>
        </div>
        <MatchBoardAutoRefresh serverRefreshedAt={new Date().toISOString()} />
      </div>

      <div className="board-summary" aria-label="比赛状态汇总">
        <div><strong>{matches.length}</strong><span>全部比赛</span></div>
        <div><strong>{grouped.LIVE.length}</strong><span>正在进行</span></div>
        <div><strong>{grouped.ACTION.length}</strong><span>赛后待处理</span></div>
        <div><strong>{grouped.UPCOMING.length}</strong><span>待开赛</span></div>
        <div><strong>{grouped.DONE.length}</strong><span>已完成</span></div>
      </div>

      {(["LIVE", "ACTION", "UPCOMING", "DONE"] as const).map((group) => (
        <section className="board-section" data-board-group={group} key={group}>
          <div className="board-section-title">
            <div><p className="eyebrow">{groupCopy[group].eyebrow}</p><h2>{groupCopy[group].title}</h2></div>
            <span>{grouped[group].length} 场</span>
          </div>
          {grouped[group].length ? (
            <div className="board-match-grid">
              {grouped[group].map((match) => <MatchCard key={match.code} match={match} timezone={tournament.timezone} />)}
            </div>
          ) : <p className="empty-state">{groupCopy[group].empty}</p>}
        </section>
      ))}

      <p className="notice">看板为只读投影。要实际记分，请使用裁判账号从“我的执裁”进入；比分与状态只有服务器确认后才会刷新到这里。</p>
      <p className="notice">需要按日期、项目、场地筛选或查看逐局比分，请使用<a href={`/public/${tournamentSlug}/schedule`}>每日赛程</a>。</p>
    </section>
  );
}

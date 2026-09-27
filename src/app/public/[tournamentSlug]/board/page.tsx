import Link from "next/link";
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

const groupOrder: readonly BoardGroup[] = ["LIVE", "ACTION", "UPCOMING", "DONE"];

const groupCopy: Record<BoardGroup, { anchor: string; eyebrow: string; title: string; short: string; empty: string }> = {
  LIVE: { anchor: "live", eyebrow: "ON COURT", title: "正在进行", short: "进行中", empty: "当前没有进行中的比赛。" },
  ACTION: { anchor: "action", eyebrow: "UNDER REVIEW", title: "赛后待处理", short: "待处理", empty: "当前没有待提交或待复核结果。" },
  UPCOMING: { anchor: "upcoming", eyebrow: "UP NEXT", title: "待开赛", short: "待开赛", empty: "当前没有待开赛比赛。" },
  DONE: { anchor: "done", eyebrow: "FINAL RESULTS", title: "已完成", short: "已完成", empty: "当前没有已锁定结果。" },
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

function formatParts(value: Date | null, timezone: string) {
  if (!value) return { day: "日期待定", time: "待定" };
  const day = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "2-digit", day: "2-digit" }).format(value);
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
  return { day, time };
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

function currentGame(match: PublicMatch) {
  return [...match.games].reverse().find((game) => !game.completed) ?? null;
}

function detailHref(slug: string, match: PublicMatch) {
  return `/public/${slug}/matches/${encodeURIComponent(match.code)}`;
}

function MatchMeta({ match, timezone }: { match: PublicMatch; timezone: string }) {
  const { day, time } = formatParts(match.scheduledAt, timezone);
  const presentation = statusPresentation(match);
  return (
    <div className="gm-card-meta">
      <span className="gm-court">{match.court?.name ?? "场地待定"}</span>
      <span>{day} {time}</span>
      <StatusBadge detail={presentation.detail} tone={presentation.tone}>{presentation.label}</StatusBadge>
    </div>
  );
}

/** 进行中：深色大比分卡，突出当前局比分与各自已胜局数。 */
function LiveCard({ match, slug, timezone }: { match: PublicMatch; slug: string; timezone: string }) {
  const wins = gameWins(match);
  const game = currentGame(match);
  const sides = [
    { key: "A", name: match.sideAEntry?.displayName ?? "待定", won: wins.A, points: game?.scoreA ?? 0 },
    { key: "B", name: match.sideBEntry?.displayName ?? "待定", won: wins.B, points: game?.scoreB ?? 0 },
  ];
  return (
    <article className="gm-card gm-card-live" data-testid={`board-match-${match.code}`}>
      <MatchMeta match={match} timezone={timezone} />
      <div className="gm-code">{match.competitionCode} · {match.code}</div>
      <ol className="gm-live-sides" aria-label={`${match.code} 实时比分`}>
        {sides.map((side) => (
          <li key={side.key}>
            <strong>{side.name}</strong>
            <span className="gm-won" aria-label={`已胜 ${side.won} 局`}>{side.won}</span>
            <span className="gm-points" aria-label={`当前局 ${side.points} 分`}>{side.points}</span>
          </li>
        ))}
      </ol>
      <div className="gm-card-foot">
        <span className="gm-games" aria-label={`${match.code} 局分`}>{gameScore(match)}</span>
        <Link aria-label={`${match.code} 比赛详情`} className="gm-detail" href={detailHref(slug, match)}>详情</Link>
      </div>
    </article>
  );
}

/** 待处理与已完成：浅色结果卡。只有结果锁定后才标出胜方，待复核的比赛不提前宣布胜负。 */
function ResultCard({ match, slug, timezone }: { match: PublicMatch; slug: string; timezone: string }) {
  const wins = gameWins(match);
  const final = match.verificationStatus === "LOCKED";
  const winner = !final || wins.A === wins.B ? null : wins.A > wins.B ? "A" : "B";
  const sides = [
    { key: "A", name: match.sideAEntry?.displayName ?? "待定", won: wins.A },
    { key: "B", name: match.sideBEntry?.displayName ?? "待定", won: wins.B },
  ];
  return (
    <article className="gm-card gm-card-result" data-testid={`board-match-${match.code}`}>
      <MatchMeta match={match} timezone={timezone} />
      <div className="gm-code">{match.competitionCode} · {match.code}</div>
      <ol className="gm-result-sides">
        {sides.map((side) => (
          <li className={winner === side.key ? "is-winner" : undefined} key={side.key}>
            <strong>{side.name}</strong>
            {winner === side.key ? <span className="gm-win-mark">胜</span> : null}
            <span className="gm-won">{side.won}</span>
          </li>
        ))}
      </ol>
      <div className="gm-card-foot">
        <span className="gm-games" aria-label={`${match.code} 局分`}>{gameScore(match)}</span>
        <Link aria-label={`${match.code} 比赛详情`} className="gm-detail" href={detailHref(slug, match)}>详情</Link>
      </div>
    </article>
  );
}

/** 待开赛：按时间排的赛程条。 */
function UpcomingRow({ match, slug, timezone }: { match: PublicMatch; slug: string; timezone: string }) {
  const { day, time } = formatParts(match.scheduledAt, timezone);
  const presentation = statusPresentation(match);
  return (
    <li className="gm-up-row" data-testid={`board-match-${match.code}`}>
      <div className="gm-up-time"><strong>{time}</strong><span>{day}</span></div>
      <div className="gm-up-body">
        <div className="gm-up-meta">
          <span className="gm-court">{match.court?.name ?? "场地待定"}</span>
          <span className="gm-code">{match.competitionCode} · {match.code}</span>
        </div>
        <p className="gm-up-sides">
          <strong>{match.sideAEntry?.displayName ?? "待定"}</strong>
          <span aria-hidden="true">VS</span>
          <span className="visually-hidden">对</span>
          <strong>{match.sideBEntry?.displayName ?? "待定"}</strong>
        </p>
      </div>
      <div className="gm-up-status">
        <StatusBadge detail={presentation.detail} tone={presentation.tone}>{presentation.label}</StatusBadge>
        <Link aria-label={`${match.code} 比赛详情`} className="gm-detail" href={detailHref(slug, match)}>详情</Link>
      </div>
    </li>
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
    groupOrder.map((group) => [
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
  const courts = new Set(grouped.LIVE.map((match) => match.court?.code).filter(Boolean)).size;

  return (
    <div className="gm-board">
      <header className="gm-hero">
        <div className="gm-hero-inner">
          <div className="gm-hero-copy">
            <p className="gm-kicker"><span className="gm-live-dot" aria-hidden="true" />LIVE BOARD</p>
            <h1>现场看板</h1>
            <p>{tournament.name}</p>
          </div>
          <MatchBoardAutoRefresh serverRefreshedAt={new Date().toISOString()} />
        </div>
        <dl className="gm-kpis" aria-label="比赛状态汇总">
          <div><dt>全部比赛</dt><dd>{matches.length}</dd></div>
          <div className="gm-kpi-live"><dt>正在进行</dt><dd>{grouped.LIVE.length}</dd></div>
          <div><dt>在用场地</dt><dd>{courts}</dd></div>
          <div><dt>赛后待处理</dt><dd>{grouped.ACTION.length}</dd></div>
          <div><dt>待开赛</dt><dd>{grouped.UPCOMING.length}</dd></div>
          <div><dt>已完成</dt><dd>{grouped.DONE.length}</dd></div>
        </dl>
      </header>

      <nav aria-label="看板分区" className="gm-jump">
        {groupOrder.map((group) => (
          <a href={`#${groupCopy[group].anchor}`} key={group}>
            {groupCopy[group].short}<span>{grouped[group].length}</span>
          </a>
        ))}
      </nav>

      {groupOrder.map((group) => (
        <section
          aria-labelledby={`board-${groupCopy[group].anchor}-title`}
          className={`gm-section gm-section-${groupCopy[group].anchor}`}
          data-board-group={group}
          id={groupCopy[group].anchor}
          key={group}
        >
          <div className="gm-section-title">
            <div>
              <p className="gm-eyebrow">{groupCopy[group].eyebrow}</p>
              <h2 id={`board-${groupCopy[group].anchor}-title`}>{groupCopy[group].title}</h2>
            </div>
            <span>{grouped[group].length} 场</span>
          </div>
          {grouped[group].length === 0 ? (
            <p className="gm-empty">{groupCopy[group].empty}</p>
          ) : group === "UPCOMING" ? (
            <ol className="gm-up-list">
              {grouped[group].map((match) => (
                <UpcomingRow key={match.code} match={match} slug={tournamentSlug} timezone={tournament.timezone} />
              ))}
            </ol>
          ) : (
            <div className={group === "LIVE" ? "gm-live-grid" : "gm-result-grid"}>
              {grouped[group].map((match) => group === "LIVE"
                ? <LiveCard key={match.code} match={match} slug={tournamentSlug} timezone={tournament.timezone} />
                : <ResultCard key={match.code} match={match} slug={tournamentSlug} timezone={tournament.timezone} />)}
            </div>
          )}
        </section>
      ))}

      <footer className="gm-footnotes">
        <p>看板为只读投影。要实际记分，请使用裁判账号从“我的执裁”进入；比分与状态只有服务器确认后才会刷新到这里。</p>
        <p>需要按日期、项目、场地筛选或查看逐局比分，请使用<Link href={`/public/${tournamentSlug}/schedule`}>每日赛程</Link>。</p>
      </footer>
    </div>
  );
}

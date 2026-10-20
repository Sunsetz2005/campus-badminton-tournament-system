import Link from "next/link";
import { forbidden, notFound, redirect } from "next/navigation";

import { RUBBER_LABEL, type RubberKind } from "@/domain/registration/team-roster";
import { formatZonedClock, formatZonedShort } from "@/domain/time/zoned-time";
import {
  OFFICIATING_VIEWS,
  filterOfficiatingMatches,
  groupOfficiatingMatches,
  isFinished,
  parseOfficiatingView,
  type OfficiatingView,
} from "@/features/officiating/grouping";
import { RememberOfficiatingList } from "@/features/officiating/return-path";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { AppError } from "@/server/services/errors";
import { loadOfficiatingTournament, type OfficiatingMatch } from "@/server/services/officiating-service";
import { StatusBadge, type StatusTone } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

const verificationLabel: Record<string, string> = {
  UNVERIFIED: "待复核",
  PENDING_REVIEW: "待复核",
  DISPUTED: "有争议",
  LOCKED: "已锁定",
  SUPERSEDED: "已被更正",
};

function liveLabel(match: OfficiatingMatch): { text: string; tone: StatusTone } {
  if (match.status === "NOT_PLAYED") return { text: "未进行", tone: "neutral" };
  if (match.status === "ENDED") return { text: "已结束", tone: "ok" };
  if (match.status === "IN_PROGRESS") return { text: "进行中", tone: "info" };
  // 只提示有现场事实为据的延误（前面的比赛超时或晚结束），不因「过了计划时间」本身判为延误。
  if (match.delayMinutes !== null) return { text: `前场未完，约推迟 ${match.delayMinutes} 分钟`, tone: "warn" };
  return match.fresh ? { text: "全新 · 0:0", tone: "ok" } : { text: "待开赛", tone: "neutral" };
}

function MatchCard({ match, timeZone, view }: { match: OfficiatingMatch; timeZone: string; view: OfficiatingView }) {
  const label = liveLabel(match);
  // 按时间分组时组标题已经是日期，卡片只写时刻；其他视图写「月-日 时:分」。
  const time = match.scheduledAt
    ? `${match.scheduleEstimated ? "约 " : ""}${view === "time" ? formatZonedClock(match.scheduledAt, timeZone) : formatZonedShort(match.scheduledAt, timeZone)}`
    : "时间待定";
  const finished = isFinished(match.status);
  return (
    <li>
      <Link
        aria-label={`${finished ? "查看" : "进入执裁"} ${match.code}`}
        className={`officiating-match${match.status === "IN_PROGRESS" ? " is-live" : ""}${finished ? " is-finished" : ""}`}
        data-testid="assignment-card"
        href={`/officiating/${match.code}`}
      >
        <span className="officiating-match-time">{time}</span>
        <span className="officiating-match-main">
          <span className="officiating-match-top">
            <strong className="officiating-match-code">{match.code}</strong>
            <StatusBadge tone={label.tone}>{label.text}</StatusBadge>
          </span>
          <span className="officiating-match-vs">
            <span>{match.sideA}</span>
            <em>vs</em>
            <span>{match.sideB}</span>
          </span>
          <span className="officiating-match-meta">
            {view !== "court" ? <span>{match.court?.name ?? "场地待定"}</span> : null}
            {view !== "event" ? <span>{match.competition.name}</span> : null}
            {match.rubberKind && match.rubberOrder ? <span>第 {match.rubberOrder} 场{RUBBER_LABEL[match.rubberKind as RubberKind] ?? ""}</span> : null}
          </span>
        </span>
        <span aria-hidden="true" className="officiating-match-go">{finished ? "查看" : "进入执裁"}</span>
      </Link>
    </li>
  );
}

export default async function OfficiatingTournamentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const pick = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : undefined);
  const basePath = `/officiating/tournament/${encodeURIComponent(slug)}`;
  const session = await getPageSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(basePath)}`);
  const user = await requireActivePageUser(session);
  let data: Awaited<ReturnType<typeof loadOfficiatingTournament>>;
  try {
    data = await loadOfficiatingTournament(user.id, slug);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    if (error instanceof AppError && error.status === 403) forbidden();
    throw error;
  }
  const { tournament, role, matches, reviewMatches } = data;
  const view = parseOfficiatingView(pick("view"));
  const showFinished = pick("done") === "1";
  const search = pick("q")?.trim() ?? "";
  const visible = filterOfficiatingMatches(matches, { showFinished, query: search });
  const groups = groupOfficiatingMatches(visible, view, tournament.timezone);
  const finishedCount = matches.filter((match) => isFinished(match.status)).length;
  const liveCount = matches.filter((match) => match.status === "IN_PROGRESS").length;
  const upcomingCount = matches.filter((match) => match.status === "NOT_STARTED").length;
  const href = (next: { view?: OfficiatingView; done?: boolean; q?: string }) => {
    const params = new URLSearchParams();
    const nextView = next.view ?? view;
    const nextSearch = next.q ?? search;
    if (nextView !== "court") params.set("view", nextView);
    if (next.done ?? showFinished) params.set("done", "1");
    if (nextSearch) params.set("q", nextSearch);
    const text = params.toString();
    return text ? `${basePath}?${text}` : basePath;
  };

  return (
    <section>
      <RememberOfficiatingList />
      <div className="section-heading">
        <p className="eyebrow"><Link href="/officiating">我的执裁</Link> · 裁判</p>
        <h1>{tournament.name}</h1>
        <p>
          {tournament.refereeMode === "SHARED_ACCOUNT"
            ? "全体裁判共用裁判账号，可以执裁本赛事任意一场：找到自己场地上的比赛进入即可。同一场只能由一台设备记分，别的设备打开只能旁观。"
            : "这里只列出指派给你的比赛。"}
          每一分都要服务器确认后才算数。
        </p>
      </div>

      {role.referee ? (
        <>
          <div className="officiating-summary" aria-label="比赛概况">
            <div className={liveCount ? "is-live" : undefined}><strong>{liveCount}</strong><span>进行中</span></div>
            <div><strong>{upcomingCount}</strong><span>待开赛</span></div>
            <div><strong>{finishedCount}</strong><span>已结束</span></div>
          </div>
          <div className="officiating-toolbar">
            <nav aria-label="查看方式" className="officiating-views">
              {OFFICIATING_VIEWS.map((option) => (
                <Link aria-current={option.value === view ? "page" : undefined} href={href({ view: option.value })} key={option.value}>
                  {option.label}
                </Link>
              ))}
            </nav>
            <form action={basePath} className="officiating-search" role="search">
              {view !== "court" ? <input name="view" type="hidden" value={view} /> : null}
              {showFinished ? <input name="done" type="hidden" value="1" /> : null}
              <input aria-label="搜索比赛编号或选手" defaultValue={search} name="q" placeholder="搜编号或选手" type="search" />
              <button className="button secondary" type="submit">搜索</button>
            </form>
            <Link className="officiating-toggle" href={href({ done: !showFinished })}>
              {showFinished ? "隐藏已结束" : `显示已结束（${finishedCount}）`}
            </Link>
          </div>
          {search ? (
            <p className="officiating-filter-note">
              搜索「{search}」：{visible.length} 场。<Link href={href({ q: "" })}>清除搜索</Link>
            </p>
          ) : null}
          {groups.length ? (
            <div className="officiating-groups">
              {groups.map((group) => (
                <section className="officiating-group" data-testid="officiating-group" key={group.key}>
                  <header className="officiating-group-head">
                    <h2>{group.title}</h2>
                    <span>
                      {group.liveCount ? <strong>{group.liveCount} 场进行中</strong> : null}
                      {group.upcomingCount} 场待开赛
                    </span>
                  </header>
                  <ul className="officiating-match-list">
                    {group.matches.map((match) => <MatchCard key={match.code} match={match} timeZone={tournament.timezone} view={view} />)}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="empty-state">
              {matches.length
                ? search ? "没有符合搜索条件的比赛。" : "本赛事的比赛都已结束。可以点「显示已结束」查看。"
                : tournament.refereeMode === "SHARED_ACCOUNT"
                  ? "暂时没有双方已确定的比赛；抽签发布、前一轮结束后比赛会出现在这里。"
                  : "当前账号在本赛事没有有效裁判指派。"}
            </p>
          )}
        </>
      ) : null}

      {role.chief ? (
        <section className="stack" style={{ marginTop: role.referee ? "36px" : 0 }}>
          <div className="section-heading"><p className="eyebrow">裁判长权限</p><h2>现场赛程看板</h2></div>
          <p>按场地查看已发布赛程的现场状态与延误，临时更换裁判。</p>
          <Link className="button secondary" href={`/officiating/board/${tournament.slug}`}>打开看板</Link>
          <div className="section-heading"><p className="eyebrow">裁判长权限</p><h2>待复核结果</h2></div>
          {reviewMatches.length ? (
            <div className="card-grid">
              {reviewMatches.map((match) => (
                <article className="card assignment-card" key={match.code}>
                  <div className="assignment-head">
                    <StatusBadge tone="warn">{verificationLabel[match.verificationStatus] ?? match.verificationStatus}</StatusBadge>
                  </div>
                  <h3>{match.code}</h3>
                  <p className="assignment-vs">
                    <strong>{match.sideA}</strong>
                    <span>vs</span>
                    <strong>{match.sideB}</strong>
                  </p>
                  <p className="assignment-meta"><span>{match.courtName ?? "场地待定"}</span></p>
                  <Link className="button secondary assignment-go" href={`/officiating/${match.code}`}>进入复核 / 接管</Link>
                </article>
              ))}
            </div>
          ) : <p className="empty-state">当前没有待复核结果。</p>}
        </section>
      ) : null}
    </section>
  );
}

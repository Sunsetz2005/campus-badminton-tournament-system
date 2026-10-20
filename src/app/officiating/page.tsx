import { redirect } from "next/navigation";
import Link from "next/link";

import { TournamentPoster } from "@/components/tournament-poster";
import { formatDateRange } from "@/features/public-results/format";
import { tournamentPhaseLabels } from "@/features/public-results/model";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { listOfficiatingTournaments } from "@/server/services/officiating-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

/** 「我的执裁」入口：一个赛事一个入口，进入后再按场地/时间/项目找比赛。 */
export default async function OfficiatingPage() {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/officiating");
  const user = await requireActivePageUser(session);
  const tournaments = await listOfficiatingTournaments(user.id);

  return (
    <section>
      <div className="section-heading">
        <p className="eyebrow">裁判</p>
        <h1>我的执裁</h1>
        <p>先选赛事，进入后按场地找到自己负责的比赛（也可以按时间或项目查看）。进行中的赛事排在最前。</p>
      </div>
      {tournaments.length ? (
        <ul className="tournament-list" data-testid="officiating-tournaments">
          {tournaments.map((tournament) => {
            const facts = [formatDateRange(tournament.startDate, tournament.endDate), tournament.venue].filter(
              (fact): fact is string => Boolean(fact),
            );
            return (
              <li className="tournament-row" data-testid="officiating-tournament" key={tournament.slug}>
                <Link aria-label={`进入 ${tournament.name} 的执裁`} href={`/officiating/tournament/${tournament.slug}`}>
                  <TournamentPoster tournament={tournament} />
                  <div className="tournament-row-body">
                    <div className="tournament-row-heading">
                      <h3>{tournament.name}</h3>
                      <StatusBadge tone={tournament.phase === "RUNNING" ? "danger" : "neutral"}>{tournamentPhaseLabels[tournament.phase]}</StatusBadge>
                    </div>
                    {tournament.subtitle ? <p className="tournament-row-subtitle">{tournament.subtitle}</p> : null}
                    <dl className="tournament-row-facts">
                      {facts.map((fact) => <div key={fact}><dd>{fact}</dd></div>)}
                    </dl>
                    <p className="tournament-row-counts">
                      {tournament.referee ? (
                        <>
                          {tournament.liveCount ? <strong>{tournament.liveCount} 场进行中</strong> : null}
                          <span>{tournament.upcomingCount} 场待开赛</span>
                          <span>{tournament.endedCount} 场已结束</span>
                        </>
                      ) : null}
                      {tournament.chief ? <span>裁判长 · {tournament.reviewCount} 场待复核</span> : null}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty-state">当前账号不是任何赛事的裁判员或裁判长。</p>
      )}
    </section>
  );
}

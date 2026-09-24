import Link from "next/link";

import { TournamentPoster } from "@/components/tournament-poster";
import { formatDateRange } from "@/features/public-results/format";
import {
  tournamentBucket,
  tournamentBucketLabels,
  tournamentPhaseLabels,
  type PublicTournamentCard,
  type TournamentBucket,
} from "@/features/public-results/model";
import { listPublicTournaments } from "@/server/services/public-tournament-service";
import { StatusBadge, type StatusTone } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

const bucketOrder: readonly TournamentBucket[] = ["RUNNING", "UPCOMING", "FINISHED"];

const bucketCopy: Record<TournamentBucket, { eyebrow: string; empty: string }> = {
  RUNNING: { eyebrow: "COURTS NOW", empty: "当前没有正在进行的赛事。" },
  UPCOMING: { eyebrow: "UP NEXT", empty: "当前没有已公布的待开赛事。" },
  FINISHED: { eyebrow: "ARCHIVE", empty: "当前没有已结束的赛事。" },
};

function phaseTone(phase: PublicTournamentCard["phase"]): StatusTone {
  if (phase === "RUNNING") return "danger";
  if (phase === "REGISTRATION_OPEN") return "ok";
  if (phase === "FINISHED") return "neutral";
  return "info";
}

function TournamentRow({ tournament }: { tournament: PublicTournamentCard }) {
  const facts = [
    formatDateRange(tournament.startDate, tournament.endDate),
    tournament.venue,
    tournament.organizer,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <li className="tournament-row">
      <Link aria-label={`查看 ${tournament.name}`} href={`/public/${tournament.slug}/schedule`}>
        <TournamentPoster tournament={tournament} />
        <div className="tournament-row-body">
          <div className="tournament-row-heading">
            <h3>{tournament.name}</h3>
            <StatusBadge tone={phaseTone(tournament.phase)}>{tournamentPhaseLabels[tournament.phase]}</StatusBadge>
          </div>
          {tournament.subtitle ? <p className="tournament-row-subtitle">{tournament.subtitle}</p> : null}
          <dl className="tournament-row-facts">
            {facts.map((fact) => <div key={fact}><dd>{fact}</dd></div>)}
          </dl>
          <p className="tournament-row-counts">
            <span>{tournament.publishedMatchCount} 场已公开赛程</span>
            {tournament.liveMatchCount ? <strong>{tournament.liveMatchCount} 场进行中</strong> : null}
          </p>
        </div>
      </Link>
    </li>
  );
}

export default async function HomePage() {
  const tournaments = await listPublicTournaments();
  const grouped = new Map<TournamentBucket, PublicTournamentCard[]>(
    bucketOrder.map((bucket) => [bucket, []]),
  );
  tournaments.forEach((tournament) => {
    grouped.get(tournamentBucket(tournament.phase))?.push(tournament);
  });
  const visibleBuckets = bucketOrder.filter((bucket) => (grouped.get(bucket)?.length ?? 0) > 0);

  return (
    <>
      <section className="home-hero">
        <p className="eyebrow">校园羽毛球赛事编排与成绩管理</p>
        <h1>羽赛台</h1>
        <p>
          公开赛程、逐局比分与已确认结果。比分由现场主裁判在服务端权威记录，
          页面只读取公开字段，不展示账号、联系方式或内部审计信息。
        </p>
      </section>

      {tournaments.length === 0 ? (
        <p className="empty-state">当前没有已发布的赛事。赛事发布后会出现在这里。</p>
      ) : (
        visibleBuckets.map((bucket) => (
          <section className="tournament-section" key={bucket}>
            <div className="section-heading">
              <p className="eyebrow">{bucketCopy[bucket].eyebrow}</p>
              <h2>{tournamentBucketLabels[bucket]}</h2>
            </div>
            <ul className="tournament-list">
              {grouped.get(bucket)?.map((tournament) => (
                <TournamentRow key={tournament.slug} tournament={tournament} />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

import Link from "next/link";

import { prisma } from "@/db/client";
import { DRAW_FORMAT_LABEL } from "@/domain/draw/format";
import { CAMPUS_DEMO_RANKING } from "@/domain/results/ranking";
import styles from "@/features/management/management.module.css";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { loadCompetitionResults, RESULTS_VIEW_ROLES } from "@/server/services/results-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

/** 成绩与名次总览：每个项目的结果复核进度、小组名次确认与榜单发布状态。 */
export default async function ResultsOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tournament } = await requireManagedTournamentPage(slug, RESULTS_VIEW_ROLES);
  const competitions = await prisma.competition.findMany({
    where: { tournamentId: tournament.id },
    orderBy: { code: "asc" },
    select: { code: true },
  });
  const loaded = [];
  for (const competition of competitions) loaded.push(await loadCompetitionResults(prisma, tournament.id, competition.code));

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow">阶段 6 · 成绩、名次与晋级</p>
        <h1>成绩名次</h1>
        <p>
          只有经裁判长复核锁定的结果进入正式名次与晋级；其余只显示暂定并醒目标记。
          当前名次规则是「{CAMPUS_DEMO_RANKING.name}」，{CAMPUS_DEMO_RANKING.notice}
        </p>
      </div>
      <section aria-labelledby="results-list-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="results-list-title">项目</h2>
        </div>
        <ul className={styles.tieList}>
          {loaded.map((item) => {
            if (!item) return null;
            const { competition, draw, results } = item;
            const total = results?.matches.length ?? 0;
            const confirmed = results?.matches.filter((match) => match.fact.stage === "CONFIRMED").length ?? 0;
            const pendingReview = results?.matches.filter((match) => match.fact.stage === "PENDING_REVIEW").length ?? 0;
            const groupsConfirmed = results?.groups.filter((group) => group.confirmed).length ?? 0;
            return (
              <li key={competition.code}>
                <span className={styles.muted}>{competition.code}</span>
                <span className={styles.tieVs}>
                  <strong>{competition.name}</strong>
                  <br />
                  <span className={styles.muted}>
                    {competition.entryType === "TEAM"
                      ? "团体项目：积分榜与名次确认在「团体对抗」页面"
                      : draw
                        ? `${DRAW_FORMAT_LABEL[draw.format]} · 已确认 ${confirmed}/${total} 场 · 待复核 ${pendingReview} 场 · 小组名次已确认 ${groupsConfirmed}/${results?.groups.length ?? 0}`
                        : "尚未发布抽签"}
                  </span>
                </span>
                <span className={styles.actions}>
                  {results?.needsRepublish ? <StatusBadge tone="warn">榜单需重新发布</StatusBadge> : null}
                  {results?.publications[0] ? <StatusBadge tone="ok">已发布第 {results.publications[0].version} 版</StatusBadge> : null}
                  {competition.entryType === "TEAM" ? (
                    <Link className="button small" href={`/management/${tournament.slug}/ties/${competition.code}`}>团体对抗</Link>
                  ) : draw ? (
                    <Link className="button small" href={`/management/${tournament.slug}/results/${competition.code}`}>成绩与名次</Link>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

import Link from "next/link";

import { prisma } from "@/db/client";
import { DRAW_FORMAT_LABEL } from "@/domain/draw/format";
import styles from "@/features/management/management.module.css";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

/** 团体对抗总览：每个团体项目已发布抽签的对抗进度。 */
export default async function TiesOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tournament } = await requireManagedTournamentPage(slug);
  const competitions = await prisma.competition.findMany({
    where: { tournamentId: tournament.id, entryType: "TEAM" },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      draws: { where: { status: "PUBLISHED" }, select: { format: true, version: true } },
      fixtures: {
        where: { draw: { status: "PUBLISHED" } },
        select: { lineupsRevealedAt: true, winnerEntryId: true },
      },
    },
  });

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow">阶段 4-D</p>
        <h1>团体对抗</h1>
        <p>
          抽签发布后，各队负责人为每场对抗提交出场名单（双方盲交，交齐后同时公开并锁定）。小场结果经裁判长复核锁定后自动计入对抗胜负；
          淘汰赛胜负者自动进入下一轮，小组名次由裁判长确认后回填淘汰签位。
        </p>
      </div>
      <section aria-labelledby="tie-list-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="tie-list-title">团体项目</h2>
          <p>只列出已发布抽签的对抗。</p>
        </div>
        {competitions.length === 0 ? (
          <p className="empty-state">本赛事没有团体项目。</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.tableWide}`}>
              <thead>
                <tr><th>项目</th><th>赛制</th><th>对抗</th><th>名单已公开</th><th>已决出胜负</th><th /></tr>
              </thead>
              <tbody>
                {competitions.map((competition) => {
                  const draw = competition.draws[0];
                  return (
                    <tr data-testid="tie-competition-row" key={competition.id}>
                      <td><strong>{competition.code}</strong> {competition.name}</td>
                      <td>{draw ? `${DRAW_FORMAT_LABEL[draw.format]} · 第 ${draw.version} 版` : <StatusBadge>未发布抽签</StatusBadge>}</td>
                      <td>{competition.fixtures.length}</td>
                      <td>{competition.fixtures.filter((fixture) => fixture.lineupsRevealedAt).length}</td>
                      <td>{competition.fixtures.filter((fixture) => fixture.winnerEntryId).length}</td>
                      <td>{draw ? <Link href={`/management/${tournament.slug}/ties/${competition.code}`}>进入</Link> : <Link href={`/management/${tournament.slug}/draw/${competition.code}`}>去抽签</Link>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

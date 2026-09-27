import Link from "next/link";

import { prisma } from "@/db/client";
import { DRAW_FORMAT_LABEL, suggestFormat } from "@/domain/draw/format";
import { entryTypeLabel } from "@/features/management/labels";
import styles from "@/features/management/management.module.css";
import { tournamentPhaseLabels } from "@/features/public-results/model";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function DrawOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tournament } = await requireManagedTournamentPage(slug);
  const competitions = await prisma.competition.findMany({
    where: { tournamentId: tournament.id },
    orderBy: [{ entryType: "desc" }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      name: true,
      entryType: true,
      _count: { select: { entries: true, registrations: { where: { status: "PENDING" } } } },
      draws: {
        where: { status: { in: ["DRAFT", "PUBLISHED"] } },
        select: { status: true, version: true, format: true, conflictCount: true },
      },
    },
  });

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow">阶段 4-B</p>
        <h1>抽签编排</h1>
        <p>
          按项目生成抽签草稿，可反复重抽和手动调签；报名截止、待审核清零后才能正式发布。发布后生成对阵与比赛并冻结报名单位。
          当前阶段：{tournamentPhaseLabels[tournament.phase]}。
        </p>
      </div>
      <section aria-labelledby="draw-list-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="draw-list-title">项目</h2>
          <p>团体赛排在前面。只有审核通过的报名单位参加抽签。</p>
        </div>
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.tableWide}`}>
            <thead>
              <tr><th>项目</th><th>类型</th><th>报名单位</th><th>待审核</th><th>建议赛制</th><th>抽签状态</th><th /></tr>
            </thead>
            <tbody>
              {competitions.map((competition) => {
                const published = competition.draws.find((draw) => draw.status === "PUBLISHED");
                const draft = competition.draws.find((draw) => draw.status === "DRAFT");
                const suggestion = suggestFormat(competition._count.entries);
                return (
                  <tr data-testid="draw-competition-row" key={competition.id}>
                    <td><strong>{competition.code}</strong> {competition.name}</td>
                    <td>{entryTypeLabel[competition.entryType]}</td>
                    <td>{competition._count.entries}</td>
                    <td>{competition._count.registrations}</td>
                    <td>{suggestion ? `${DRAW_FORMAT_LABEL[suggestion.format]}${suggestion.groupCount ? ` · ${suggestion.groupCount} 组` : ""}` : "不足 2 个，不编排"}</td>
                    <td>
                      {published ? (
                        <StatusBadge tone="ok">已发布 · 第 {published.version} 版</StatusBadge>
                      ) : draft ? (
                        <StatusBadge tone="warn" detail={draft.conflictCount ? `${draft.conflictCount} 处冲突` : undefined}>草稿 · 第 {draft.version} 版</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">未抽签</StatusBadge>
                      )}
                    </td>
                    <td><Link href={`/management/${tournament.slug}/draw/${competition.code}`}>进入</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

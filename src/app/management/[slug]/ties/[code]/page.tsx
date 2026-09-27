import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/db/client";
import { STANDING_BASIS_LABEL } from "@/domain/team/standings";
import { TIE_STATUS_LABEL } from "@/domain/team/tie";
import styles from "@/features/management/management.module.css";
import { ConfirmRankingPanel } from "@/features/management/tie-panels";
import { sideName } from "@/features/team/tie-views";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { loadScheduleConfig } from "@/server/services/schedule-facts";
import { loadCompetitionTies, loadGroupStandings, projectTie, type TieView } from "@/server/services/team-tie-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

const KIND_TITLE = { GROUP: "小组 / 循环对抗", KNOCKOUT: "淘汰赛", THIRD_PLACE: "三四名赛" } as const;

function lineupState(view: TieView) {
  if (view.revealedAt) return "已公开";
  const submitted = view.sides.filter((side) => side.lineup).length;
  return `已交 ${submitted}/2`;
}

export default async function TieCompetitionPage({ params }: { params: Promise<{ slug: string; code: string }> }) {
  const { slug, code } = await params;
  const { tournament, user } = await requireManagedTournamentPage(slug);
  const competition = await prisma.competition.findUnique({
    where: { tournamentId_code: { tournamentId: tournament.id, code: code.toUpperCase() } },
    select: { id: true, code: true, name: true, entryType: true, draws: { where: { status: "PUBLISHED" }, select: { id: true, format: true } } },
  });
  if (!competition || competition.entryType !== "TEAM") notFound();
  const draw = competition.draws[0];
  const chief = await prisma.roleAssignment.findFirst({
    where: { userId: user.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
    select: { id: true },
  });

  if (!draw) {
    return (
      <>
        <div className={styles.heading}>
          <p className="eyebrow"><Link href={`/management/${tournament.slug}/ties`}>团体对抗</Link></p>
          <h1>{competition.code} {competition.name}</h1>
        </div>
        <p className={styles.info}>该项目尚未发布抽签。<Link href={`/management/${tournament.slug}/draw/${competition.code}`}>去抽签编排</Link></p>
      </>
    );
  }

  const groups = await prisma.group.findMany({ where: { stage: { drawId: draw.id } }, orderBy: { code: "asc" }, select: { id: true } });
  const standings = await Promise.all(groups.map((group) => loadGroupStandings(prisma, group.id)));
  const config = await loadScheduleConfig(prisma, tournament.id);
  const views = (await loadCompetitionTies(prisma, competition.id)).map((fixture) => projectTie(fixture, { kind: "OFFICIAL" }, config));
  const byKind = (["GROUP", "KNOCKOUT", "THIRD_PLACE"] as const).map((kind) => ({ kind, items: views.filter((view) => view.kind === kind) }));
  const knockout = views.filter((view) => view.kind === "KNOCKOUT");
  const finalRound = knockout.reduce((max, view) => Math.max(max, view.round), 0);
  const final = knockout.find((view) => view.round === finalRound && finalRound > 0);
  const champion = final?.summary.winner ? sideName(final, final.summary.winner) : null;

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow"><Link href={`/management/${tournament.slug}/ties`}>团体对抗</Link></p>
        <h1>{competition.code} {competition.name}</h1>
        <p>小场结果以裁判长复核锁定为准；未锁定的小场不计入对抗胜负和积分榜。</p>
      </div>
      {champion ? <p className={styles.champion} data-testid="champion">冠军：{champion}</p> : null}

      {standings.map(({ group, standings: table, entries }) => {
        const names = Object.fromEntries(entries.map((entry) => [entry.id, entry.displayName]));
        const codes = Object.fromEntries(entries.map((entry) => [entry.id, entry.code]));
        const confirmed = group.rankingConfirmedAt ? (group.ranking as { order: string[]; reason: string | null }) : null;
        const rows = confirmed
          ? confirmed.order.map((entryId) => table.rows.find((row) => row.entryId === entryId)).filter((row) => row !== undefined)
          : table.rows;
        return (
          <section aria-labelledby={`standings-${group.code}`} className={styles.section} data-testid="standings" key={group.id}>
            <div className={styles.sectionTitle}>
              <h2 id={`standings-${group.code}`}>{draw.format === "ROUND_ROBIN" ? "积分榜" : `${group.code} 组积分榜`}</h2>
              <p>
                排名依据（项目默认，须组织者采纳）：对抗胜场 → 两队相同看相互胜负 → 三队及以上依次比小场差、局差、分差 → 仍相同须抽签。
              </p>
            </div>
            <div className={styles.regMeta}>
              {confirmed ? (
                <StatusBadge tone="ok">名次已由裁判长确认{group.rankingConfirmedBy ? `（${group.rankingConfirmedBy.name}）` : ""}</StatusBadge>
              ) : table.complete ? (
                <StatusBadge tone="warn">本组对抗全部结束，待裁判长确认名次</StatusBadge>
              ) : (
                <StatusBadge>本组对抗进行中</StatusBadge>
              )}
              {confirmed?.reason ? <span>抽签说明：{confirmed.reason}</span> : null}
            </div>
            <div className={styles.tableWrap}>
              <table className={`${styles.table} ${styles.tableWide}`}>
                <thead>
                  <tr><th>名次</th><th>队伍</th><th>场</th><th>胜</th><th>负</th><th>小场</th><th>局</th><th>分</th><th>依据</th></tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.entryId}>
                      <td>{confirmed ? index + 1 : row.position}</td>
                      <td>{names[row.entryId]}<div className={styles.muted}>{codes[row.entryId]}</div></td>
                      <td>{row.played}</td>
                      <td>{row.won}</td>
                      <td>{row.lost}</td>
                      <td>{row.rubbersWon}-{row.rubbersLost}</td>
                      <td>{row.gamesWon}-{row.gamesLost}</td>
                      <td>{row.pointsWon}-{row.pointsLost}</td>
                      <td>{confirmed && row.basis === "LOTS" ? "抽签" : STANDING_BASIS_LABEL[row.basis]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!confirmed && table.complete ? (
              chief ? (
                <ConfirmRankingPanel
                  competitionCode={competition.code}
                  groupCode={group.code}
                  lots={table.unresolved}
                  names={names}
                  order={table.rows.map((row) => row.entryId)}
                  slug={tournament.slug}
                  title={draw.format === "ROUND_ROBIN" ? "确认循环赛名次" : `确认 ${group.code} 组名次`}
                />
              ) : (
                <p className={styles.muted}>名次须由本赛事裁判长确认，确认后回填淘汰签位。</p>
              )
            ) : null}
          </section>
        );
      })}

      {byKind.filter((part) => part.items.length).map((part) => (
        <section aria-labelledby={`ties-${part.kind}`} className={styles.section} key={part.kind}>
          <div className={styles.sectionTitle}>
            <h2 id={`ties-${part.kind}`}>{KIND_TITLE[part.kind]}（{part.items.length} 场）</h2>
            <p>{part.kind === "GROUP" ? "五个小场打满。" : "决出胜负即止，未开始的小场记为未进行。"}</p>
          </div>
          <ul className={styles.tieList} data-testid={`ties-${part.kind}`}>
            {part.items.map((view) => (
              <li key={view.id}>
                <span className={styles.muted}>{view.code}</span>
                <span className={styles.tieVs}>
                  <strong>{sideName(view, "A")}</strong> 对 <strong>{sideName(view, "B")}</strong>
                  <br />
                  <span className={styles.muted}>{view.label} · 名单{lineupState(view)} · {TIE_STATUS_LABEL[view.summary.status]}</span>
                </span>
                <span className={styles.actions}>
                  {view.summary.status !== "NOT_STARTED" ? (
                    <span className={styles.tieScoreSmall}>{view.summary.rubbers.A}:{view.summary.rubbers.B}</span>
                  ) : null}
                  <Link className="button small" href={`/management/${tournament.slug}/ties/${competition.code}/${view.code}`}>详情</Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

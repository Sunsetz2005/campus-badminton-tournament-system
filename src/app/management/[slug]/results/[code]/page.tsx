import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/db/client";
import { formatScoreline, OUTCOME_LABEL, RESULT_STAGE_LABEL, type ResultStage } from "@/domain/results/match-result";
import { CAMPUS_DEMO_RANKING, describeStep, RANKING_BASIS_LABEL, RANKING_STATUS_LABEL, type RankingStatus } from "@/domain/results/ranking";
import styles from "@/features/management/management.module.css";
import { ConfirmRankingPanel } from "@/features/management/tie-panels";
import { CorrectionPanel, ExclusionPanel, PublishStandingsPanel, RecordResultForm, ReviewResultPanel } from "@/features/results/result-panels";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { loadCompetitionResults, RESULTS_VIEW_ROLES } from "@/server/services/results-service";
import { StatusBadge, type StatusTone } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

const STAGE_TONE: Record<ResultStage, StatusTone> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "info",
  PENDING_SUBMISSION: "warn",
  PENDING_REVIEW: "warn",
  CONFIRMED: "ok",
};

const RANKING_TONE: Record<RankingStatus, StatusTone> = {
  READY: "ok",
  PROVISIONAL: "warn",
  NEEDS_DECISION: "warn",
  BLOCKED: "danger",
};

const KIND_TITLE = { GROUP: "小组", KNOCKOUT: "淘汰赛", THIRD_PLACE: "三四名赛" } as const;

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value);
}

export default async function CompetitionResultsPage({ params }: { params: Promise<{ slug: string; code: string }> }) {
  const { slug, code } = await params;
  const { tournament, user } = await requireManagedTournamentPage(slug, RESULTS_VIEW_ROLES);
  const loaded = await loadCompetitionResults(prisma, tournament.id, code);
  if (!loaded) notFound();
  const { competition, draw, results } = loaded;
  const roles = new Set(
    (await prisma.roleAssignment.findMany({ where: { userId: user.id, tournamentId: tournament.id }, select: { role: true } })).map((item) => item.role),
  );
  const chief = roles.has("CHIEF_REFEREE");
  const canRecord = roles.has("ADMIN") || roles.has("ORGANIZER");
  const canPublish = roles.has("ADMIN") || chief;

  const heading = (
    <div className={styles.heading}>
      <p className="eyebrow"><Link href={`/management/${tournament.slug}/results`}>成绩名次</Link></p>
      <h1>{competition.code} {competition.name}</h1>
    </div>
  );
  if (competition.entryType === "TEAM") {
    return (
      <>
        {heading}
        <p className={styles.info}>团体项目的积分榜、名次确认与淘汰回填在「团体对抗」页面。<Link href={`/management/${tournament.slug}/ties/${competition.code}`}>前往团体对抗</Link></p>
      </>
    );
  }
  if (!draw || !results) {
    return (
      <>
        {heading}
        <p className={styles.info}>该项目尚未发布抽签，没有比赛结果。</p>
      </>
    );
  }

  const names = new Map<string, string>();
  for (const match of results.matches) for (const side of match.sides) if (side.entry) names.set(side.entry.id, `${side.entry.name}（${side.entry.code}）`);
  for (const group of results.groups) for (const entry of group.entries) names.set(entry.id, `${entry.displayName}（${entry.code}）`);
  const nameOf = (entryId: string) => names.get(entryId) ?? entryId;
  const latest = results.publications[0] ?? null;
  const publishBlock = !results.publishable
    ? "还没有已确认的小组名次或已决出的名次。"
    : latest && !results.needsRepublish
      ? `内容与第 ${latest.version} 版相同，无需重新发布。`
      : null;

  return (
    <>
      {heading}
      <div className={styles.info} data-testid="ranking-profile">
        <strong>名次规则：{CAMPUS_DEMO_RANKING.name}（v{CAMPUS_DEMO_RANKING.version}）</strong>——{CAMPUS_DEMO_RANKING.notice}
        <details>
          <summary>查看比较顺序</summary>
          <ol>{CAMPUS_DEMO_RANKING.rules.map((rule) => <li key={rule}>{rule}</li>)}</ol>
        </details>
      </div>

      <section aria-labelledby="placements-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="placements-title">最终名次</h2>
          <p>只列赛制真正决出的名次；未进行名次赛时记并列，不跨组、跨场硬排。</p>
        </div>
        <div className={styles.regMeta}>
          {results.placementsComplete ? <StatusBadge tone="ok">全部名次已产生</StatusBadge> : <StatusBadge tone="warn">名次尚未全部产生</StatusBadge>}
          {results.needsRepublish ? <StatusBadge tone="warn">成绩已变化，榜单需重新发布</StatusBadge> : null}
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="placements">
            <thead><tr><th>名次</th><th>报名单位</th></tr></thead>
            <tbody>
              {results.placements.map((item) => (
                <tr key={item.entryId}>
                  <td>{item.label}</td>
                  <td>{item.name}<div className={styles.muted}>{item.code}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="publish-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="publish-title">名次榜单发布</h2>
          <p>发布内容只含已确认的小组名次与已决出的名次；更正后须重新发布，历史版本全部保留。</p>
        </div>
        {latest ? (
          <ul className={styles.chips}>
            {results.publications.map((item) => (
              <li key={item.version}>
                第 {item.version} 版 · {new Date(item.publishedAt).toLocaleString("zh-CN", { timeZone: tournament.timezone })}
                {item.publishedBy ? ` · ${item.publishedBy}` : ""}
                {item.note ? ` · ${item.note}` : ""}
                {item.version === latest.version ? (results.needsRepublish ? " · 已被成绩变化替代" : " · 当前") : " · 历史"}
              </li>
            ))}
          </ul>
        ) : <p className={styles.muted}>尚未发布过榜单。</p>}
        {canPublish ? (
          <PublishStandingsPanel competitionCode={competition.code} disabledReason={publishBlock} slug={tournament.slug} />
        ) : <p className={styles.muted}>榜单由赛事管理员或裁判长发布。</p>}
      </section>

      {results.groups.map(({ group, ranking, confirmed, entries }) => {
        const blockerEntries = new Set(ranking.blockers.flatMap((item) => item.entryIds));
        const excludedIds = new Set(ranking.excluded.map((item) => item.entryId));
        const rows = confirmed
          ? confirmed.order.map((entryId) => ranking.rows.find((row) => row.entryId === entryId)).filter((row) => row !== undefined)
          : ranking.rows;
        const title = draw.format === "ROUND_ROBIN" ? "循环赛名次" : `${group.code} 组名次`;
        return (
          <section aria-labelledby={`group-${group.code}`} className={styles.section} data-testid={`group-${group.code}`} key={group.id}>
            <div className={styles.sectionTitle}>
              <h2 id={`group-${group.code}`}>{title}</h2>
              <p>计入 {ranking.countedMatchCodes.length} 场正式确认的比赛</p>
            </div>
            <div className={styles.regMeta}>
              {confirmed ? (
                <StatusBadge tone="ok">名次已由裁判长确认{group.rankingConfirmedBy ? `（${group.rankingConfirmedBy.name}）` : ""}</StatusBadge>
              ) : (
                <StatusBadge tone={RANKING_TONE[ranking.status]}>{ranking.status === "READY" ? "待裁判长确认" : RANKING_STATUS_LABEL[ranking.status]}</StatusBadge>
              )}
              {!confirmed && ranking.status !== "READY" ? <strong>以下为暂定名次，不是正式结果</strong> : null}
              {confirmed?.reason ? <span>抽签/裁定依据：{confirmed.reason}</span> : null}
            </div>
            {ranking.blockers.length ? (
              <div className={styles.alert}>
                有特殊结果尚未处理，不能产生正式名次：
                <ul>
                  {ranking.blockers.map((item) => (
                    <li key={item.matchCode}>{item.matchCode}：{OUTCOME_LABEL[item.outcome as keyof typeof OUTCOME_LABEL] ?? item.outcome}（{item.entryIds.map(nameOf).join(" 对 ")}）</li>
                  ))}
                </ul>
                裁判长可决定排除不能完成本组比赛的单位（其全部对阵贡献不计）。
              </div>
            ) : null}
            {ranking.pendingMatchCodes.length ? (
              <p className={styles.muted}>尚未正式确认、暂不计入：{ranking.pendingMatchCodes.join("、")}</p>
            ) : null}
            <div className={styles.tableWrap}>
              <table className={`${styles.table} ${styles.tableWide}`}>
                <thead>
                  <tr><th>名次</th><th>报名单位</th><th>场</th><th>胜</th><th>负</th><th>局</th><th>分</th><th>净胜局</th><th>净胜分</th><th>依据</th></tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={row.entryId}>
                      <td>{confirmed ? index + 1 : row.position}</td>
                      <td>
                        {nameOf(row.entryId)}
                        <details>
                          <summary>为什么排在这里</summary>
                          <ol className={styles.rowMessages}>
                            {row.steps.map((step, at) => <li key={at}>{describeStep(step, nameOf)}</li>)}
                          </ol>
                        </details>
                      </td>
                      <td>{row.played}</td>
                      <td>{row.won}</td>
                      <td>{row.lost}</td>
                      <td>{row.gamesWon}-{row.gamesLost}</td>
                      <td>{row.pointsWon}-{row.pointsLost}</td>
                      <td>{signed(row.netGames)}</td>
                      <td>{signed(row.netPoints)}</td>
                      <td>{confirmed && row.basis === "UNRESOLVED" ? "抽签/裁定" : RANKING_BASIS_LABEL[row.basis]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {chief && !confirmed && (ranking.blockers.length || ranking.excluded.length) ? (
              <ExclusionPanel
                candidates={entries.filter((entry) => blockerEntries.has(entry.id) && !excludedIds.has(entry.id)).map((entry) => ({ id: entry.id, name: nameOf(entry.id) }))}
                competitionCode={competition.code}
                excluded={ranking.excluded.map((item) => ({ ...item, name: nameOf(item.entryId) }))}
                groupCode={group.code}
                slug={tournament.slug}
              />
            ) : ranking.excluded.length ? (
              <p className={styles.muted}>已排除：{ranking.excluded.map((item) => `${nameOf(item.entryId)}（${item.reason}）`).join("；")}</p>
            ) : null}
            {!confirmed && (ranking.status === "READY" || ranking.status === "NEEDS_DECISION") ? (
              chief ? (
                <ConfirmRankingPanel
                  competitionCode={competition.code}
                  groupCode={group.code}
                  lots={ranking.unresolved}
                  names={Object.fromEntries(entries.map((entry) => [entry.id, nameOf(entry.id)]))}
                  order={ranking.rows.map((row) => row.entryId)}
                  slug={tournament.slug}
                  title={`确认${title}`}
                />
              ) : <p className={styles.muted}>名次须由本赛事裁判长确认，确认后回填淘汰签位。</p>
            ) : null}
          </section>
        );
      })}

      <section aria-labelledby="matches-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="matches-title">比赛结果（{results.matches.length} 场）</h2>
          <p>「裁判台」结果关联逐分记分事件；「仅结果」是补录的逐局结果，没有回合过程。</p>
        </div>
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.tableWide}`} data-testid="result-matches">
            <thead><tr><th>对阵</th><th>双方</th><th>状态</th><th>比分</th><th>操作</th></tr></thead>
            <tbody>
              {results.matches.map((match) => {
                const [a, b] = match.sides;
                const sideNames = { A: a.entry?.name ?? a.pending ?? "待定", B: b.entry?.name ?? b.pending ?? "待定" };
                const winnerName = match.fact.winner ? sideNames[match.fact.winner] : null;
                const ready = Boolean(a.entry && b.entry);
                const revision = match.latestRevision;
                return (
                  <tr data-testid={`match-${match.fixtureCode}`} key={match.fixtureId}>
                    <td>
                      <strong>{match.fixtureCode}</strong>
                      <div className={styles.muted}>{match.groupCode ? `${match.groupCode} 组` : KIND_TITLE[match.kind]} · {match.label}</div>
                    </td>
                    <td>{sideNames.A} 对 {sideNames.B}</td>
                    <td>
                      <StatusBadge tone={STAGE_TONE[match.fact.stage]}>{RESULT_STAGE_LABEL[match.fact.stage]}</StatusBadge>
                      <div className={styles.muted}>
                        {match.fact.stage === "NOT_STARTED" ? "" : match.fact.source === "RESULT_ONLY" ? "仅结果" : "裁判台"}
                        {match.fact.outcome && match.fact.outcome !== "NORMAL" ? ` · ${OUTCOME_LABEL[match.fact.outcome]}` : ""}
                      </div>
                    </td>
                    <td>
                      {formatScoreline(match.fact) || "—"}
                      {winnerName ? <div className={styles.muted}>胜方：{winnerName}</div> : null}
                    </td>
                    <td>
                      {canRecord && ready && match.fact.stage === "NOT_STARTED" && !match.started ? (
                        <RecordResultForm bestOf={match.bestOf} matchCode={match.matchCode as string} sideNames={sideNames} slug={tournament.slug} />
                      ) : null}
                      {match.fact.source === "RESULT_ONLY" && match.fact.stage === "PENDING_REVIEW" && revision ? (
                        chief ? (
                          revision.submittedByUserId === user.id ? (
                            <p className={styles.hint}>由你补录，须另一位裁判长复核。</p>
                          ) : (
                            <>
                              <p className={styles.hint}>补录依据：{revision.reason}</p>
                              <ReviewResultPanel matchCode={match.matchCode as string} revision={revision.revision} slug={tournament.slug} />
                            </>
                          )
                        ) : <p className={styles.hint}>待裁判长复核</p>
                      ) : null}
                      {match.fact.source === "LIVE" && match.fact.stage === "PENDING_REVIEW" ? <p className={styles.hint}>在裁判台由裁判长复核锁定</p> : null}
                      {chief && match.fact.stage === "CONFIRMED" && match.matchCode ? (
                        <CorrectionPanel matchCode={match.matchCode} revision={revision?.revision ?? null} slug={tournament.slug} source={match.fact.source} />
                      ) : null}
                      {match.dispositions.map((item) => (
                        <p className={styles.hint} key={item.decidedAt}>
                          人工处置（{item.decision === "MAINTAIN" ? "维持原结果" : "线下裁决"}）：{item.reason}{item.decidedBy ? ` · ${item.decidedBy}` : ""}
                        </p>
                      ))}
                    </td>
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

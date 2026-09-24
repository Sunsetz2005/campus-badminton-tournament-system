import Link from "next/link";

import { ResourceState } from "@/components/ui/resource-state";

import { formatPreviewDateTime, formatPreviewSyncTime, formatPreviewTime } from "./format";
import {
  correctionLabels,
  outcomeLabels,
  type PreviewScenario,
  type PublicMatchPreview,
  type PublicTournamentPreview,
} from "./model";
import { EntryIdentity, MatchScore, PublicResultsShell, StatusCluster } from "./public-components";
import styles from "./public-results.module.css";
import { PublicMatchSkeleton } from "./resource-states";

export interface MatchDetailViewProps {
  /** 赛事公开根路径，例如 `/public/autumn-campus-2026`。 */
  basePath: string;
  match: PublicMatchPreview;
  mode: "preview" | "live";
  preservedQuery: string;
  scenario: PreviewScenario;
  tournament: PublicTournamentPreview;
}

export function MatchDetailView({
  basePath,
  match,
  mode,
  preservedQuery,
  scenario,
  tournament,
}: MatchDetailViewProps) {
  const timeZone = tournament.timezone;
  const scheduleHref = `${basePath}/schedule${preservedQuery ? `?${preservedQuery}` : ""}`;
  const retryQuery = new URLSearchParams(preservedQuery);
  retryQuery.delete("scenario");
  const retryHref = `${basePath}/matches/${match.code}${retryQuery.size ? `?${retryQuery}` : ""}`;
  const sideAName = match.sideA?.displayName ?? "对阵待定";
  const sideBName = match.sideB?.displayName ?? "对阵待定";
  const time = formatPreviewTime(match.time, timeZone);

  return (
    <PublicResultsShell activeSection="match" mode={mode} tournament={tournament}>
      <div className={styles.detailToolbar}>
        <Link className={styles.backLink} href={scheduleHref}>← 返回每日赛程</Link>
        {scenario === "ready" || scenario === "stale" ? <span>最后同步 {formatPreviewSyncTime(match.lastSyncedAt, timeZone)}</span> : null}
      </div>

      {scenario === "loading" ? <PublicMatchSkeleton /> : null}
      {scenario === "error" ? (
        <ResourceState
          action={<Link className={styles.primaryLink} href={retryHref}>重新读取比赛详情</Link>}
          description="详情请求失败不会被显示成比赛不存在，也不会清空最后已确认比分。"
          eyebrow="连接中断"
          title="暂时无法读取比赛详情"
          tone="error"
        />
      ) : null}

      {scenario !== "loading" && scenario !== "error" ? (
        <>
          {scenario === "stale" ? (
            <p className={styles.syncNotice} role="status">连接中断 · 数据可能过期；当前仍显示最后一次成功同步的版本 {match.projectionRevision}。</p>
          ) : null}
          <article className={styles.detailGrid}>
            <div className={styles.detailMain}>
              <header className={styles.matchHero}>
                <div>
                  <p>{match.code} · {match.competitionName} · {match.stageName}</p>
                  <div className={styles.heroSides}>
                    <EntryIdentity entry={match.sideA} side="A" />
                    <strong aria-label={match.gamesWon ? `总局分 ${match.gamesWon.A} 比 ${match.gamesWon.B}` : "总局分尚未产生"} className={styles.heroScore}>
                      {match.gamesWon ? `${match.gamesWon.A}–${match.gamesWon.B}` : "—"}
                    </strong>
                    <EntryIdentity entry={match.sideB} side="B" />
                  </div>
                </div>
              </header>

              <section aria-labelledby="game-score-title" className={styles.detailSection}>
                <div className={styles.sectionTitle}><span /><h2 id="game-score-title">逐局比分</h2></div>
                <MatchScore
                  density="detail"
                  games={match.games}
                  gamesWon={match.gamesWon}
                  sideAName={sideAName}
                  sideBName={sideBName}
                  winnerSide={match.winnerSide}
                />
              </section>

              <section aria-labelledby="public-note-title" className={styles.detailSection}>
                <div className={styles.sectionTitle}><span /><h2 id="public-note-title">公开说明</h2></div>
                <p>{match.publicCorrectionNote ?? "当前没有公开更正记录。内部审计日志、联系方式和伤病原因不会在此展示。"}</p>
              </section>
            </div>

            <aside aria-label="比赛状态与信息" className={styles.detailAside}>
              <section>
                <h2>状态</h2>
                <StatusCluster match={match} />
              </section>
              <section>
                <h2>比赛信息</h2>
                <dl className={styles.detailFacts}>
                  <div><dt>比赛编号</dt><dd>{match.code}</dd></div>
                  <div><dt>项目</dt><dd>{match.competitionName}</dd></div>
                  <div><dt>阶段</dt><dd>{match.stageName}</dd></div>
                  <div><dt>场地</dt><dd>{match.court ?? "场地待定"}</dd></div>
                  <div><dt>时间</dt><dd>{time.primary}<small>{time.secondary}</small></dd></div>
                  <div><dt>实际开始</dt><dd>{formatPreviewDateTime(match.startedAt, timeZone)}</dd></div>
                  <div><dt>实际结束</dt><dd>{formatPreviewDateTime(match.endedAt, timeZone)}</dd></div>
                  <div><dt>比分版本</dt><dd>{match.scoreVersion}</dd></div>
                  {/* projectionRevision 是给客户端比较新旧用的单调修订号，不是给读者看的数字。 */}
                  <div><dt>数据更新时间</dt><dd>{formatPreviewDateTime(match.lastSyncedAt, timeZone)}</dd></div>
                </dl>
              </section>
              <section>
                <h2>规则摘要</h2>
                <p>{match.ruleSummary}</p>
              </section>
              <section>
                <h2>结果与更正</h2>
                <dl className={styles.detailFacts}>
                  <div><dt>特殊结果</dt><dd>{outcomeLabels[match.outcome]}</dd></div>
                  <div><dt>公开更正</dt><dd>{correctionLabels[match.correctionState]}</dd></div>
                </dl>
              </section>
            </aside>
          </article>
        </>
      ) : null}
    </PublicResultsShell>
  );
}

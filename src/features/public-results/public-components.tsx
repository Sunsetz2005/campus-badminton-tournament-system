import Link from "next/link";
import type { ReactNode } from "react";

import { StatusBadge, type StatusTone } from "@/ui/status-badge";

import { formatPreviewTime } from "./format";
import {
  correctionLabels,
  lifecycleLabels,
  outcomeLabels,
  verificationLabels,
  type PublicEntry,
  type PublicGameScore,
  type PublicMatchPreview,
  type PublicTournamentPreview,
} from "./model";
import styles from "./public-results.module.css";

export interface PublicResultsShellProps {
  activeSection: "schedule" | "match";
  children: ReactNode;
  /** `preview` 显示隔离夹具横幅；`live` 读取真实公开投影。 */
  mode: "preview" | "live";
  tournament: PublicTournamentPreview;
}

export function PublicResultsShell({ activeSection, children, mode, tournament }: PublicResultsShellProps) {
  return (
    <section
      className={`${styles.shell} ${activeSection === "schedule" ? styles.scheduleShell : ""}`}
      data-public-preview={mode === "preview" ? "true" : undefined}
    >
      {mode === "preview" ? (
        <div className={styles.previewBanner} role="status">
          <strong>模拟数据 · 界面预览</strong>
          <span>不读取认证、数据库、正式公开接口或真实学生资料</span>
        </div>
      ) : null}
      <header className={styles.eventHeader}>
        <div>
          <p className={styles.kicker}>{activeSection === "schedule" ? "公开赛程与成绩中心" : "公开比赛详情"}</p>
          <h1>{activeSection === "schedule" ? "每日赛程" : "比赛详情"}</h1>
        </div>
        <dl className={styles.eventFacts}>
          <div><dt>赛事</dt><dd>{tournament.name}</dd></div>
          {tournament.venue ? <div><dt>场馆</dt><dd>{tournament.venue}</dd></div> : null}
          <div><dt>赛事时区</dt><dd>{tournament.timezone}</dd></div>
        </dl>
      </header>
      {tournament.announcement ? <p className={styles.announcement}>{tournament.announcement}</p> : null}
      {children}
    </section>
  );
}

export interface EntryIdentityProps {
  entry: PublicEntry | null;
  side: "A" | "B";
}

export function EntryIdentity({ entry, side }: EntryIdentityProps) {
  if (!entry) {
    return <div className={styles.entryIdentity}><span>{side} 方</span><strong>对阵待定</strong><small>成员未确定</small></div>;
  }
  const membersLabel = entry.members.map((member) => member.displayName).join("／");
  return (
    <div className={styles.entryIdentity}>
      <span>{entry.teamName ? `${side} 方 · ${entry.teamName}` : `${side} 方`}</span>
      <strong>{entry.displayName}</strong>
      {membersLabel !== entry.displayName ? <small>成员：{membersLabel}</small> : null}
    </div>
  );
}

export interface MatchScoreProps {
  density?: "summary" | "detail";
  emptyLabel?: string;
  games: readonly PublicGameScore[];
  gamesWon: PublicMatchPreview["gamesWon"];
  outcomeLabel?: string;
  sideAName: string;
  sideBName: string;
  winnerSide: PublicMatchPreview["winnerSide"];
}

export function MatchScore({
  density = "summary",
  emptyLabel = "未开始",
  games,
  gamesWon,
  outcomeLabel,
  sideAName,
  sideBName,
  winnerSide,
}: MatchScoreProps) {
  if (density === "summary") {
    const playedGames = games.filter((game) => game.scoreA !== null && game.scoreB !== null);
    if (!playedGames.length) {
      return (
        <div aria-label="逐局比分" className={`${styles.scoreSummary} ${styles.scoreSummaryEmpty}`}>
          {outcomeLabel ?? emptyLabel}
        </div>
      );
    }

    return (
      <div aria-label="逐局比分" className={styles.scoreSummary}>
        <strong className={styles.gamesWon}>
          {gamesWon ? `${gamesWon.A}–${gamesWon.B}` : "—"}
          <span className={styles.srOnly}>总局分</span>
        </strong>
        <div className={styles.gameCells}>
          {playedGames.map((game) => (
            <span data-game-status={game.status} key={game.number}>
              {game.scoreA}:{game.scoreB}
              {game.status === "IN_PROGRESS" ? <span className={styles.srOnly}>，当前局</span> : null}
              {game.status === "STOPPED" ? <span className={styles.srOnly}>，本局已停止</span> : null}
            </span>
          ))}
        </div>
        {outcomeLabel ? <span className={styles.scoreOutcome}>{outcomeLabel}</span> : null}
      </div>
    );
  }

  return (
    <div className={styles.scoreTableWrap}>
      <span className={styles.tableScrollHint}>逐局表格可横向滚动</span>
      <table className={styles.scoreTable}>
        <caption>逐局比分；未进行的局不会补造比分</caption>
        <thead>
          <tr>
            <th scope="col">对阵方</th>
            {games.map((game) => (
              <th aria-current={game.status === "IN_PROGRESS" || undefined} key={game.number} scope="col">
                第{game.number}局
                {game.status === "IN_PROGRESS" ? <span className={styles.currentGameLabel}>当前局</span> : null}
                {game.status === "STOPPED" ? <span className={styles.stoppedGameLabel}>本局停止</span> : null}
              </th>
            ))}
            <th scope="col">总局分</th>
          </tr>
        </thead>
        <tbody>
          {(["A", "B"] as const).map((side) => (
            <tr data-winner={winnerSide === side || undefined} key={side}>
              <th scope="row">
                {side === "A" ? sideAName : sideBName}
                {winnerSide === side ? <span className={styles.winnerLabel}>胜方</span> : null}
              </th>
              {games.map((game) => {
                const score = side === "A" ? game.scoreA : game.scoreB;
                return <td key={game.number}>{score ?? <span className={styles.unplayed}>未进行</span>}</td>;
              })}
              <td><strong>{gamesWon ? gamesWon[side] : "—"}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function lifecycleTone(value: PublicMatchPreview["lifecycle"]): StatusTone {
  if (value === "IN_PROGRESS") return "info";
  if (value === "SUSPENDED" || value === "ENDED_PENDING_SUBMISSION") return "warn";
  if (value === "SUBMITTED") return "ok";
  return "neutral";
}

function verificationTone(value: PublicMatchPreview["verification"]): StatusTone {
  if (value === "LOCKED") return "ok";
  if (value === "PENDING_REVIEW") return "warn";
  if (value === "DISPUTED") return "danger";
  if (value === "SUPERSEDED") return "neutral";
  return "neutral";
}

export interface StatusClusterProps {
  compact?: boolean;
  showLifecycle?: boolean;
  match: Pick<PublicMatchPreview, "correctionState" | "lifecycle" | "outcome" | "verification">;
}

export function StatusCluster({ compact = false, match, showLifecycle = true }: StatusClusterProps) {
  const abnormalOutcome = match.outcome !== "NORMAL";
  const verificationLabel = compact && match.correctionState !== "NONE"
    ? `${verificationLabels[match.verification]} · ${correctionLabels[match.correctionState]}`
    : verificationLabels[match.verification];

  return (
    <div className={`${styles.statusCluster} ${compact ? styles.statusClusterCompact : ""}`}>
      {showLifecycle ? (
        <div><span>比赛进度</span><StatusBadge tone={lifecycleTone(match.lifecycle)}>{lifecycleLabels[match.lifecycle]}</StatusBadge></div>
      ) : null}
      <div><span>结果确认</span><StatusBadge tone={verificationTone(match.verification)}>{verificationLabel}</StatusBadge></div>
      {!compact && abnormalOutcome ? <div><span>特殊结果</span><StatusBadge tone="danger">{outcomeLabels[match.outcome]}</StatusBadge></div> : null}
      {!compact && match.correctionState !== "NONE" ? (
        <div><span>更正状态</span><StatusBadge tone={match.correctionState === "UNDER_REVIEW" ? "warn" : "info"}>{correctionLabels[match.correctionState]}</StatusBadge></div>
      ) : null}
    </div>
  );
}

function ScheduleSideScore({ match, side }: { match: PublicMatchPreview; side: "A" | "B" }) {
  const entry = side === "A" ? match.sideA : match.sideB;
  const gamesWon = match.gamesWon?.[side] ?? "—";

  return (
    <div className={styles.cardScoreRow} data-winner={match.winnerSide === side || undefined}>
      <EntryIdentity entry={entry} side={side} />
      <strong className={styles.cardGamesWon}>
        <span className={styles.srOnly}>{side} 方总局分</span>
        {gamesWon}
      </strong>
      <div aria-label={`${side} 方逐局比分`} className={styles.cardGameScores}>
        {match.games.map((game) => {
          const score = side === "A" ? game.scoreA : game.scoreB;
          const gameState = game.status === "IN_PROGRESS"
            ? "，当前局"
            : game.status === "STOPPED" ? "，本局已停止" : "";
          return (
            <span data-game-status={game.status} key={game.number}>
              <span className={styles.srOnly}>第 {game.number} 局{gameState}：</span>
              {score ?? "—"}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export interface ScheduleMatchProps {
  detailHref: string;
  match: PublicMatchPreview;
  presentation: "table-row" | "card";
  /** 赛事时区；时间一律按它渲染，不按访问设备时区。 */
  timeZone?: string;
}

export function ScheduleMatch({ detailHref, match, presentation, timeZone }: ScheduleMatchProps) {
  const time = formatPreviewTime(match.time, timeZone);
  const sideAName = match.sideA?.displayName ?? "对阵待定";
  const sideBName = match.sideB?.displayName ?? "对阵待定";

  if (presentation === "table-row") {
    return (
      <tr>
        <td><strong className={styles.timePrimary}>{time.primary}</strong><small>{time.secondary}</small></td>
        <td>{match.court ?? "场地待定"}</td>
        <td><strong>{match.code}</strong><small>{match.competitionName} · {match.stageName}</small></td>
        <td><div className={styles.tableEntries}><EntryIdentity entry={match.sideA} side="A" /><span aria-hidden="true">对</span><EntryIdentity entry={match.sideB} side="B" /></div></td>
        <td>
          <MatchScore
            games={match.games}
            gamesWon={match.gamesWon}
            outcomeLabel={match.outcome === "NORMAL" ? undefined : outcomeLabels[match.outcome]}
            sideAName={sideAName}
            sideBName={sideBName}
            winnerSide={match.winnerSide}
          />
        </td>
        <td><StatusCluster compact match={match} /></td>
        <td><Link aria-label={`查看 ${match.code} 比赛详情`} className={styles.detailLink} href={detailHref}>详情</Link></td>
      </tr>
    );
  }

  return (
    <article aria-labelledby={`match-${match.code}`} className={styles.matchCard}>
      <header className={styles.cardHeading}>
        <div className={styles.cardTime}>
          <div><strong className={styles.timePrimary}>{time.primary}</strong><span>{match.court ?? "场地待定"}</span></div>
          {time.secondary === "计划时间" ? null : <small>{time.secondary}</small>}
        </div>
        <div className={styles.cardHeadingActions}>
          <StatusCluster compact match={match} />
          <Link aria-label={`查看 ${match.code} 比赛详情`} className={`${styles.detailLink} ${styles.cardDetailLink}`} href={detailHref}>
            <span className={styles.srOnly}>详情</span><span aria-hidden="true">›</span>
          </Link>
        </div>
      </header>
      <p className={styles.cardMeta} id={`match-${match.code}`}>
        <strong>{match.code}</strong>
        <span>{match.competitionName} · {match.stageName}</span>
        {match.outcome === "NORMAL" ? null : <span className={styles.cardOutcome}>{outcomeLabels[match.outcome]}</span>}
      </p>
      <div aria-label="对阵双方与逐局比分" className={styles.cardScoreboard}>
        <div aria-hidden="true" className={styles.cardScoreLegend}>
          <span>对阵</span><span>局分</span><span>逐局比分</span>
        </div>
        <ScheduleSideScore match={match} side="A" />
        <ScheduleSideScore match={match} side="B" />
      </div>
    </article>
  );
}

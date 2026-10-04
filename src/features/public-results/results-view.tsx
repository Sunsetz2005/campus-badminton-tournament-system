import Link from "next/link";

import { RANKING_STATUS_TEXT, sideLabel, type ReportCompetition, type ReportMatch, type ReportSnapshot } from "@/reports/report-model";
import { StatusBadge } from "@/ui/status-badge";

import styles from "./results-view.module.css";

function MatchRow({ match, basePath }: { match: ReportMatch; basePath: string }) {
  return (
    <tr>
      <th scope="row">
        <Link href={`${basePath}/matches/${match.code}`}>{match.code}</Link>
        <small>{[match.group ? `${match.group} 组` : "", match.round ?? "", match.rubber ?? ""].filter(Boolean).join(" · ") || match.stage}</small>
      </th>
      <td data-winner={match.winner === "A" || undefined}>{sideLabel(match.sideA)}</td>
      <td data-winner={match.winner === "B" || undefined}>{sideLabel(match.sideB)}</td>
      <td className={styles.score}>{match.scoreline || "—"}</td>
      <td>
        {match.confirmed ? (
          <StatusBadge tone="ok">已确认{match.outcomeLabel && match.outcome !== "NORMAL" ? ` · ${match.outcomeLabel}` : ""}</StatusBadge>
        ) : match.resultStage === "NOT_STARTED" ? (
          <StatusBadge tone="neutral">未开始</StatusBadge>
        ) : (
          <StatusBadge tone="warn">{match.resultStage === "IN_PROGRESS" ? "进行中" : "暂定 · 待确认"}</StatusBadge>
        )}
      </td>
    </tr>
  );
}
function CompetitionResults({ competition, matches, basePath }: { competition: ReportCompetition; matches: ReportMatch[]; basePath: string }) {
  const titleId = `competition-${competition.code}`;
  return (
    <section aria-labelledby={titleId} className={styles.competition}>
      <header className={styles.competitionHeader}>
        <h2 id={titleId}>{competition.name}</h2>
        <p>
          {competition.format ?? "赛制待定"} · {competition.entries.length} 个报名单位
          {competition.standingsVersion ? ` · 名次榜单第 ${competition.standingsVersion} 版` : ""}
        </p>
        {competition.standingsStale ? (
          <p className={styles.stale} role="note">
            名次更正处理中：以下为最后一次发布的榜单，更正后的名次待裁判长重新发布。
          </p>
        ) : null}
      </header>

      <div className={styles.block}>
        <h3>最终名次</h3>
        {competition.placements.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>{competition.name}最终名次</caption>
              <thead>
                <tr>
                  <th scope="col">名次</th>
                  <th scope="col">报名单位</th>
                  <th scope="col">说明</th>
                </tr>
              </thead>
              <tbody>
                {competition.placements.map((placement) => (
                  <tr key={`${placement.code}-${placement.label}`}>
                    <td className={styles.place}>{placement.place ?? "—"}</td>
                    <td>{placement.name === placement.code ? placement.code : `${placement.code} ${placement.name}`}</td>
                    <td>{placement.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>{competition.placementsNote || "名次尚未产生。"}</p>
        )}
      </div>

      {competition.rankings.length ? (
        <div className={styles.block}>
          <h3>小组名次</h3>
          <div className={styles.groups}>
            {competition.rankings.map((ranking) => (
              <div className={styles.group} key={ranking.group}>
                <h4>
                  {ranking.group} 组 <small>{RANKING_STATUS_TEXT[ranking.status]}</small>
                </h4>
                <ol>
                  {ranking.rows.map((row) => (
                    <li key={row.code}>
                      <span className={styles.place}>{row.position ?? "—"}</span>
                      <span>{row.name === row.code ? row.code : `${row.code} ${row.name}`}</span>
                    </li>
                  ))}
                </ol>
                {ranking.note ? <p className={styles.note}>{ranking.note}</p> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {competition.team && competition.ties.length ? (
        <div className={styles.block}>
          <h3>团体对抗</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>{competition.name}团体对抗</caption>
              <thead>
                <tr>
                  <th scope="col">对阵</th>
                  <th scope="col">A 方</th>
                  <th scope="col">B 方</th>
                  <th scope="col">小场（已确认）</th>
                  <th scope="col">胜方</th>
                </tr>
              </thead>
              <tbody>
                {competition.ties.map((tie) => (
                  <tr key={tie.code}>
                    <th scope="row">
                      {tie.code}
                      <small>{[tie.group ? `${tie.group} 组` : "", tie.round].filter(Boolean).join(" · ")}</small>
                    </th>
                    <td data-winner={tie.winner === "A" || undefined}>{sideLabel(tie.sideA)}</td>
                    <td data-winner={tie.winner === "B" || undefined}>{sideLabel(tie.sideB)}</td>
                    <td className={styles.score}>{tie.rubbersWon}</td>
                    <td>{tie.winner ? sideLabel(tie.winner === "A" ? tie.sideA : tie.sideB) : "未决出"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className={styles.block}>
        <h3>{competition.team ? "小场结果" : "对阵与结果"}</h3>
        {matches.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>{competition.name}对阵与结果</caption>
              <thead>
                <tr>
                  <th scope="col">比赛</th>
                  <th scope="col">A 方</th>
                  <th scope="col">B 方</th>
                  <th scope="col">逐局比分（A:B）</th>
                  <th scope="col">状态</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match) => (
                  <MatchRow basePath={basePath} key={match.code} match={match} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.empty}>还没有公开的比赛。</p>
        )}
      </div>
    </section>
  );
}

/**
 * 公开「对阵与名次」：只列经裁判长复核锁定的比分与胜方、已确认的小组名次和已发布的名次榜单。
 * 未确认的比赛只显示状态，不提前宣布比分或胜负；进行中的实时比分请看比赛详情或现场看板。
 */
export function PublicResultsView({ snapshot, capturedAt, basePath }: { snapshot: ReportSnapshot; capturedAt: string; basePath: string }) {
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: snapshot.tournament.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(capturedAt));
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.kicker}>RESULTS</p>
        <h1>对阵与名次</h1>
        <p>
          这里只公布经裁判长复核锁定的结果与已发布的名次；未确认的比赛只显示状态。名次方案：{snapshot.rankingProfile.name}
          {snapshot.rankingProfile.demo ? "（演示配置）" : ""}。
        </p>
        <p className={styles.meta}>
          已确认 {snapshot.counts.confirmed} / {snapshot.counts.matches} 场 · 数据时间 {time}（{snapshot.tournament.timezone}）
        </p>
      </header>
      {snapshot.competitions.length ? (
        snapshot.competitions.map((competition) => (
          <CompetitionResults
            basePath={basePath}
            competition={competition}
            key={competition.code}
            matches={snapshot.matches.filter((match) => match.competitionCode === competition.code)}
          />
        ))
      ) : (
        <p className={styles.empty}>本赛事还没有设置项目。</p>
      )}
      {snapshot.specialResults.length ? (
        <section aria-labelledby="special-results-title" className={styles.competition}>
          <h2 id="special-results-title">特殊结果说明</h2>
          <ul className={styles.notes}>
            {snapshot.specialResults.map((item) => (
              <li key={item.matchCode}>{item.text}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

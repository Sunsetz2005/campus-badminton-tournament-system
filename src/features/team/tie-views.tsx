import Link from "next/link";

import { TIE_POLICY_LABEL, TIE_STATUS_LABEL } from "@/domain/team/tie";
import { formatZonedShort } from "@/domain/time/zoned-time";
import styles from "@/features/management/management.module.css";
import type { TieView } from "@/server/services/team-tie-service";
import { StatusBadge } from "@/ui/status-badge";

type Rubber = TieView["rubbers"][number];

const OUTCOME_LABEL: Record<string, string> = { WO: "弃权", RET: "退赛", DSQ: "取消资格", ABANDONED: "中止", BYE: "轮空" };

export function sideName(view: TieView, side: "A" | "B") {
  const item = view.sides.find((entry) => entry.side === side);
  return item?.entry?.name ?? `待定（${item?.pending ?? "前序结果"}）`;
}

export function rubberStatus(rubber: Rubber): { label: string; tone: "ok" | "warn" | "info" | "neutral" } {
  if (rubber.notPlayed) return { label: "未进行", tone: "neutral" };
  if (rubber.final) return { label: "已锁定", tone: "ok" };
  if (rubber.verificationStatus === "PENDING_REVIEW") return { label: "待复核", tone: "warn" };
  switch (rubber.lifecycleStatus) {
    case "IN_PROGRESS":
      return { label: "进行中", tone: "info" };
    case "SUSPENDED":
      return { label: "暂停", tone: "warn" };
    case "ENDED_PENDING_SUBMISSION":
      return { label: "待提交", tone: "warn" };
    default:
      return rubber.started ? { label: "进行中", tone: "info" } : { label: "未开始", tone: "neutral" };
  }
}

function resultText(view: TieView, rubber: Rubber) {
  if (rubber.notPlayed) return "胜负已定，不再进行";
  if (!rubber.final) return "—";
  const winner = rubber.winner ? sideName(view, rubber.winner) : "无胜方";
  const outcome = rubber.outcomeType && rubber.outcomeType !== "NORMAL" ? `（${OUTCOME_LABEL[rubber.outcomeType] ?? rubber.outcomeType}）` : "";
  const games = rubber.games.map((game) => `${game.a}:${game.b}`).join(" ");
  return `${winner}胜${outcome}${games ? ` ${games}` : ""}`;
}

function playersText(view: TieView, rubber: Rubber, side: "A" | "B") {
  const players = rubber.players[side];
  const info = view.sides.find((entry) => entry.side === side);
  if (!info?.entry) return "待定";
  if (players === null) return info.lineup ? "已提交，未公开" : "未提交";
  if (!players.length) return "未提交";
  return players.map((player) => player.name).join(" / ");
}

/** 一场团体对抗的比分牌：双方、大比分、状态与赛制。 */
export function TieHeader({ view }: { view: TieView }) {
  const { summary } = view;
  const started = summary.status !== "NOT_STARTED";
  return (
    <div className={styles.tieHeader} data-testid="tie-header">
      <div className={styles.tieSide}>
        <strong>{sideName(view, "A")}</strong>
        {summary.winner === "A" ? <StatusBadge tone="ok">胜</StatusBadge> : null}
      </div>
      <div className={styles.tieScore} aria-label={`小场比分 ${summary.rubbers.A} 比 ${summary.rubbers.B}`}>
        {started ? `${summary.rubbers.A} : ${summary.rubbers.B}` : "vs"}
      </div>
      <div className={`${styles.tieSide} ${styles.tieSideB}`}>
        {summary.winner === "B" ? <StatusBadge tone="ok">胜</StatusBadge> : null}
        <strong>{sideName(view, "B")}</strong>
      </div>
      <p className={styles.tieMeta}>
        <StatusBadge tone={summary.status === "COMPLETE" || summary.status === "DECIDED" ? "ok" : summary.status === "NO_RESULT" ? "warn" : "neutral"}>
          {TIE_STATUS_LABEL[summary.status]}
        </StatusBadge>
        <span>
          {view.label} · 先胜 {summary.needed} 场 · {TIE_POLICY_LABEL[summary.policy]}
          {started ? ` · 局 ${summary.games.A}:${summary.games.B} · 分 ${summary.points.A}:${summary.points.B}` : ""}
        </span>
      </p>
      {summary.status === "NO_RESULT" ? (
        <p className={styles.alert}>全部小场已结束但没有一方过半（有无胜方的小场），须由裁判长按规程处理。</p>
      ) : null}
    </div>
  );
}

/** 小场明细：上场队员（按盲交规则裁剪后）、结果与状态。 */
export function RubberTable({ view, officiatingLinks = false, timeZone }: { view: TieView; officiatingLinks?: boolean; timeZone?: string }) {
  return (
    <div className={styles.tableWrap}>
      {/* 不设最小宽度：手机上单元格换行，本队与对方两列都在屏内。 */}
      <table className={`${styles.table} ${styles.rubberTable}`} data-testid="rubber-table">
        <thead>
          <tr>
            <th>小场</th>
            <th>{sideName(view, "A")}</th>
            <th>{sideName(view, "B")}</th>
            <th>结果</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {view.rubbers.map((rubber) => {
            const status = rubberStatus(rubber);
            return (
              <tr key={rubber.order}>
                <td>
                  第 {rubber.order} 场 {rubber.label}
                  {timeZone && rubber.scheduledAt && !rubber.notPlayed ? (
                    <div className={styles.muted}>
                      {rubber.scheduleEstimated ? "约 " : ""}
                      {formatZonedShort(new Date(rubber.scheduledAt), timeZone)}
                      {rubber.court ? ` · ${rubber.court}` : ""}
                    </div>
                  ) : null}
                  {/* 比赛编号只给后台（裁判长可点进执裁台）；负责人不需要，窄屏上也省出空间。 */}
                  {officiatingLinks ? (
                    view.revealedAt && !rubber.notPlayed ? (
                      <div><Link href={`/officiating/${rubber.matchCode}`}>{rubber.matchCode}</Link></div>
                    ) : (
                      <div className={styles.muted}>{rubber.matchCode}</div>
                    )
                  ) : null}
                </td>
                <td>{playersText(view, rubber, "A")}</td>
                <td>{playersText(view, rubber, "B")}</td>
                <td>{resultText(view, rubber)}</td>
                <td><StatusBadge tone={status.tone}>{status.label}</StatusBadge></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 出场名单进度：谁已提交、是否已公开。只显示状态，不显示对方内容。 */
export function LineupProgress({ view }: { view: TieView }) {
  return (
    <p className={styles.regMeta} data-testid="lineup-progress">
      {view.sides.map((side) => (
        <span key={side.side}>
          {side.entry?.name ?? "待定"}：
          {side.lineup ? `已提交（第 ${side.lineup.version} 版${side.lineup.late ? "，逾期由管理员代交" : ""}）` : "未提交"}
        </span>
      ))}
      {view.revealedAt ? <StatusBadge tone="info">双方名单已公开并锁定</StatusBadge> : <StatusBadge>名单盲交中</StatusBadge>}
    </p>
  );
}

/**
 * 对抗的赛程与出场名单截止时间（赛程发布后才有）。`now` 用服务器时间，由页面传入。
 * 截止后负责人不能再交或改，只能由赛事管理员代交并标记逾期。
 */
export function TieSchedule({ view, timeZone, now }: { view: TieView; timeZone: string; now: Date }) {
  const { firstStart, lineupDeadline, courts } = view.schedule;
  if (!firstStart) {
    return (
      <p className={styles.muted} data-testid="tie-schedule">
        赛程尚未发布：时间与场地待定，暂无出场名单截止时间。
      </p>
    );
  }
  const passed = lineupDeadline ? now >= new Date(lineupDeadline) : false;
  return (
    <p className={styles.regMeta} data-testid="tie-schedule">
      <span>计划开始：{formatZonedShort(new Date(firstStart), timeZone)}</span>
      {courts.length ? <span>场地：{courts.join("、")}</span> : null}
      {lineupDeadline ? (
        <span>
          出场名单截止：{formatZonedShort(new Date(lineupDeadline), timeZone)}
          {!view.revealedAt ? (
            passed ? <StatusBadge tone="warn">已截止</StatusBadge> : <StatusBadge tone="info">未截止</StatusBadge>
          ) : null}
        </span>
      ) : null}
    </p>
  );
}

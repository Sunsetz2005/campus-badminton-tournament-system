import { Fragment } from "react";

import { ISSUE_TITLE, type ScheduleIssueCode } from "@/domain/schedule/check";
import { DiscardSlotButton, ReplaceRefereeForm, SlotEditor } from "@/features/schedule/schedule-draft";
import local from "@/features/schedule/schedule.module.css";
import type { ScheduleRowView, SlotView } from "@/server/services/schedule-service";
import { StatusBadge, type StatusTone } from "@/ui/status-badge";

interface Option {
  id: string;
  code?: string;
  name: string;
  active?: boolean;
}

function clock(slot: SlotView) {
  return slot.startLocal ? slot.startLocal.slice(11) : null;
}

function endClock(slot: SlotView, timeZone: string) {
  if (!slot.end) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(slot.end));
}

export function liveStatus(row: ScheduleRowView): { label: string; tone: StatusTone } {
  switch (row.status) {
    case "NOT_PLAYED":
      return { label: "未进行", tone: "neutral" };
    case "ENDED":
      return { label: "已结束", tone: "ok" };
    case "IN_PROGRESS":
      return row.delay?.overrun ? { label: "进行中 · 已超预计时长", tone: "warn" } : { label: "进行中", tone: "info" };
    default:
      return row.delay ? { label: `延误约 ${row.delay.minutes} 分钟`, tone: "danger" } : { label: "待开赛", tone: "neutral" };
  }
}

function worstSeverity(row: ScheduleRowView) {
  if (row.issueCodes.some((issue) => issue.severity === "HARD")) return "HARD";
  if (row.issueCodes.some((issue) => issue.severity === "WARNING")) return "WARNING";
  return undefined;
}

function dayHeading(day: string) {
  if (!day) return "未排时间";
  const date = new Date(`${day}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "UTC" }).format(date);
  return `${day.slice(5).replace("-", " 月 ")} 日 ${weekday}`;
}

/**
 * 赛程列表：按日期分组、按计划时间排序。`mode=draft` 显示草稿与复检标记并可逐场调整；
 * `mode=published` 显示已发布安排与现场状态（待开赛/进行中/已结束/延误），裁判长可临时更换裁判。
 */
export function ScheduleRows({
  rows,
  mode,
  slug,
  timeZone,
  courts,
  referees,
  canEdit = false,
  canReplaceReferee = false,
  showReferees = true,
}: {
  rows: ScheduleRowView[];
  mode: "draft" | "published";
  slug: string;
  timeZone: string;
  courts: Option[];
  referees: Option[];
  canEdit?: boolean;
  canReplaceReferee?: boolean;
  /** 共用裁判账号模式不逐场指派主裁判，隐藏裁判列与换裁判入口。 */
  showReferees?: boolean;
}) {
  if (!rows.length) return <p className="empty-state">没有符合条件的比赛。</p>;
  const dayOf = (row: ScheduleRowView) => row[mode].startLocal?.slice(0, 10) ?? "";
  return (
    <ul className={local.rows} data-testid={`schedule-rows-${mode}`}>
      {rows.map((row, index) => {
        const slot = row[mode];
        const day = dayOf(row);
        const heading = index === 0 || dayOf(rows[index - 1]) !== day ? <li><h3 className={local.dayTitle}>{dayHeading(day)}</h3></li> : null;
        const status = liveStatus(row);
        const time = clock(slot);
        const was = mode === "draft" && row.changed ? row.published : null;
        return (
          <Fragment key={row.id}>
            {heading}
            <li
              className={local.row}
              data-changed={mode === "draft" && row.changed ? "true" : undefined}
              data-code={row.code}
              data-severity={mode === "draft" ? worstSeverity(row) : undefined}
              data-testid="schedule-row"
            >
              <div className={local.time}>
                <strong>{time ? `${slot.estimated ? "约 " : ""}${time}` : "时间待定"}</strong>
                <span>{slot.courtName ?? "场地待定"}</span>
                {time ? <span>至 {endClock(slot, timeZone)}（预计）</span> : null}
                {mode === "published" && row.delay && row.status === "NOT_STARTED" ? (
                  <span>预计 {new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(row.delay.projectedStart))}</span>
                ) : null}
              </div>
              <div className={local.what}>
                <strong>
                  {row.sideA} vs {row.sideB}
                </strong>
                <div className={local.meta}>
                  <span>{row.competitionCode} · {row.fixtureLabel ?? row.stageName}</span>
                  {row.rubber ? <span>{row.rubber}</span> : null}
                  {showReferees ? <span>裁判：{slot.refereeName ?? "未指派"}</span> : null}
                  <span>{row.code}</span>
                </div>
                {was ? (
                  <span className={local.was}>
                    已发布：{was.startLocal ? `${was.startLocal.replace("T", " ")} ${was.courtName ?? ""}` : "未排"} {showReferees ? ` · 裁判 ${was.refereeName ?? "未指派"}` : ""}
                  </span>
                ) : null}
                {mode === "published" && row.delay?.cause && row.status === "NOT_STARTED" ? <span className={local.meta}>原因：{row.delay.cause}</span> : null}
              </div>
              <div className={local.badges}>
                {mode === "published" || row.status !== "NOT_STARTED" ? <StatusBadge tone={status.tone}>{status.label}</StatusBadge> : null}
                {mode === "draft" && row.changed ? <StatusBadge tone="info">草稿已改</StatusBadge> : null}
                {row.tentative && row.status === "NOT_STARTED" ? <StatusBadge tone="warn">暂定对阵</StatusBadge> : null}
                {mode === "draft"
                  ? row.issueCodes.map((issue) => (
                      <StatusBadge key={issue.code} tone={issue.severity === "HARD" ? "danger" : "warn"}>
                        {ISSUE_TITLE[issue.code as ScheduleIssueCode] ?? issue.code}
                      </StatusBadge>
                    ))
                  : null}
              </div>
              {mode === "draft" && canEdit ? (
                row.movable ? (
                  <SlotEditor
                    courts={courts}
                    referees={referees}
                    showReferee={showReferees}
                    slug={slug}
                    value={{
                      code: row.code,
                      courtCode: slot.courtCode,
                      startLocal: slot.startLocal,
                      durationMinutes: slot.durationMinutes,
                      refereeId: slot.refereeId,
                      estimated: slot.estimated,
                      changed: row.changed,
                    }}
                  />
                ) : row.changed ? (
                  <div className={local.editor}>
                    <DiscardSlotButton code={row.code} slug={slug} />
                  </div>
                ) : null
              ) : null}
              {mode === "published" && canReplaceReferee && showReferees && (row.status === "NOT_STARTED" || row.status === "IN_PROGRESS") ? (
                <ReplaceRefereeForm currentId={slot.refereeId} matchCode={row.code} referees={referees} slug={slug} />
              ) : null}
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}

export function ScheduleFilters({
  basePath,
  params,
  days,
  courts,
  competitions,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  days: string[];
  courts: { code: string; name: string }[];
  competitions: string[];
}) {
  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...params, ...patch })) if (value) next.set(key, value);
    const query = next.toString();
    return query ? `${basePath}?${query}` : basePath;
  };
  const current = (key: string, value: string | undefined) => (params[key] === value ? "page" : undefined);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <nav aria-label="按日期筛选" className={local.filters}>
        <span className={local.label}>日期</span>
        <a aria-current={current("day", undefined)} href={href({ day: undefined })}>全部</a>
        {days.map((day) => <a aria-current={current("day", day)} href={href({ day })} key={day}>{day.slice(5)}</a>)}
        <a aria-current={current("day", "none")} href={href({ day: "none" })}>未排时间</a>
      </nav>
      {courts.length ? (
        <nav aria-label="按场地筛选" className={local.filters}>
          <span className={local.label}>场地</span>
          <a aria-current={current("court", undefined)} href={href({ court: undefined })}>全部</a>
          {courts.map((court) => <a aria-current={current("court", court.code)} href={href({ court: court.code })} key={court.code}>{court.name}</a>)}
        </nav>
      ) : null}
      <nav aria-label="其他筛选" className={local.filters}>
        {competitions.length > 1 ? (
          <>
            <span className={local.label}>项目</span>
            <a aria-current={current("competition", undefined)} href={href({ competition: undefined })}>全部</a>
            {competitions.map((code) => <a aria-current={current("competition", code)} href={href({ competition: code })} key={code}>{code}</a>)}
          </>
        ) : null}
        <a aria-current={params.problems ? "page" : undefined} href={href({ problems: params.problems ? undefined : "1" })}>
          只看有问题/有改动
        </a>
      </nav>
    </div>
  );
}

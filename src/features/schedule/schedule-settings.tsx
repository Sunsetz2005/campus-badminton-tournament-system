"use client";

import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";
import { useAction } from "@/features/management/tournament-admin-panels";
import local from "@/features/schedule/schedule.module.css";

export interface ScheduleConfigValue {
  matchMinutes: number;
  rubberMinutes: number;
  changeoverMinutes: number;
  knockoutTieCourts: number;
  lineupDeadlineMinutes: number;
}

const CONFIG_FIELDS: { key: keyof ScheduleConfigValue; label: string; help: string; min: number; max: number }[] = [
  { key: "rubberMinutes", label: "团体小场预计时长（分钟）", help: "每个小场按这个时长往后排；只是预计，不是保证时长。", min: 5, max: 300 },
  { key: "matchMinutes", label: "个人项目预计时长（分钟）", help: "单打、双打个人项目每场的预计时长。", min: 5, max: 300 },
  { key: "changeoverMinutes", label: "换场时间（分钟）", help: "同一块场地相邻两场之间留出的时间。", min: 0, max: 60 },
  { key: "knockoutTieCourts", label: "淘汰赛每场对抗占用场地数", help: "小组赛固定一组一块场地；淘汰赛一场对抗同时在几块场地上打。", min: 1, max: 9 },
  { key: "lineupDeadlineMinutes", label: "出场名单截止（开赛前分钟）", help: "对抗第一个小场计划开始前多少分钟截止；截止后只能由管理员代交。", min: 0, max: 1440 },
];

export function ScheduleConfigForm({ slug, initial }: { slug: string; initial: ScheduleConfigValue }) {
  const { pending, run, feedback } = useAction();
  const [value, setValue] = useState(initial);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(() => sendJson(`/api/admin/tournaments/${slug}/schedule/config`, "PATCH", value), "赛程设置已保存。已发布的赛程不会因此自动改变。");
  }
  return (
    <form className={styles.form} data-testid="schedule-config-form" onSubmit={submit}>
      <div className={styles.fieldGrid}>
        {CONFIG_FIELDS.map((field) => (
          <label className={styles.field} key={field.key}>
            <span>{field.label}</span>
            <input
              inputMode="numeric"
              max={field.max}
              min={field.min}
              onChange={(event) => setValue({ ...value, [field.key]: Number.parseInt(event.target.value || "0", 10) })}
              type="number"
              value={value[field.key]}
            />
            <small>{field.help}</small>
          </label>
        ))}
      </div>
      {feedback}
      <div className={styles.actions}>
        <ActionButton loading={pending} type="submit">保存赛程设置</ActionButton>
      </div>
    </form>
  );
}

export interface CourtValue {
  code: string;
  name: string;
  active: boolean;
}

export function CourtsPanel({ slug, courts }: { slug: string; courts: CourtValue[] }) {
  const { pending, run, feedback } = useAction();
  const [count, setCount] = useState(courts.length ? 1 : 8);
  const [names, setNames] = useState<Record<string, string>>(Object.fromEntries(courts.map((court) => [court.code, court.name])));
  const endpoint = `/api/admin/tournaments/${slug}/schedule/courts`;
  return (
    <div className={styles.form}>
      {courts.length ? (
        <ul className={local.courtRows} data-testid="court-list">
          {courts.map((court) => (
            <li className={local.courtRow} key={court.code}>
              <span className={local.courtCode}>{court.code}</span>
              <input
                aria-label={`${court.code} 名称`}
                onChange={(event) => setNames({ ...names, [court.code]: event.target.value })}
                value={names[court.code] ?? ""}
              />
              <ActionButton
                disabled={pending || names[court.code] === court.name}
                onClick={() => run(() => sendJson(`${endpoint}/${court.code}`, "PATCH", { name: names[court.code] }), `${court.code} 已改名。`)}
                size="sm"
                variant="secondary"
              >
                改名
              </ActionButton>
              <ActionButton
                disabled={pending}
                onClick={() =>
                  run(
                    () => sendJson(`${endpoint}/${court.code}`, "PATCH", { active: !court.active }),
                    court.active ? `${court.name} 已关闭：已排在它上面的比赛会在检查中显示为硬冲突，需要调整后重新发布。` : `${court.name} 已重新开放。`,
                  )
                }
                size="sm"
                variant={court.active ? "danger" : "secondary"}
              >
                {court.active ? "关闭场地" : "重新开放"}
              </ActionButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.info}>还没有场地。先按实际场馆的场地数量添加，例如 8 块。</p>
      )}
      <div className={styles.actions}>
        <label className={styles.field} style={{ maxWidth: 160 }}>
          <span>追加场地数量</span>
          <input inputMode="numeric" max={40} min={1} onChange={(event) => setCount(Number.parseInt(event.target.value || "1", 10))} type="number" value={count} />
        </label>
        <ActionButton loading={pending} onClick={() => run(() => sendJson(endpoint, "POST", { count }), `已追加 ${count} 块场地。`)}>
          追加场地
        </ActionButton>
      </div>
      {feedback}
    </div>
  );
}

export interface DayValue {
  date: string;
  start: string;
  end: string;
}

export function DaysEditor({ slug, initial }: { slug: string; initial: DayValue[] }) {
  const { pending, run, feedback } = useAction();
  const [days, setDays] = useState<DayValue[]>(initial.length ? initial : [{ date: "", start: "09:00", end: "18:00" }]);
  const update = (index: number, patch: Partial<DayValue>) => setDays(days.map((day, position) => (position === index ? { ...day, ...patch } : day)));
  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(
      () => sendJson(`/api/admin/tournaments/${slug}/schedule/days`, "POST", { days: days.filter((day) => day.date) }),
      "比赛日已保存。只影响之后的自动建议与超时提示，不会移动已排比赛。",
    );
  }
  return (
    <form className={styles.form} data-testid="schedule-days-form" onSubmit={submit}>
      <ul className={local.dayRows}>
        {days.map((day, index) => (
          <li className={local.dayRow} key={index}>
            <label className={styles.field}>
              <span>比赛日</span>
              <input onChange={(event) => update(index, { date: event.target.value })} type="date" value={day.date} />
            </label>
            <label className={styles.field}>
              <span>开始</span>
              <input onChange={(event) => update(index, { start: event.target.value })} type="time" value={day.start} />
            </label>
            <label className={styles.field}>
              <span>结束</span>
              <input onChange={(event) => update(index, { end: event.target.value })} type="time" value={day.end} />
            </label>
            <ActionButton aria-label={`删除第 ${index + 1} 个比赛日`} onClick={() => setDays(days.filter((_, position) => position !== index))} size="sm" variant="ghost">
              删除
            </ActionButton>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <ActionButton
          onClick={() => {
            const last = days[days.length - 1];
            const next = last?.date ? new Date(`${last.date}T00:00:00Z`) : null;
            if (next) next.setUTCDate(next.getUTCDate() + 1);
            setDays([...days, { date: next ? next.toISOString().slice(0, 10) : "", start: last?.start ?? "09:00", end: last?.end ?? "18:00" }]);
          }}
          size="sm"
          variant="secondary"
        >
          ＋ 比赛日
        </ActionButton>
        <ActionButton loading={pending} type="submit">保存比赛日</ActionButton>
        <span className={styles.hint}>时间按赛事时区填写，每天一个开放时段；午休等中断请在草稿里手工调整。</span>
      </div>
      {feedback}
    </form>
  );
}

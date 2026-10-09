"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { ISSUE_TITLE, type ScheduleIssue, type ScheduleIssueCode } from "@/domain/schedule/check";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";
import { useAction } from "@/features/management/tournament-admin-panels";
import local from "@/features/schedule/schedule.module.css";

interface Option {
  id: string;
  code?: string;
  name: string;
  active?: boolean;
}

interface CheckFeedback {
  hardCount: number;
  warningCount: number;
  draftChangeCount: number;
  focusIssues: ScheduleIssue[];
}

export interface ScheduleShortfallValue {
  date: string;
  currentEnd: string;
  requiredEnd: string | null;
}

export interface DayWindowValue {
  date: string;
  start: string;
  end: string;
}

interface SuggestResponse {
  scope: number;
  placed: number;
  unplaced: { text: string; count: number }[];
  hardCount: number;
  warningCount: number;
  shortfall: ScheduleShortfallValue | null;
}

function dayLabel(date: string) {
  const [, month, day] = date.split("-").map(Number);
  return `${month} 月 ${day} 日`;
}

/**
 * 排不下时告诉组织者还差多少时间，并可一键把最后一个比赛日延长后重新生成。
 * 延长只改比赛日设置并重跑自动建议，结果仍是草稿，发布前照常检查。
 */
export function ShortfallNotice({
  slug,
  shortfall,
  days,
  onRerun,
}: {
  slug: string;
  shortfall: ScheduleShortfallValue;
  days: DayWindowValue[];
  onRerun: () => Promise<{ ok: boolean; error?: { message: string } }>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requiredEnd } = shortfall;

  async function extend() {
    if (!requiredEnd) return;
    setPending(true);
    setError(null);
    const saved = await sendJson(`/api/admin/tournaments/${slug}/schedule/days`, "POST", {
      days: days.map((day) => (day.date === shortfall.date ? { ...day, end: requiredEnd } : day)),
    });
    const rerun = saved.ok ? await onRerun() : saved;
    setPending(false);
    if (!rerun.ok) setError(rerun.error?.message ?? "操作失败。");
    router.refresh();
  }

  return (
    <div className={styles.alert} data-testid="schedule-shortfall" role="alert">
      {requiredEnd ? (
        <>
          <p>
            现有时段排不下全部比赛：{dayLabel(shortfall.date)} 当前到 {shortfall.currentEnd} 结束，
            要排下全部比赛需要到 <strong>{requiredEnd}</strong>。也可以在「场地与时段」里增加比赛日或场地后重新生成。
          </p>
          <div className={styles.actions}>
            <ActionButton loading={pending} loadingLabel="正在重新排程…" onClick={() => void extend()}>
              延长到 {requiredEnd} 并重新排程
            </ActionButton>
          </div>
        </>
      ) : (
        <p>
          现有比赛日排不下全部比赛：即使把 {dayLabel(shortfall.date)} 放宽到 24:00 也不够。
          请在「场地与时段」里增加比赛日（或场地）后重新生成。
        </p>
      )}
      {error ? <p>{error}</p> : null}
    </div>
  );
}

/** 抽签发布后跳转到这里时的说明：系统是否已自动生成赛程草稿，以及下一步。 */
export function AutoScheduleBanner({
  slug,
  status,
  scope,
  placed,
  message,
  shortfall,
  days,
  competitionCode,
}: {
  slug: string;
  status: string;
  scope: number;
  placed: number;
  message: string | null;
  shortfall: ScheduleShortfallValue | null;
  days: DayWindowValue[];
  competitionCode: string | null;
}) {
  const rerun = () =>
    sendJson(`/api/admin/tournaments/${slug}/schedule/suggest`, "POST", { competitionCode, stage: "ALL", assignReferees: true });
  if (status === "GENERATED") {
    return (
      <section className={styles.section} data-testid="auto-schedule-banner">
        <p className={placed === scope ? styles.success : styles.info} role="status">
          抽签已发布，系统已按场地与比赛时段自动排好 {placed} / {scope} 场比赛的场地和时间（草稿）。
          请在下方检查，没有问题后在「草稿检查与发布」中发布；发布前裁判和公众都看不到。
        </p>
        {shortfall ? <ShortfallNotice days={days} onRerun={rerun} shortfall={shortfall} slug={slug} /> : null}
      </section>
    );
  }
  const text =
    status === "SKIPPED_NOT_CONFIGURED"
      ? "抽签已发布。还没有设置场地或比赛日，所以暂未自动排程：设置好后回到「草稿」点「一键排出赛程」即可。"
      : status === "SKIPPED_ALREADY_ARRANGED"
        ? "抽签已发布。本项目已有比赛排过时间，为避免覆盖手工安排没有自动重排；需要时可在下方重新生成。"
        : `抽签已发布，但自动排程没有完成：${message ?? "请在下方手动生成。"}`;
  return (
    <section className={styles.section} data-testid="auto-schedule-banner">
      <p className={styles.info} role="status">{text}</p>
    </section>
  );
}

/** 自动建议：选范围、最早开始时间，生成草稿。不会动已开始的比赛，也不会直接发布。 */
export function SuggestPanel({ slug, competitions, days }: { slug: string; competitions: string[]; days: DayWindowValue[] }) {
  const router = useRouter();
  const [competitionCode, setCompetitionCode] = useState("");
  const [stage, setStage] = useState<"ALL" | "GROUPS" | "KNOCKOUT">("ALL");
  const [notBefore, setNotBefore] = useState("");
  const [assignReferees, setAssignReferees] = useState(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string; details?: string[] } | null>(null);
  const [shortfall, setShortfall] = useState<ScheduleShortfallValue | null>(null);

  function request() {
    return sendJson<SuggestResponse>(`/api/admin/tournaments/${slug}/schedule/suggest`, "POST", {
      competitionCode: competitionCode || null,
      stage,
      notBefore: notBefore || null,
      assignReferees,
    });
  }

  async function generate() {
    const result = await request();
    if (!result.ok) {
      setShortfall(null);
      setMessage({ tone: "error", text: result.error.message });
      return result;
    }
    const data = result.data;
    setShortfall(data.shortfall);
    setMessage({
      tone: "ok",
      text: `已为 ${data.scope} 场比赛生成草稿：排入 ${data.placed} 场${data.unplaced.length ? `，${data.scope - data.placed} 场排不下` : ""}。当前草稿硬冲突 ${data.hardCount} 个、警告 ${data.warningCount} 个。草稿未发布前，裁判和公众都看不到。`,
      details: data.unplaced.map((item) => `${item.count} 场：${item.text}`),
    });
    router.refresh();
    return result;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    await generate();
    setPending(false);
  }

  return (
    <form className={styles.form} data-testid="suggest-form" onSubmit={submit}>
      <div className={local.editorGrid}>
        <label className={styles.field}>
          <span>项目</span>
          <select onChange={(event) => setCompetitionCode(event.target.value)} value={competitionCode}>
            <option value="">全部项目</option>
            {competitions.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>阶段</span>
          <select onChange={(event) => setStage(event.target.value as typeof stage)} value={stage}>
            <option value="ALL">全部阶段</option>
            <option value="GROUPS">小组/循环赛</option>
            <option value="KNOCKOUT">淘汰赛</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>最早开始（可选）</span>
          <input onChange={(event) => setNotBefore(event.target.value)} type="datetime-local" value={notBefore} />
        </label>
      </div>
      <label className={styles.checkRow}>
        <input checked={assignReferees} onChange={(event) => setAssignReferees(event.target.checked)} type="checkbox" />
        <span>同时建议主裁判（优先让每位裁判固定一块场地，避免同一时间执裁两场）</span>
      </label>
      <p className={styles.hint}>
        建议会覆盖所选范围内尚未开始比赛的草稿安排；小组赛一组固定一块场地、对抗的小场按顺序连打，淘汰赛一场对抗占用设置的场地数并行。
        这是可解释的建议，不保证最优，发布前请检查并手工调整。
      </p>
      {message ? (
        <div className={message.tone === "ok" ? styles.success : styles.alert} role={message.tone === "ok" ? "status" : "alert"}>
          {message.text}
          {message.details?.length ? <ul>{message.details.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        </div>
      ) : null}
      {shortfall ? <ShortfallNotice days={days} onRerun={generate} shortfall={shortfall} slug={slug} /> : null}
      <div className={styles.actions}>
        <ActionButton loading={pending} loadingLabel="正在生成…" type="submit">一键排出赛程</ActionButton>
      </div>
    </form>
  );
}

export interface SlotEditorValue {
  code: string;
  courtCode: string | null;
  startLocal: string | null;
  durationMinutes: number;
  refereeId: string | null;
  estimated: boolean;
  changed: boolean;
}

/** 手工调整一场比赛：场地、开始时间、预计时长、主裁判。保存后立即显示这一场的复检结果。 */
export function SlotEditor({ slug, value, courts, referees }: { slug: string; value: SlotEditorValue; courts: Option[]; referees: Option[] }) {
  const router = useRouter();
  const [courtCode, setCourtCode] = useState(value.courtCode ?? "");
  const [start, setStart] = useState(value.startLocal ?? "");
  const [duration, setDuration] = useState(value.durationMinutes);
  const [refereeId, setRefereeId] = useState(value.refereeId ?? "");
  const [estimated, setEstimated] = useState(value.estimated);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string; issues?: ScheduleIssue[] } | null>(null);
  // 自动建议、放弃改动或别处保存后服务端值会变；表单跟着重置，避免用旧值覆盖新草稿。
  const signature = `${value.courtCode}|${value.startLocal}|${value.durationMinutes}|${value.refereeId}|${value.estimated}`;
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setCourtCode(value.courtCode ?? "");
    setStart(value.startLocal ?? "");
    setDuration(value.durationMinutes);
    setRefereeId(value.refereeId ?? "");
    setEstimated(value.estimated);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setFeedback(null);
    const unscheduled = !courtCode || !start;
    const result = await sendJson<CheckFeedback>(`/api/admin/tournaments/${slug}/schedule/slots/${value.code}`, "PATCH", {
      courtCode: unscheduled ? null : courtCode,
      start: unscheduled ? null : start,
      durationMinutes: duration,
      refereeUserId: refereeId || null,
      estimated: unscheduled ? false : estimated,
    });
    setPending(false);
    if (!result.ok) {
      setFeedback({ tone: "error", text: result.error.message });
      return;
    }
    setFeedback({
      tone: result.data.focusIssues.some((issue) => issue.severity === "HARD") ? "error" : "ok",
      text: result.data.focusIssues.length
        ? `已保存到草稿。这一场复检发现 ${result.data.focusIssues.length} 个问题：`
        : "已保存到草稿，这一场复检没有发现问题。",
      issues: result.data.focusIssues,
    });
    router.refresh();
  }

  async function discard() {
    setPending(true);
    const result = await sendJson(`/api/admin/tournaments/${slug}/schedule/slots/${value.code}/discard`, "POST");
    setPending(false);
    setFeedback(result.ok ? { tone: "ok", text: "已恢复为已发布的安排。" } : { tone: "error", text: result.error.message });
    if (result.ok) router.refresh();
  }

  return (
    <details className={local.editor}>
      <summary>调整</summary>
      <form className={local.editorBody} data-testid={`slot-editor-${value.code}`} onSubmit={save}>
        <div className={local.editorGrid}>
          <label className={styles.field}>
            <span>场地</span>
            <select aria-label="场地" onChange={(event) => setCourtCode(event.target.value)} value={courtCode}>
              <option value="">暂不排</option>
              {courts.map((court) => (
                <option key={court.id} value={court.code}>
                  {court.name}{court.active === false ? "（已关闭）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>开始时间</span>
            <input aria-label="开始时间" onChange={(event) => setStart(event.target.value)} type="datetime-local" value={start} />
          </label>
          <label className={styles.field}>
            <span>预计时长（分钟）</span>
            <input aria-label="预计时长" inputMode="numeric" max={300} min={5} onChange={(event) => setDuration(Number.parseInt(event.target.value || "0", 10))} type="number" value={duration} />
          </label>
          <label className={styles.field}>
            <span>主裁判</span>
            <select aria-label="主裁判" onChange={(event) => setRefereeId(event.target.value)} value={refereeId}>
              <option value="">暂不指派</option>
              {referees.map((referee) => <option key={referee.id} value={referee.id}>{referee.name}</option>)}
            </select>
          </label>
        </div>
        <label className={styles.checkRow}>
          <input checked={estimated} onChange={(event) => setEstimated(event.target.checked)} type="checkbox" />
          <span>时间为预计（接上一场之后开始，公开赛程显示「约」）</span>
        </label>
        {feedback ? (
          <div className={feedback.tone === "ok" ? styles.success : styles.alert} role={feedback.tone === "ok" ? "status" : "alert"}>
            {feedback.text}
            {feedback.issues?.length ? <IssueList issues={feedback.issues} /> : null}
          </div>
        ) : null}
        <div className={styles.actions}>
          <ActionButton loading={pending} size="sm" type="submit">保存并检查</ActionButton>
          {value.changed ? (
            <ActionButton disabled={pending} onClick={discard} size="sm" variant="ghost">放弃这场的草稿改动</ActionButton>
          ) : null}
        </div>
      </form>
    </details>
  );
}

/** 已开始比赛的草稿改动无法发布，只能放弃。 */
export function DiscardSlotButton({ slug, code }: { slug: string; code: string }) {
  const { pending, run, feedback } = useAction();
  return (
    <>
      <ActionButton loading={pending} onClick={() => run(() => sendJson(`/api/admin/tournaments/${slug}/schedule/slots/${code}/discard`, "POST"), "已放弃这场的草稿改动。")} size="sm" variant="ghost">
        放弃草稿改动
      </ActionButton>
      {feedback}
    </>
  );
}

export function IssueList({ issues }: { issues: ScheduleIssue[] }) {
  return (
    <ul className={local.issues}>
      {issues.map((issue) => (
        <li data-code={issue.code} data-severity={issue.severity} key={issue.key}>
          <b>{issue.severity === "HARD" ? "硬冲突" : "警告"} · {ISSUE_TITLE[issue.code as ScheduleIssueCode] ?? issue.code}</b>
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** 整场团体对抗重排：给定开始时间与场地，未开始的小场按顺序轮流分配到这些场地。 */
export function RelayoutTieForm({ slug, fixtures, courts }: { slug: string; fixtures: { id: string; label: string }[]; courts: Option[] }) {
  const { pending, run, feedback } = useAction();
  const [fixtureId, setFixtureId] = useState(fixtures[0]?.id ?? "");
  const [start, setStart] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  if (!fixtures.length) return <p className={styles.muted}>没有可以整场重排的团体对抗。</p>;
  return (
    <form
      className={styles.form}
      data-testid="relayout-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () => sendJson(`/api/admin/tournaments/${slug}/schedule/fixtures/${fixtureId}/relayout`, "POST", { start, courtCodes: selected }),
          "已把这场对抗重排到草稿，请查看下方复检结果。",
        );
      }}
    >
      <div className={local.editorGrid}>
        <label className={styles.field}>
          <span>对抗</span>
          <select onChange={(event) => setFixtureId(event.target.value)} value={fixtureId}>
            {fixtures.map((fixture) => <option key={fixture.id} value={fixture.id}>{fixture.label}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>第一个小场开始</span>
          <input onChange={(event) => setStart(event.target.value)} required type="datetime-local" value={start} />
        </label>
      </div>
      <fieldset className={styles.fieldset}>
        <legend>使用场地（选 1 块即顺序连打，选 2 块即两块场地同时打）</legend>
        <div className={local.checks}>
          {courts.filter((court) => court.active !== false).map((court) => (
            <label key={court.id}>
              <input
                checked={selected.includes(court.code as string)}
                onChange={(event) =>
                  setSelected(event.target.checked ? [...selected, court.code as string] : selected.filter((code) => code !== court.code))
                }
                type="checkbox"
              />
              {court.name}
            </label>
          ))}
        </div>
      </fieldset>
      {feedback}
      <div className={styles.actions}>
        <ActionButton disabled={!start || !selected.length} loading={pending} type="submit">整场重排</ActionButton>
      </div>
    </form>
  );
}

/**
 * 发布：有硬冲突时不可发布；警告须逐项核对后勾选确认（服务端按摘要比对，警告变化后要重新确认）。
 */
export function PublishPanel({
  slug,
  digest,
  hardCount,
  warningCount,
  draftChangeCount,
}: {
  slug: string;
  digest: string;
  hardCount: number;
  warningCount: number;
  draftChangeCount: number;
}) {
  const { pending, run, feedback } = useAction();
  const [acknowledged, setAcknowledged] = useState(false);
  const [note, setNote] = useState("");
  const blocked = hardCount > 0;
  return (
    <div className={styles.form} data-testid="publish-panel">
      {blocked ? (
        <p className={styles.alert}>草稿还有 {hardCount} 个硬冲突，必须先调整，不能通过确认放宽。</p>
      ) : (
        <p className={styles.info}>
          草稿相对已发布版本有 {draftChangeCount} 场改动。发布后：计划时间与场地写入比赛、主裁判同步到各自的「我的执裁」、
          已排定时间的比赛进入公开赛程（按姓名公开策略显示）。已开始的比赛不会被移动。
        </p>
      )}
      {!blocked && warningCount > 0 ? (
        <label className={styles.checkRow}>
          <input checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" />
          <span>我已逐项核对上面的 {warningCount} 条警告，确认按当前安排发布。</span>
        </label>
      ) : null}
      <label className={styles.field}>
        <span>发布说明（可选，记入发布记录）</span>
        <input maxLength={400} onChange={(event) => setNote(event.target.value)} value={note} />
      </label>
      {feedback}
      <div className={styles.actions}>
        <ActionButton
          disabled={blocked || (warningCount > 0 && !acknowledged)}
          loading={pending}
          onClick={() => run(() => sendJson(`/api/admin/tournaments/${slug}/schedule/publish`, "POST", { warningDigest: digest, note: note || null }), "赛程已发布。")}
        >
          发布赛程
        </ActionButton>
        {draftChangeCount > 0 ? (
          <ActionButton
            disabled={pending}
            onClick={() => {
              if (window.confirm("确定放弃全部草稿改动、恢复为已发布的赛程吗？")) {
                void run(() => sendJson(`/api/admin/tournaments/${slug}/schedule/discard`, "POST"), "已放弃全部草稿改动。");
              }
            }}
            variant="ghost"
          >
            放弃全部草稿改动
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}

/** 裁判长临时更换主裁判：必须写原因；旧裁判的控制会话会被吊销。 */
export function ReplaceRefereeForm({ slug, matchCode, referees, currentId }: { slug: string; matchCode: string; referees: Option[]; currentId: string | null }) {
  const { pending, run, feedback } = useAction();
  const [refereeId, setRefereeId] = useState("");
  const [reason, setReason] = useState("");
  const [overlap, setOverlap] = useState<string[]>([]);
  return (
    <details className={local.editor}>
      <summary>临时更换裁判</summary>
      <form
        className={local.editorBody}
        data-testid={`replace-referee-${matchCode}`}
        onSubmit={async (event) => {
          event.preventDefault();
          setOverlap([]);
          await run(async () => {
            const result = await sendJson<{ overlapping: { code: string }[] }>(
              `/api/admin/tournaments/${slug}/schedule/matches/${matchCode}/referee`,
              "POST",
              { refereeUserId: refereeId, reason },
            );
            if (result.ok) setOverlap(result.data.overlapping.map((item) => item.code));
            return result;
          }, "已更换裁判。原裁判的控制已失效，新裁判进入工作台后接续计分。");
        }}
      >
        <div className={local.editorGrid}>
          <label className={styles.field}>
            <span>新裁判</span>
            <select aria-label="新裁判" onChange={(event) => setRefereeId(event.target.value)} required value={refereeId}>
              <option value="">请选择</option>
              {referees.filter((referee) => referee.id !== currentId).map((referee) => <option key={referee.id} value={referee.id}>{referee.name}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>原因</span>
            <input aria-label="更换原因" maxLength={400} onChange={(event) => setReason(event.target.value)} required value={reason} />
          </label>
        </div>
        {feedback}
        {overlap.length ? (
          <p className={styles.alert} role="alert">
            注意：新裁判在已发布赛程里还执裁 {overlap.join("、")}，时间与这场重叠；请在赛程草稿里改派后重新发布。
          </p>
        ) : null}
        <div className={styles.actions}>
          <ActionButton disabled={!refereeId || !reason.trim()} loading={pending} size="sm" type="submit">确认更换</ActionButton>
        </div>
      </form>
    </details>
  );
}

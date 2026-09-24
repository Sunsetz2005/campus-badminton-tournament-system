"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendForm, sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

export interface CompetitionOption {
  id: string;
  code: string;
  name: string;
  entryType: "SINGLES" | "DOUBLES";
}

interface MemberDraft {
  displayName: string;
  studentId: string;
  teamName: string;
  contact: string;
}

const emptyMember: MemberDraft = { displayName: "", studentId: "", teamName: "", contact: "" };

/** 报名成员字段。后台录入和邀请报名共用同一份字段与校验口径。 */
export function MemberFields({
  index,
  value,
  onChange,
  showContactHint = false,
}: {
  index: number;
  value: MemberDraft;
  onChange: (value: MemberDraft) => void;
  showContactHint?: boolean;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>选手 {index + 1}</legend>
      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span>姓名 <em className={styles.required}>*</em></span>
          <input autoComplete="off" maxLength={40} onChange={(event) => onChange({ ...value, displayName: event.target.value })} required value={value.displayName} />
        </label>
        <label className={styles.field}>
          <span>学号</span>
          <input autoComplete="off" inputMode="text" maxLength={32} onChange={(event) => onChange({ ...value, studentId: event.target.value })} value={value.studentId} />
          <small>用于确认身份、避免同名混淆，仅组织方可见。</small>
        </label>
        <label className={styles.field}>
          <span>代表队 / 学院</span>
          <input autoComplete="off" maxLength={60} onChange={(event) => onChange({ ...value, teamName: event.target.value })} value={value.teamName} />
        </label>
        <label className={styles.field}>
          <span>联系方式</span>
          <input autoComplete="off" inputMode="tel" maxLength={60} onChange={(event) => onChange({ ...value, contact: event.target.value })} value={value.contact} />
          {showContactHint ? <small>仅组织方用于通知赛程，不会公开。</small> : null}
        </label>
      </div>
    </fieldset>
  );
}

export function useRegistrationDraft(competitions: CompetitionOption[]) {
  const [competitionId, setCompetitionId] = useState(competitions[0]?.id ?? "");
  const [members, setMembers] = useState<MemberDraft[]>([{ ...emptyMember }, { ...emptyMember }]);
  const [note, setNote] = useState("");
  const competition = competitions.find((item) => item.id === competitionId);
  const count = competition?.entryType === "DOUBLES" ? 2 : 1;
  const payload = { competitionId, members: members.slice(0, count), note };
  const reset = () => {
    setMembers([{ ...emptyMember }, { ...emptyMember }]);
    setNote("");
  };
  return { competitionId, setCompetitionId, members, setMembers, note, setNote, competition, count, payload, reset };
}

export function ManualRegistrationForm({ slug, competitions }: { slug: string; competitions: CompetitionOption[] }) {
  const router = useRouter();
  const draft = useRegistrationDraft(competitions);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await sendJson<{ referenceCode: string }>(`/api/admin/tournaments/${slug}/registrations`, "POST", draft.payload);
    setPending(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.error.message });
      return;
    }
    setMessage({ tone: "ok", text: `已录入，回执编号 ${result.data.referenceCode}，状态为待审核。` });
    draft.reset();
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        <span>比赛项目</span>
        <select onChange={(event) => draft.setCompetitionId(event.target.value)} value={draft.competitionId}>
          {competitions.map((item) => (
            <option key={item.id} value={item.id}>{item.code} {item.name}（{item.entryType === "SINGLES" ? "单打" : "双打"}）</option>
          ))}
        </select>
      </label>
      {Array.from({ length: draft.count }, (_, index) => (
        <MemberFields
          index={index}
          key={index}
          onChange={(value) => draft.setMembers(draft.members.map((member, position) => (position === index ? value : member)))}
          value={draft.members[index]}
        />
      ))}
      <label className={styles.field}>
        <span>备注</span>
        <input maxLength={200} onChange={(event) => draft.setNote(event.target.value)} value={draft.note} />
      </label>
      <div className={styles.actions}>
        <ActionButton loading={pending} type="submit">录入报名</ActionButton>
        <span className={styles.hint}>录入后同样进入待审核，审核通过才生成报名单位。</span>
      </div>
      {message ? <p className={message.tone === "ok" ? styles.success : styles.alert} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p> : null}
    </form>
  );
}

interface PreviewRow {
  line: number;
  status: "NEW" | "DUPLICATE" | "ERROR";
  competitionCode: string;
  members: { displayName: string; studentId: string | null; teamName: string | null; contact: string | null }[];
  messages: string[];
  warnings: string[];
}

interface PreviewResult {
  contentHash: string;
  alreadyImported: boolean;
  headerError: string | null;
  rows: PreviewRow[];
  counts: { total: number; new: number; duplicate: number; error: number };
  canCommit: boolean;
}

const rowStatusLabel = { NEW: "新增", DUPLICATE: "重复，跳过", ERROR: "错误" } as const;

export function ImportPanel({ slug }: { slug: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setPending(true);
    setMessage(null);
    setPreview(null);
    const form = new FormData();
    form.set("file", file);
    const result = await sendForm<PreviewResult>(`/api/admin/tournaments/${slug}/imports/preview`, form);
    setPending(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.error.message });
      return;
    }
    setPreview(result.data);
  }

  async function commit() {
    if (!file || !preview) return;
    setPending(true);
    setMessage(null);
    const form = new FormData();
    form.set("file", file);
    form.set("contentHash", preview.contentHash);
    form.set("newCount", String(preview.counts.new));
    form.set("duplicateCount", String(preview.counts.duplicate));
    const result = await sendForm<{ created: number; skipped: number }>(`/api/admin/tournaments/${slug}/imports/commit`, form);
    setPending(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.error.message });
      return;
    }
    setMessage({ tone: "ok", text: `已导入 ${result.data.created} 份待审核报名，跳过重复 ${result.data.skipped} 行。` });
    setPreview(null);
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <div className={styles.form}>
      <p className={styles.info}>
        先<a href={`/api/admin/tournaments/${slug}/imports/template`}>下载 CSV 模板</a>，
        在 Excel/WPS 中填写后另存为 CSV（UTF-8 或中文系统默认编码均可）。单打项目的「选手2」各列留空。
        上限 500 行、256 KiB；单元格只按文本读取，以 = + - @ 开头的内容会被拒绝。原文件不会保存。
      </p>
      <form className={styles.actions} onSubmit={runPreview}>
        <label className={styles.field}>
          <span>选择 CSV 文件</span>
          <input
            accept=".csv,text/csv"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setMessage(null);
            }}
            ref={inputRef}
            type="file"
          />
        </label>
        <ActionButton disabled={!file} loading={pending && !preview} type="submit" variant="secondary">预览</ActionButton>
      </form>

      {preview ? (
        <div className={styles.form}>
          {preview.headerError ? <p className={styles.alert} role="alert">{preview.headerError}</p> : null}
          {preview.alreadyImported ? <p className={styles.alert} role="alert">这份文件已经导入过，不能重复导入。</p> : null}
          {!preview.headerError ? (
            <>
              <p className={preview.counts.error ? styles.alert : styles.info} role="status">
                共 {preview.counts.total} 行：新增 {preview.counts.new}，重复 {preview.counts.duplicate}，错误 {preview.counts.error}。
                {preview.counts.error ? " 有错误行时整份文件不会导入，请修改后重新预览。" : ""}
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr><th>行号</th><th>结果</th><th>项目</th><th>选手</th><th>说明</th></tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => (
                      <tr className={row.status === "ERROR" ? styles.rowError : row.status === "DUPLICATE" ? styles.rowDuplicate : undefined} key={row.line}>
                        <td>第 {row.line} 行</td>
                        <td>{rowStatusLabel[row.status]}</td>
                        <td>{row.competitionCode || "—"}</td>
                        <td>
                          {row.members.map((member) => [member.displayName, member.studentId].filter(Boolean).join(" ")).join(" / ") || "—"}
                        </td>
                        <td>
                          {[...row.messages, ...row.warnings].length ? (
                            <ul className={styles.rowMessages}>
                              {[...row.messages, ...row.warnings].map((text) => <li key={text}>{text}</li>)}
                            </ul>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
          <div className={styles.actions}>
            <ActionButton disabled={!preview.canCommit} loading={pending} onClick={commit}>
              确认导入 {preview.counts.new} 份
            </ActionButton>
            <span className={styles.hint}>确认时会重新校验；数据在预览后有变化会要求重新预览。</span>
          </div>
        </div>
      ) : null}
      {message ? <p className={message.tone === "ok" ? styles.success : styles.alert} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p> : null}
    </div>
  );
}

export function RenameParticipantForm({ slug, publicCode, currentName }: { slug: string; publicCode: string; currentName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ displayName: currentName, reason: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return <ActionButton onClick={() => setOpen(true)} size="sm" variant="ghost">更正姓名…</ActionButton>;
  }
  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await sendJson(`/api/admin/tournaments/${slug}/participants/${publicCode}/rename`, "POST", values);
        setPending(false);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setOpen(false);
        router.refresh();
      }}
    >
      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span>更正后的姓名</span>
          <input maxLength={40} onChange={(event) => setValues({ ...values, displayName: event.target.value })} required value={values.displayName} />
        </label>
        <label className={styles.field}>
          <span>更正原因</span>
          <input maxLength={200} onChange={(event) => setValues({ ...values, reason: event.target.value })} required value={values.reason} />
          <small>只用于同一人的笔误更正；换人请撤回原报名后重新报名。</small>
        </label>
      </div>
      <div className={styles.actions}>
        <ActionButton loading={pending} size="sm" type="submit" variant="secondary">保存更正</ActionButton>
        <ActionButton disabled={pending} onClick={() => setOpen(false)} size="sm" variant="ghost">取消</ActionButton>
      </div>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
    </form>
  );
}

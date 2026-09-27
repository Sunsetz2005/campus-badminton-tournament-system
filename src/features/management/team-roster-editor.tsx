"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { describeRubbers, eligibleRubberKinds, RUBBER_LABEL, type RubberKind, type TeamFormat } from "@/domain/registration/team-roster";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

export interface RosterMemberDraft {
  displayName: string;
  studentId: string;
  gender: "" | "MALE" | "FEMALE";
  contact: string;
  /** 报项：该队员可参加的小场类型。 */
  rubberKinds: RubberKind[];
}

const emptyRow = (): RosterMemberDraft => ({ displayName: "", studentId: "", gender: "", contact: "", rubberKinds: [] });

function hasContent(row: RosterMemberDraft) {
  return Boolean(row.displayName.trim() || row.studentId.trim() || row.gender || row.contact.trim() || row.rubberKinds.length);
}

/**
 * 团体名单编辑器。负责人提交与管理员代录共用；校验以服务端为准，界面只给即时计数。
 * 只有收到服务端确认才显示成功；失败时保留已填内容，逐条列出错误。
 */
export function TeamRosterEditor({
  endpoint,
  competition,
  format,
  initialMembers,
  initialNote = "",
  expectedVersion,
  submitLabel,
}: {
  endpoint: string;
  competition: { id: string; code: string; name: string };
  format: TeamFormat;
  initialMembers: RosterMemberDraft[];
  initialNote?: string;
  /** 修改待审核名单时必须带上当前版本；新提交为 null。 */
  expectedVersion: number | null;
  submitLabel: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<RosterMemberDraft[]>(() => {
    const filled = initialMembers.length ? initialMembers : [];
    const target = Math.max(format.rosterMin, filled.length + 1);
    return [...filled, ...Array.from({ length: Math.max(0, target - filled.length) }, emptyRow)];
  });
  const [note, setNote] = useState(initialNote);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  const filled = rows.filter(hasContent);
  const male = filled.filter((row) => row.gender === "MALE").length;
  const female = filled.filter((row) => row.gender === "FEMALE").length;
  const update = (index: number, patch: Partial<RosterMemberDraft>) =>
    setRows(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  // 改性别时去掉与新性别不符的报项，避免提交后才被拒。
  const changeGender = (index: number, gender: RosterMemberDraft["gender"]) => {
    const allowed = gender ? eligibleRubberKinds(gender, format.rubbers) : [];
    update(index, { gender, rubberKinds: rows[index].rubberKinds.filter((kind) => allowed.includes(kind)) });
  };
  const toggleKind = (index: number, kind: RubberKind, checked: boolean) => {
    const current = rows[index].rubberKinds;
    update(index, { rubberKinds: checked ? [...current, kind] : current.filter((item) => item !== kind) });
  };
  const entered = (kind: RubberKind) => filled.filter((row) => row.rubberKinds.includes(kind)).length;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setErrors([]);
    setSaved(null);
    const result = await sendJson<{ referenceCode: string; created: boolean }>(endpoint, "POST", {
      competitionId: competition.id,
      members: filled,
      note,
      expectedVersion,
    });
    setPending(false);
    if (!result.ok) {
      const detail = (result.error.details as { errors?: string[] } | undefined)?.errors;
      setErrors(detail?.length ? detail : [result.error.message]);
      return;
    }
    setSaved(`${result.data.created ? "名单已提交" : "名单已更新"}，回执编号 ${result.data.referenceCode}，等待赛事管理员审核。`);
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <p className={styles.info}>
        {competition.code} {competition.name}：每场对抗 {describeRubbers(format.rubbers)}。名单 {format.rosterMin}—{format.rosterMax} 人，
        至少 {format.minMale} 男 {format.minFemale} 女。学号、性别与报项必填；联系方式只供组织方通知，不公开。
        报项决定每场对抗能派谁上哪个小场：一名队员可以报多项，同一场对抗里上几个小场不设上限。
      </p>
      <div className={styles.rosterHead} aria-hidden="true">
        <span>#</span><span>姓名</span><span>学号</span><span>性别</span><span>联系方式（选填）</span><span />
      </div>
      <ol className={styles.rosterRows}>
        {rows.map((row, index) => (
          <li className={styles.rosterRow} data-testid="roster-row" key={index}>
            <span className={styles.rosterNo}>{index + 1}</span>
            <label className={styles.field}>
              <span className={styles.rosterLabel}>姓名</span>
              <input aria-label={`第 ${index + 1} 名队员姓名`} autoComplete="off" maxLength={40} onChange={(event) => update(index, { displayName: event.target.value })} value={row.displayName} />
            </label>
            <label className={styles.field}>
              <span className={styles.rosterLabel}>学号</span>
              <input aria-label={`第 ${index + 1} 名队员学号`} autoComplete="off" maxLength={32} onChange={(event) => update(index, { studentId: event.target.value })} value={row.studentId} />
            </label>
            <label className={styles.field}>
              <span className={styles.rosterLabel}>性别</span>
              <select aria-label={`第 ${index + 1} 名队员性别`} onChange={(event) => changeGender(index, event.target.value as RosterMemberDraft["gender"])} value={row.gender}>
                <option value="">请选择</option>
                <option value="MALE">男</option>
                <option value="FEMALE">女</option>
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.rosterLabel}>联系方式</span>
              <input aria-label={`第 ${index + 1} 名队员联系方式`} autoComplete="off" inputMode="tel" maxLength={60} onChange={(event) => update(index, { contact: event.target.value })} value={row.contact} />
            </label>
            <fieldset className={styles.rosterKinds}>
              <legend>第 {index + 1} 名队员报项</legend>
              {row.gender ? (
                eligibleRubberKinds(row.gender, format.rubbers).map((kind) => (
                  <label className={styles.kindChip} key={kind}>
                    <input
                      checked={row.rubberKinds.includes(kind)}
                      onChange={(event) => toggleKind(index, kind, event.target.checked)}
                      type="checkbox"
                    />
                    {RUBBER_LABEL[kind]}
                  </label>
                ))
              ) : (
                <span className={styles.hint}>先选性别再勾选报项</span>
              )}
            </fieldset>
            <ActionButton
              aria-label={`删除第 ${index + 1} 行`}
              disabled={rows.length <= 1}
              onClick={() => setRows(rows.filter((_, position) => position !== index))}
              size="sm"
              variant="ghost"
            >
              删除
            </ActionButton>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <ActionButton disabled={rows.length >= format.rosterMax} onClick={() => setRows([...rows, emptyRow()])} size="sm" variant="secondary">
          ＋ 添加队员
        </ActionButton>
        <span className={styles.hint} data-testid="roster-count">
          已填 {filled.length} 人（男 {male}、女 {female}）· 报项人数：
          {[...new Set(format.rubbers)].map((kind) => ` ${RUBBER_LABEL[kind]} ${entered(kind)}`).join("，")}
        </span>
      </div>
      <label className={styles.field}>
        <span>备注（选填）</span>
        <input maxLength={200} onChange={(event) => setNote(event.target.value)} value={note} />
      </label>
      {errors.length ? (
        <div className={styles.alert} role="alert">
          名单未提交，请修改后重试：
          <ul>{errors.map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      ) : null}
      {saved ? <p className={styles.success} role="status">{saved}</p> : null}
      <div className={styles.actions}>
        <ActionButton loading={pending} loadingLabel="正在提交…" type="submit">{submitLabel}</ActionButton>
      </div>
    </form>
  );
}

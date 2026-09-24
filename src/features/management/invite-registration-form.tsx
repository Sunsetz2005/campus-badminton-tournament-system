"use client";

import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";
import { MemberFields, useRegistrationDraft, type CompetitionOption } from "@/features/management/registration-entry";

/**
 * 匿名邀请报名表单。提交成功只代表「已收到，待审核」，不代表报名通过；
 * 网络中断时明确提示结果未知，不假装成功。
 */
export function InviteRegistrationForm({ token, competitions }: { token: string; competitions: CompetitionOption[] }) {
  const draft = useRegistrationDraft(competitions);
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ referenceCode: string; competitionName: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await sendJson<{ referenceCode: string; competitionName: string }>(
      `/api/register/${encodeURIComponent(token)}`,
      "POST",
      { ...draft.payload, consent, website },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setReceipt(result.data);
  }

  if (receipt) {
    return (
      <div className={styles.receipt} role="status">
        <span>已收到你的「{receipt.competitionName}」报名，等待组织方审核。</span>
        <strong data-testid="receipt-code">{receipt.referenceCode}</strong>
        <span className={styles.muted}>请保存此回执编号，咨询时提供给组织方。审核结果以组织方通知为准。</span>
        <ActionButton
          onClick={() => {
            setReceipt(null);
            draft.reset();
            setConsent(false);
          }}
          variant="secondary"
        >
          再报一个项目
        </ActionButton>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        <span>报名项目 <em className={styles.required}>*</em></span>
        <select onChange={(event) => draft.setCompetitionId(event.target.value)} value={draft.competitionId}>
          {competitions.map((item) => (
            <option key={item.id} value={item.id}>{item.name}（{item.entryType === "SINGLES" ? "单打，1 人" : "双打，2 人"}）</option>
          ))}
        </select>
      </label>
      {Array.from({ length: draft.count }, (_, index) => (
        <MemberFields
          index={index}
          key={index}
          onChange={(value) => draft.setMembers(draft.members.map((member, position) => (position === index ? value : member)))}
          showContactHint
          value={draft.members[index]}
        />
      ))}
      <label className={styles.field}>
        <span>备注</span>
        <input maxLength={200} onChange={(event) => draft.setNote(event.target.value)} value={draft.note} />
      </label>
      <div aria-hidden="true" className={styles.honeypot}>
        <label>
          网站
          <input autoComplete="off" onChange={(event) => setWebsite(event.target.value)} tabIndex={-1} value={website} />
        </label>
      </div>
      <label className={styles.checkRow}>
        <input checked={consent} onChange={(event) => setConsent(event.target.checked)} required type="checkbox" />
        <span>
          我已知悉：姓名、学号、代表队和联系方式仅用于本次赛事的报名审核与赛程通知；学号和联系方式不会公开，
          姓名是否公开由组织方的公开策略决定。本系统不收集身份证号等其他信息。
        </span>
      </label>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <ActionButton disabled={!consent} loading={pending} loadingLabel="正在提交…" type="submit">提交报名</ActionButton>
        <span className={styles.hint}>提交后需组织方审核，不会自动通过。</span>
      </div>
    </form>
  );
}

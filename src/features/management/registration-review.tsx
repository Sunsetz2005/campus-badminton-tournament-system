"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

export interface CandidateView {
  id: string;
  publicCode: string;
  displayName: string;
  studentId: string | null;
  teamName: string | null;
  competitions: string[];
}

export interface MemberIdentityView {
  slot: number;
  displayName: string;
  kind: "MATCH" | "NEW" | "AMBIGUOUS" | "CONFLICT";
  reason: string | null;
  candidates: CandidateView[];
}

type Decision = "AUTO" | "NEW" | string;

function describeCandidate(candidate: CandidateView) {
  const parts = [candidate.publicCode, candidate.displayName];
  if (candidate.studentId) parts.push(`学号 ${candidate.studentId}`);
  if (candidate.teamName) parts.push(candidate.teamName);
  if (candidate.competitions.length) parts.push(`已报 ${candidate.competitions.join("、")}`);
  return parts.join(" · ");
}

/**
 * 单份报名的审核操作。身份需要人工确认时，必须显式选择「关联到已有人员」或「新建为不同的人」，
 * 系统不会按姓名自动合并。所有操作都带 expectedVersion，他人已处理时会被拒绝。
 */
export function RegistrationReviewActions({
  slug,
  registrationId,
  version,
  status,
  identities,
  canChange,
}: {
  slug: string;
  registrationId: string;
  version: number;
  status: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  identities: MemberIdentityView[];
  canChange: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "reject" | "withdraw">("idle");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>(() =>
    Object.fromEntries(identities.map((identity) => [identity.slot, "AUTO"])),
  );
  const endpoint = `/api/admin/tournaments/${slug}/registrations/${registrationId}/review`;
  const unresolved = identities.filter((identity) => identity.kind === "AMBIGUOUS" && decisions[identity.slot] === "AUTO");
  const conflicts = identities.filter((identity) => identity.kind === "CONFLICT" && decisions[identity.slot] === "AUTO");

  async function submit(body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    const result = await sendJson(endpoint, "POST", { expectedVersion: version, ...body });
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setMode("idle");
    setReason("");
    router.refresh();
  }

  function approve() {
    const resolutions = Object.fromEntries(
      Object.entries(decisions).map(([slot, decision]) => [
        slot,
        decision === "AUTO" || decision === "NEW" ? decision : { participantId: decision },
      ]),
    );
    void submit({ action: "APPROVE", resolutions });
  }

  if (!canChange) {
    return <p className={styles.muted}>项目已锁定</p>;
  }

  return (
    <div className={styles.regActions}>
      {status === "PENDING" && identities.some((identity) => identity.kind !== "NEW" && identity.kind !== "MATCH") ? (
        <div className={styles.identity}>
          {identities.map((identity) =>
            identity.kind === "AMBIGUOUS" || identity.kind === "CONFLICT" ? (
              <fieldset key={identity.slot}>
                <p>
                  <strong>第 {identity.slot} 位「{identity.displayName}」需要确认身份：</strong>
                  {identity.reason}
                </p>
                {identity.candidates.map((candidate) => (
                  <label key={candidate.id}>
                    <input
                      checked={decisions[identity.slot] === candidate.id}
                      name={`identity-${registrationId}-${identity.slot}`}
                      onChange={() => setDecisions({ ...decisions, [identity.slot]: candidate.id })}
                      type="radio"
                    />
                    <span>是同一人：关联到 {describeCandidate(candidate)}</span>
                  </label>
                ))}
                {identity.kind === "AMBIGUOUS" ? (
                  <label>
                    <input
                      checked={decisions[identity.slot] === "NEW"}
                      name={`identity-${registrationId}-${identity.slot}`}
                      onChange={() => setDecisions({ ...decisions, [identity.slot]: "NEW" })}
                      type="radio"
                    />
                    <span>不是同一人：新建为另一名选手（同名不同人）</span>
                  </label>
                ) : (
                  <p>学号相同但姓名不同，不能新建第二人。确认是同一人（例如改名）才可关联；否则请驳回并核对学号。</p>
                )}
              </fieldset>
            ) : null,
          )}
        </div>
      ) : null}

      {status === "PENDING" && mode === "idle" ? (
        <>
          <ActionButton
            disabled={unresolved.length > 0 || conflicts.length > 0}
            loading={pending}
            onClick={approve}
            size="sm"
            title={unresolved.length || conflicts.length ? "请先确认身份" : undefined}
          >
            通过
          </ActionButton>
          <ActionButton disabled={pending} onClick={() => setMode("reject")} size="sm" variant="secondary">驳回…</ActionButton>
          <ActionButton disabled={pending} onClick={() => setMode("withdraw")} size="sm" variant="ghost">撤回…</ActionButton>
        </>
      ) : null}
      {status === "APPROVED" && mode === "idle" ? (
        <ActionButton disabled={pending} onClick={() => setMode("withdraw")} size="sm" variant="ghost">撤回报名…</ActionButton>
      ) : null}

      {mode !== "idle" ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submit({ action: mode === "reject" ? "REJECT" : "WITHDRAW", reason });
          }}
        >
          <label className={styles.field}>
            <span>{mode === "reject" ? "驳回原因" : "撤回原因"}</span>
            <input autoFocus maxLength={200} onChange={(event) => setReason(event.target.value)} required value={reason} />
            {mode === "withdraw" && status === "APPROVED" ? <small>已生成的报名单位会被删除；报名记录与原因保留。</small> : null}
          </label>
          <div className={styles.actions}>
            <ActionButton loading={pending} size="sm" type="submit" variant={mode === "reject" ? "danger" : "secondary"}>
              确认{mode === "reject" ? "驳回" : "撤回"}
            </ActionButton>
            <ActionButton disabled={pending} onClick={() => setMode("idle")} size="sm" variant="ghost">取消</ActionButton>
          </div>
        </form>
      ) : null}
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
    </div>
  );
}

export function BatchApproveButton({ slug, items }: { slug: string; items: { id: string; expectedVersion: number }[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run() {
    setPending(true);
    setSummary(null);
    const result = await sendJson<{ results: { ok: boolean; message?: string }[] }>(
      `/api/admin/tournaments/${slug}/registrations/batch-approve`,
      "POST",
      { items },
    );
    setPending(false);
    if (!result.ok) {
      setSummary({ tone: "error", text: result.error.message });
      return;
    }
    const approved = result.data.results.filter((item) => item.ok).length;
    const failed = result.data.results.length - approved;
    setSummary({
      tone: failed ? "error" : "ok",
      text: failed ? `已通过 ${approved} 份；${failed} 份未通过，仍为待审核，请逐份处理。` : `已通过 ${approved} 份。`,
    });
    router.refresh();
  }

  return (
    <div className={styles.actions}>
      <ActionButton disabled={items.length === 0} loading={pending} onClick={run} variant="secondary">
        批量通过身份明确的 {items.length} 份
      </ActionButton>
      <span className={styles.hint}>需要人工确认身份的报名不会被批量通过。</span>
      {summary ? <p className={summary.tone === "ok" ? styles.success : styles.alert} role="status">{summary.text}</p> : null}
    </div>
  );
}

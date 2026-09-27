"use client";

import { useState } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";
import { useAction } from "@/features/management/tournament-admin-panels";

export function WithdrawRosterButton({ slug, registrationId, version }: { slug: string; registrationId: string; version: number }) {
  const { pending, run, feedback } = useAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={styles.form}>
      {confirming ? (
        <div className={styles.actions}>
          <ActionButton
            loading={pending}
            onClick={() => run(() => sendJson(`/api/team/${slug}/registrations/${registrationId}/withdraw`, "POST", { expectedVersion: version }), "名单已撤回。")}
            variant="danger"
          >
            确认撤回
          </ActionButton>
          <ActionButton disabled={pending} onClick={() => setConfirming(false)} variant="ghost">取消</ActionButton>
          <span className={styles.hint}>撤回后可以重新提交。</span>
        </div>
      ) : (
        <ActionButton onClick={() => setConfirming(true)} size="sm" variant="ghost">撤回这份待审核名单…</ActionButton>
      )}
      {feedback}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

export function ChangePasswordForm({ next }: { next: string }) {
  const router = useRouter();
  const [values, setValues] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (values.newPassword.length < 12) return setError("新口令至少 12 位。");
    if (values.newPassword !== values.confirm) return setError("两次输入的新口令不一致。");
    setPending(true);
    const result = await sendJson("/api/account/password", "POST", {
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    });
    setPending(false);
    if (!result.ok) return setError(result.error.message);
    router.push(next);
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        <span>当前口令（初始口令）</span>
        <input autoComplete="current-password" onChange={(event) => setValues({ ...values, currentPassword: event.target.value })} required type="password" value={values.currentPassword} />
      </label>
      <label className={styles.field}>
        <span>新口令</span>
        <input autoComplete="new-password" minLength={12} onChange={(event) => setValues({ ...values, newPassword: event.target.value })} required type="password" value={values.newPassword} />
        <small>至少 12 位。修改后其他设备上的登录会全部失效。</small>
      </label>
      <label className={styles.field}>
        <span>再次输入新口令</span>
        <input autoComplete="new-password" onChange={(event) => setValues({ ...values, confirm: event.target.value })} required type="password" value={values.confirm} />
      </label>
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <ActionButton loading={pending} loadingLabel="正在保存…" type="submit">修改口令</ActionButton>
      </div>
    </form>
  );
}

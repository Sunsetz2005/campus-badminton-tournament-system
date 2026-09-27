"use client";

import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";
import { useAction } from "@/features/management/tournament-admin-panels";

export function CreateTeamForm({ slug }: { slug: string }) {
  const { pending, run, feedback } = useAction();
  const [name, setName] = useState("");
  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault();
        const ok = await run(() => sendJson(`/api/admin/tournaments/${slug}/teams`, "POST", { name }), `已新建队伍「${name.trim()}」。`);
        if (ok) setName("");
      }}
    >
      <div className={styles.actions}>
        <label className={styles.field} style={{ flex: "1 1 260px" }}>
          <span>学院 / 队伍名称</span>
          <input maxLength={30} onChange={(event) => setName(event.target.value)} placeholder="如 数学科学学院" required value={name} />
        </label>
        <ActionButton loading={pending} type="submit">新建队伍</ActionButton>
      </div>
      {feedback}
    </form>
  );
}

/** 一次性口令只在本次页面状态里显示；刷新或离开后无法再看到，只能重置。 */
function OneTimePassword({ email, password, onDismiss }: { email: string; password: string; onDismiss: () => void }) {
  return (
    <div className={styles.oneTime} role="status">
      <p>
        <strong>请现在把登录信息交给负责人。</strong>初始口令只显示这一次，系统不保存明文；负责人首次登录后必须修改。
      </p>
      <p>登录邮箱：{email}</p>
      <code data-testid="initial-password">{password}</code>
      <div className={styles.actions}>
        <ActionButton onClick={() => void navigator.clipboard?.writeText(password)} size="sm" variant="secondary">复制口令</ActionButton>
        <ActionButton onClick={onDismiss} size="sm" variant="ghost">我已记下，隐藏</ActionButton>
      </div>
    </div>
  );
}

export interface ManagerRow {
  userId: string;
  name: string;
  email: string;
  status: "ACTIVE" | "DISABLED";
  mustChangePassword: boolean;
  resettable: boolean;
}

export function TeamManagersPanel({
  slug,
  teamId,
  teamName,
  managers,
  canManageAccounts,
}: {
  slug: string;
  teamId: string;
  teamName: string;
  managers: ManagerRow[];
  canManageAccounts: boolean;
}) {
  const { pending, run, feedback } = useAction();
  const [form, setForm] = useState({ email: "", name: "" });
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const base = `/api/admin/tournaments/${slug}/teams/${teamId}/managers`;

  async function provision(event: FormEvent) {
    event.preventDefault();
    setSecret(null);
    await run(async () => {
      const result = await sendJson<{ email: string; accountCreated: boolean; initialPassword: string | null }>(base, "POST", form);
      if (result.ok && result.data.initialPassword) setSecret({ email: result.data.email, password: result.data.initialPassword });
      if (result.ok) setForm({ email: "", name: "" });
      return result;
    }, "负责人已添加。已有账号的邮箱只做绑定，口令不变。");
  }

  return (
    <div className={styles.form}>
      {managers.length ? (
        <ul className={styles.chips} aria-label={`${teamName}的负责人`}>
          {managers.map((manager) => (
            <li key={manager.userId}>
              <strong>{manager.name}</strong>
              <span className={styles.muted}>{manager.email}</span>
              {manager.status === "DISABLED" ? <span className={styles.conflictMark}>已停用</span> : null}
              {manager.mustChangePassword ? <span className={styles.muted}>待首次改口令</span> : null}
              {canManageAccounts && manager.resettable ? (
                <ActionButton
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const result = await sendJson<{ email: string; initialPassword: string }>(`${base}/${manager.userId}/reset-password`, "POST");
                      if (result.ok) setSecret({ email: result.data.email, password: result.data.initialPassword });
                      return result;
                    }, "口令已重置，该账号原有登录已全部失效。")
                  }
                  size="sm"
                  variant="ghost"
                >
                  重置口令
                </ActionButton>
              ) : null}
              {canManageAccounts ? (
                <ActionButton
                  disabled={pending}
                  onClick={() => run(() => sendJson(`${base}/${manager.userId}/remove`, "POST"), "已移除负责人。")}
                  size="sm"
                  variant="ghost"
                >
                  移除
                </ActionButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>还没有负责人。</p>
      )}
      {secret ? <OneTimePassword email={secret.email} onDismiss={() => setSecret(null)} password={secret.password} /> : null}
      {canManageAccounts ? (
        <form className={styles.fieldGrid3} onSubmit={provision}>
          <label className={styles.field}>
            <span>负责人姓名</span>
            <input maxLength={40} onChange={(event) => setForm({ ...form, name: event.target.value })} required value={form.name} />
          </label>
          <label className={styles.field}>
            <span>登录邮箱</span>
            <input autoComplete="off" onChange={(event) => setForm({ ...form, email: event.target.value })} required type="email" value={form.email} />
          </label>
          <div className={styles.field}>
            <span aria-hidden="true">&nbsp;</span>
            <ActionButton loading={pending} type="submit" variant="secondary">开通负责人账号</ActionButton>
          </div>
        </form>
      ) : (
        <p className={styles.muted}>开通、重置和移除负责人账号只能由赛事管理员操作。</p>
      )}
      {feedback}
    </div>
  );
}

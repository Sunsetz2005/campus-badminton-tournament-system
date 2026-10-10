"use client";

import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";
import { useAction } from "@/features/management/tournament-admin-panels";

export type RefereeModeValue = "SHARED_ACCOUNT" | "PER_MATCH";

export interface RefereeAccountRow {
  id: string;
  name: string;
  username: string | null;
  status: string;
  managedHere: boolean;
}

/** 系统生成的口令只在本次页面状态里显示；刷新或离开后无法再看到，只能重置。 */
function OneTimeRefereePassword({ username, password, onDismiss }: { username: string; password: string; onDismiss: () => void }) {
  return (
    <div className={styles.oneTime} role="status">
      <p>
        <strong>请现在记下登录信息并告知裁判。</strong>口令只显示这一次，系统不保存明文。
      </p>
      <p>登录用户名：{username}</p>
      <code data-testid="referee-password">{password}</code>
      <div className={styles.actions}>
        <ActionButton onClick={() => void navigator.clipboard?.writeText(password)} size="sm" variant="secondary">复制口令</ActionButton>
        <ActionButton onClick={onDismiss} size="sm" variant="ghost">我已记下，隐藏</ActionButton>
      </div>
    </div>
  );
}

export function RefereeAccountsPanel({
  slug,
  mode,
  accounts,
}: {
  slug: string;
  mode: RefereeModeValue;
  accounts: RefereeAccountRow[];
}) {
  const { pending, run, feedback } = useAction();
  const [form, setForm] = useState({ username: "", name: "裁判", password: "" });
  const [secret, setSecret] = useState<{ username: string; password: string } | null>(null);
  const base = `/api/admin/tournaments/${slug}/referees`;
  const active = accounts.filter((account) => account.status === "ACTIVE");

  async function create(event: FormEvent) {
    event.preventDefault();
    setSecret(null);
    const custom = form.password.trim().length > 0;
    await run(async () => {
      const result = await sendJson<{ username: string; password: string | null }>(base, "POST", {
        username: form.username,
        name: form.name,
        ...(custom ? { password: form.password } : {}),
      });
      if (result.ok && result.data.password) setSecret({ username: result.data.username, password: result.data.password });
      if (result.ok) setForm({ username: "", name: "裁判", password: "" });
      return result;
    }, custom ? "裁判账号已开通，使用你设置的口令登录。" : "裁判账号已开通。");
  }

  return (
    <div className={styles.form} data-testid="referee-accounts">
      <fieldset className={styles.field}>
        <legend>执裁方式</legend>
        <label>
          <input
            checked={mode === "SHARED_ACCOUNT"}
            disabled={pending}
            name="referee-mode"
            onChange={() => void run(() => sendJson(base, "PATCH", { refereeMode: "SHARED_ACCOUNT" }), "已改为共用裁判账号：裁判员账号可以执裁本赛事任意一场。")}
            type="radio"
          />{" "}
          共用裁判账号（推荐）：全体裁判用同一个裁判员账号登录，在「我的执裁」里选场地上的比赛直接开始，不需要逐场指派
        </label>
        <label>
          <input
            checked={mode === "PER_MATCH"}
            disabled={pending}
            name="referee-mode"
            onChange={() => void run(() => sendJson(base, "PATCH", { refereeMode: "PER_MATCH" }), "已改为逐场指派：裁判只能执裁赛程里指派给自己的比赛。")}
            type="radio"
          />{" "}
          逐场指派主裁判：每位裁判各用自己的账号，只能执裁赛程里指派给自己的比赛
        </label>
      </fieldset>

      {accounts.length ? (
        <ul className={styles.chips} aria-label="裁判员账号">
          {accounts.map((account) => (
            <li key={account.id}>
              <strong>{account.name}</strong>
              <span className={styles.muted}>用户名 {account.username ?? "（未设置，用邮箱登录）"}</span>
              {account.status !== "ACTIVE" ? <span className={styles.conflictMark}>已停用</span> : null}
              {account.managedHere && account.status === "ACTIVE" ? (
                <>
                  <ActionButton
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const result = await sendJson<{ username: string; password: string | null }>(`${base}/${account.id}/password`, "POST", {});
                        if (result.ok && result.data.password) setSecret({ username: result.data.username, password: result.data.password });
                        return result;
                      }, "口令已重置，该账号在所有设备上的登录已失效，请用新口令重新登录。")
                    }
                    size="sm"
                    variant="ghost"
                  >
                    重置口令
                  </ActionButton>
                  <ActionButton
                    disabled={pending}
                    onClick={() => {
                      if (!window.confirm(`停用「${account.username ?? account.name}」？所有用它登录的设备会立即退出，正在记分的比赛需要换账号接续。`)) return;
                      void run(() => sendJson(`${base}/${account.id}/disable`, "POST"), "裁判账号已停用。");
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    停用
                  </ActionButton>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {active.length ? null : (
        <p className={styles.alert} role="note">本赛事还没有可用的裁判员账号，裁判无法开始任何比赛。请先在下方开通一个。</p>
      )}
      {secret ? <OneTimeRefereePassword onDismiss={() => setSecret(null)} password={secret.password} username={secret.username} /> : null}

      <form className={styles.fieldGrid3} onSubmit={create}>
        <label className={styles.field}>
          <span>登录用户名</span>
          <input
            autoCapitalize="none"
            autoComplete="off"
            maxLength={30}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
            pattern="[A-Za-z0-9_.]{3,30}"
            placeholder="如 referee01"
            required
            spellCheck={false}
            title="字母、数字、下划线或点，3—30 位"
            value={form.username}
          />
        </label>
        <label className={styles.field}>
          <span>显示名称</span>
          <input maxLength={40} onChange={(event) => setForm({ ...form, name: event.target.value })} required value={form.name} />
        </label>
        <label className={styles.field}>
          <span>口令（留空自动生成）</span>
          <input
            autoComplete="new-password"
            maxLength={64}
            minLength={8}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            placeholder="至少 8 位，便于现场输入"
            type="password"
            value={form.password}
          />
        </label>
        <div className={styles.field}>
          <span aria-hidden="true">&nbsp;</span>
          <ActionButton loading={pending} type="submit" variant="secondary">开通裁判账号</ActionButton>
        </div>
      </form>
      {feedback}
    </div>
  );
}

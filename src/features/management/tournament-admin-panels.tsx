"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { COMPETITION_KIND_LABEL, type RegistrationCompetitionKind } from "@/domain/registration/registration-rules";
import { sendForm, sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

type Phase = "PREPARING" | "REGISTRATION_OPEN" | "REGISTRATION_CLOSED" | "RUNNING" | "FINISHED";

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  async function run(work: () => Promise<{ ok: boolean; error?: { message: string } }>, success: string) {
    setPending(true);
    setMessage(null);
    const result = await work();
    setPending(false);
    if (!result.ok) {
      setMessage({ tone: "error", text: result.error?.message ?? "操作失败。" });
      return false;
    }
    setMessage({ tone: "ok", text: success });
    router.refresh();
    return true;
  }
  const feedback = message ? (
    <p className={message.tone === "error" ? styles.alert : styles.success} role={message.tone === "error" ? "alert" : "status"}>
      {message.text}
    </p>
  ) : null;
  return { pending, run, feedback };
}

export function PhaseControls({ slug, phase }: { slug: string; phase: Phase }) {
  const { pending, run, feedback } = useAction();
  const [reason, setReason] = useState("");
  const endpoint = `/api/admin/tournaments/${slug}/phase`;

  return (
    <div className={styles.form}>
      {phase === "PREPARING" ? (
        <div className={styles.actions}>
          <ActionButton
            loading={pending}
            onClick={() => run(() => sendJson(endpoint, "POST", { to: "REGISTRATION_OPEN" }), "已开放报名。")}
          >
            开放报名
          </ActionButton>
          <span className={styles.hint}>开放后，邀请链接在报名窗口内接受提交。</span>
        </div>
      ) : null}
      {phase === "REGISTRATION_OPEN" ? (
        <div className={styles.actions}>
          <ActionButton
            loading={pending}
            onClick={() => run(() => sendJson(endpoint, "POST", { to: "REGISTRATION_CLOSED" }), "已截止报名。")}
            variant="secondary"
          >
            截止报名
          </ActionButton>
          <span className={styles.hint}>截止后邀请链接停止接受提交；后台仍可补录和审核。</span>
        </div>
      ) : null}
      {phase === "REGISTRATION_CLOSED" ? (
        <form
          className={styles.form}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void run(() => sendJson(endpoint, "POST", { to: "REGISTRATION_OPEN", reason }), "已重新开放报名。");
          }}
        >
          <label className={styles.field}>
            <span>重新开放报名的原因</span>
            <input maxLength={200} onChange={(event) => setReason(event.target.value)} required value={reason} />
          </label>
          <div className={styles.actions}>
            <ActionButton loading={pending} type="submit" variant="secondary">重新开放报名</ActionButton>
            <span className={styles.hint}>开赛属于后续阶段（抽签编排），这里不提供。</span>
          </div>
        </form>
      ) : null}
      {phase === "RUNNING" || phase === "FINISHED" ? (
        <p className={styles.info}>赛事已开赛或结束，报名名单已锁定。</p>
      ) : null}
      {feedback}
    </div>
  );
}

export function PublishButton({ slug }: { slug: string }) {
  const { pending, run, feedback } = useAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={styles.form}>
      {confirming ? (
        <div className={styles.actions}>
          <ActionButton
            loading={pending}
            onClick={() => run(() => sendJson(`/api/admin/tournaments/${slug}/publish`, "POST"), "赛事已发布到公开首页。")}
          >
            确认发布
          </ActionButton>
          <ActionButton disabled={pending} onClick={() => setConfirming(false)} variant="ghost">取消</ActionButton>
          <span className={styles.hint}>发布后赛事出现在公开首页；报名名单和未公开的比赛不会因此公开。发布不可撤回。</span>
        </div>
      ) : (
        <ActionButton onClick={() => setConfirming(true)} variant="secondary">发布赛事门户…</ActionButton>
      )}
      {feedback}
    </div>
  );
}

export function RegistrationSettingsForm({
  slug,
  timezone,
  initial,
}: {
  slug: string;
  timezone: string;
  initial: { registrationOpensAt: string; registrationClosesAt: string; regulations: string };
}) {
  const { pending, run, feedback } = useAction();
  const [values, setValues] = useState(initial);
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () => sendJson(`/api/admin/tournaments/${slug}/settings`, "PATCH", {
            registrationOpensAt: values.registrationOpensAt || null,
            registrationClosesAt: values.registrationClosesAt || null,
            regulations: values.regulations,
          }),
          "报名设置已保存。",
        );
      }}
    >
      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span>报名开始（{timezone}）</span>
          <input onChange={(event) => setValues({ ...values, registrationOpensAt: event.target.value })} type="datetime-local" value={values.registrationOpensAt} />
        </label>
        <label className={styles.field}>
          <span>报名截止（{timezone}）</span>
          <input onChange={(event) => setValues({ ...values, registrationClosesAt: event.target.value })} type="datetime-local" value={values.registrationClosesAt} />
        </label>
        <label className={`${styles.field} ${styles.full}`}>
          <span>规程说明（报名页原样展示）</span>
          <textarea maxLength={5000} onChange={(event) => setValues({ ...values, regulations: event.target.value })} value={values.regulations} />
        </label>
      </div>
      <div className={styles.actions}>
        <ActionButton loading={pending} type="submit" variant="secondary">保存报名设置</ActionButton>
      </div>
      {feedback}
    </form>
  );
}

const KINDS = Object.keys(COMPETITION_KIND_LABEL) as RegistrationCompetitionKind[];

export function AddCompetitionForm({ slug }: { slug: string }) {
  const { pending, run, feedback } = useAction();
  const [values, setValues] = useState({ kind: "MS" as RegistrationCompetitionKind, code: "", name: "" });
  return (
    <form
      className={styles.form}
      onSubmit={async (event) => {
        event.preventDefault();
        const ok = await run(
          () => sendJson(`/api/admin/tournaments/${slug}/competitions`, "POST", values),
          "项目已新增。",
        );
        if (ok) setValues({ kind: values.kind, code: "", name: "" });
      }}
    >
      <div className={styles.fieldGrid3}>
        <label className={styles.field}>
          <span>单项</span>
          <select onChange={(event) => setValues({ ...values, kind: event.target.value as RegistrationCompetitionKind })} value={values.kind}>
            {KINDS.map((kind) => <option key={kind} value={kind}>{COMPETITION_KIND_LABEL[kind]}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          <span>项目代码</span>
          <input maxLength={16} onChange={(event) => setValues({ ...values, code: event.target.value.toUpperCase() })} placeholder="如 MS-B" required value={values.code} />
        </label>
        <label className={styles.field}>
          <span>项目名称</span>
          <input maxLength={30} onChange={(event) => setValues({ ...values, name: event.target.value })} placeholder="如 男单乙组" required value={values.name} />
        </label>
      </div>
      <div className={styles.actions}>
        <ActionButton loading={pending} type="submit" variant="secondary">新增项目</ActionButton>
      </div>
      {feedback}
    </form>
  );
}

export interface InviteRow {
  id: string;
  label: string;
  tokenHint: string;
  expiresAtLabel: string;
  submissionCount: number;
  maxSubmissions: number;
  state: "ACTIVE" | "REVOKED" | "EXPIRED" | "EXHAUSTED";
}

const inviteStateLabel: Record<InviteRow["state"], string> = {
  ACTIVE: "可用",
  REVOKED: "已停用",
  EXPIRED: "已过期",
  EXHAUSTED: "名额已满",
};

export function InvitePanel({
  slug,
  timezone,
  invites,
  canCreate,
  defaultExpiry,
}: {
  slug: string;
  timezone: string;
  invites: InviteRow[];
  canCreate: boolean;
  defaultExpiry: string;
}) {
  const { pending, run, feedback } = useAction();
  const [values, setValues] = useState({ label: "", expiresAt: defaultExpiry, maxSubmissions: 200 });
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreated(null);
    setCopied(false);
    let path: string | null = null;
    const ok = await run(async () => {
      const result = await sendJson<{ path: string }>(`/api/admin/tournaments/${slug}/invites`, "POST", values);
      if (result.ok) path = result.data.path;
      return result;
    }, "邀请链接已生成。完整链接只显示这一次，请立即复制。");
    if (ok && path) {
      setCreated(`${window.location.origin}${path}`);
      setValues({ ...values, label: "" });
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.form}>
      {invites.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>名称</th><th>令牌开头</th><th>失效时间</th><th>已提交</th><th>状态</th><th><span className="visually-hidden">操作</span></th></tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id}>
                  <td>{invite.label}</td>
                  <td><code>{invite.tokenHint}…</code></td>
                  <td>{invite.expiresAtLabel}</td>
                  <td>{invite.submissionCount} / {invite.maxSubmissions}</td>
                  <td>{inviteStateLabel[invite.state]}</td>
                  <td>
                    {invite.state === "ACTIVE" ? (
                      <ActionButton
                        disabled={pending}
                        onClick={() => run(() => sendJson(`/api/admin/tournaments/${slug}/invites/${invite.id}/revoke`, "POST"), "邀请链接已停用。")}
                        size="sm"
                        variant="ghost"
                      >
                        停用
                      </ActionButton>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.muted}>还没有邀请链接。</p>
      )}

      {created ? (
        <div className={styles.inviteLink}>
          <strong>新链接（只显示这一次）</strong>
          <code data-testid="invite-link">{created}</code>
          <div className={styles.actions}>
            <ActionButton onClick={copy} size="sm" variant="secondary">{copied ? "已复制" : "复制链接"}</ActionButton>
            <span className={styles.hint}>服务端只保存摘要，丢失后只能停用并重新生成。</span>
          </div>
        </div>
      ) : null}

      {canCreate ? (
        <form className={styles.form} onSubmit={create}>
          <div className={styles.fieldGrid3}>
            <label className={styles.field}>
              <span>链接名称</span>
              <input maxLength={40} onChange={(event) => setValues({ ...values, label: event.target.value })} placeholder="如 计算机学院" required value={values.label} />
            </label>
            <label className={styles.field}>
              <span>失效时间（{timezone}）</span>
              <input onChange={(event) => setValues({ ...values, expiresAt: event.target.value })} required type="datetime-local" value={values.expiresAt} />
            </label>
            <label className={styles.field}>
              <span>最多提交份数</span>
              <input
                max={2000}
                min={1}
                onChange={(event) => setValues({ ...values, maxSubmissions: Number(event.target.value) })}
                required
                type="number"
                value={values.maxSubmissions}
              />
            </label>
          </div>
          <div className={styles.actions}>
            <ActionButton loading={pending} type="submit" variant="secondary">生成邀请链接</ActionButton>
            <span className={styles.hint}>提交者无需登录，也不会创建账号；每份提交都要经过审核。</span>
          </div>
        </form>
      ) : (
        <p className={styles.info}>赛事已开赛或结束，不能再生成邀请链接。</p>
      )}
      {feedback}
    </div>
  );
}

export function PosterUploadForm({ slug, currentAlt }: { slug: string; currentAlt: string }) {
  const { pending, run, feedback } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState(currentAlt);
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!file) return;
        const form = new FormData();
        form.set("poster", file);
        form.set("posterAlt", alt);
        void run(() => sendForm(`/api/admin/tournaments/${slug}/poster`, form), "海报已上传。");
      }}
    >
      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span>海报图片</span>
          <input accept="image/png,image/jpeg,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} type="file" />
          <small>PNG、JPEG 或 WebP，不超过 2 MiB；格式以文件内容为准。</small>
        </label>
        <label className={styles.field}>
          <span>图片说明（替代文本）</span>
          <input maxLength={120} onChange={(event) => setAlt(event.target.value)} value={alt} />
        </label>
      </div>
      <div className={styles.actions}>
        <ActionButton disabled={!file} loading={pending} type="submit" variant="secondary">上传海报</ActionButton>
      </div>
      {feedback}
    </form>
  );
}

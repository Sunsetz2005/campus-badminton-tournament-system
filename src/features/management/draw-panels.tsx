"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { DRAW_FORMAT_LABEL, type DrawFormat } from "@/domain/draw/format";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";
import { useAction } from "@/features/management/tournament-admin-panels";

export interface DrawEntryOption {
  id: string;
  code: string;
  label: string;
}

export interface DrawSettingsValue {
  format: DrawFormat;
  groupCount: number | null;
  qualifiersPerGroup: 1 | 2;
  thirdPlaceMatch: boolean;
  avoidSameUnit: boolean;
  seeds: { entryId: string; seedNo: number; basis: string }[];
}

const FORMAT_HELP: Record<DrawFormat, string> = {
  ROUND_ROBIN: "所有报名单位两两相遇一次，直接产生名次。项目默认 2—5 个时使用。",
  GROUPS_KNOCKOUT: "先分组单循环，每组前几名进入淘汰赛。项目默认 6 个及以上时使用，每组 3—5 个。",
  KNOCKOUT: "直接单淘汰；人数不是 2 的幂时按签位给种子轮空，轮空不算比赛。",
};

export function DrawSettingsForm({
  slug,
  competitionCode,
  entries,
  initial,
  suggestedGroupCount,
  hasDraft,
}: {
  slug: string;
  competitionCode: string;
  entries: DrawEntryOption[];
  initial: DrawSettingsValue;
  suggestedGroupCount: number | null;
  hasDraft: boolean;
}) {
  const { pending, run, feedback } = useAction();
  const [value, setValue] = useState<DrawSettingsValue>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const usesSeeds = value.format !== "ROUND_ROBIN";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrors([]);
    await run(async () => {
      const result = await sendJson(`/api/admin/tournaments/${slug}/competitions/${competitionCode}/draws`, "POST", {
        ...value,
        groupCount: value.format === "GROUPS_KNOCKOUT" ? value.groupCount : null,
        seeds: usesSeeds ? value.seeds.map((seed, index) => ({ ...seed, seedNo: index + 1 })) : [],
      });
      if (!result.ok) {
        const detail = (result.error.details as { errors?: string[] } | undefined)?.errors;
        if (detail?.length) setErrors(detail);
      }
      return result;
    }, hasDraft ? "已重新抽签，生成了新的草稿版本。" : "已生成抽签草稿。");
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <fieldset className={styles.fieldset}>
        <legend>赛制</legend>
        {(Object.keys(DRAW_FORMAT_LABEL) as DrawFormat[]).map((format) => (
          <label className={styles.checkRow} key={format}>
            <input checked={value.format === format} name="format" onChange={() => setValue({ ...value, format })} type="radio" />
            <span><strong>{DRAW_FORMAT_LABEL[format]}</strong> — {FORMAT_HELP[format]}</span>
          </label>
        ))}
      </fieldset>
      {value.format === "GROUPS_KNOCKOUT" ? (
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span>小组数</span>
            <input
              inputMode="numeric"
              max={16}
              min={2}
              onChange={(event) => setValue({ ...value, groupCount: event.target.value ? Number.parseInt(event.target.value, 10) : null })}
              placeholder={suggestedGroupCount ? `留空按建议 ${suggestedGroupCount} 组` : "请填写"}
              type="number"
              value={value.groupCount ?? ""}
            />
          </label>
          <label className={styles.field}>
            <span>每组出线</span>
            <select onChange={(event) => setValue({ ...value, qualifiersPerGroup: event.target.value === "1" ? 1 : 2 })} value={value.qualifiersPerGroup}>
              <option value="2">前 2 名（项目默认）</option>
              <option value="1">第 1 名</option>
            </select>
          </label>
        </div>
      ) : null}
      {value.format !== "ROUND_ROBIN" ? (
        <label className={styles.checkRow}>
          <input checked={value.thirdPlaceMatch} onChange={(event) => setValue({ ...value, thirdPlaceMatch: event.target.checked })} type="checkbox" />
          <span>安排三四名赛（关闭时两名半决赛负者并列第三，不虚构第四名）</span>
        </label>
      ) : null}
      <label className={styles.checkRow}>
        <input checked={value.avoidSameUnit} onChange={(event) => setValue({ ...value, avoidSameUnit: event.target.checked })} type="checkbox" />
        <span>同单位尽量回避（软约束：优先保证人数均衡和种子分区，做不到会逐条列出冲突）</span>
      </label>

      {usesSeeds ? (
        <fieldset className={styles.fieldset}>
          <legend>种子（可选）</legend>
          <p className={styles.muted}>项目默认不自动设种子。只有有依据（上届成绩、组委会决定）时才设置，并写明依据；小组赛每组最多 1 个。</p>
          {value.seeds.map((seed, index) => (
            <div className={styles.fieldGrid3} key={index}>
              <label className={styles.field}>
                <span>{index + 1} 号种子</span>
                <select
                  onChange={(event) => setValue({ ...value, seeds: value.seeds.map((item, position) => (position === index ? { ...item, entryId: event.target.value } : item)) })}
                  required
                  value={seed.entryId}
                >
                  <option value="">请选择</option>
                  {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} {entry.label}</option>)}
                </select>
              </label>
              <label className={styles.field}>
                <span>设种依据</span>
                <input
                  maxLength={100}
                  onChange={(event) => setValue({ ...value, seeds: value.seeds.map((item, position) => (position === index ? { ...item, basis: event.target.value } : item)) })}
                  placeholder="如 2025 年本项目冠军"
                  required
                  value={seed.basis}
                />
              </label>
              <div className={styles.field}>
                <span aria-hidden="true">&nbsp;</span>
                <ActionButton onClick={() => setValue({ ...value, seeds: value.seeds.filter((_, position) => position !== index) })} size="sm" variant="ghost">
                  删除
                </ActionButton>
              </div>
            </div>
          ))}
          <div className={styles.actions}>
            <ActionButton
              disabled={value.seeds.length >= 16}
              onClick={() => setValue({ ...value, seeds: [...value.seeds, { entryId: "", seedNo: value.seeds.length + 1, basis: "" }] })}
              size="sm"
              variant="secondary"
            >
              ＋ 种子
            </ActionButton>
          </div>
        </fieldset>
      ) : null}

      {errors.length ? (
        <div className={styles.alert} role="alert">
          不能按当前设置抽签：
          <ul>{errors.map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      ) : null}
      <div className={styles.actions}>
        <ActionButton loading={pending} loadingLabel="正在抽签…" type="submit">{hasDraft ? "重新抽签（生成新草稿）" : "生成抽签草稿"}</ActionButton>
        <span className={styles.hint}>随机种子由服务器生成并保存，草稿可以反复生成，发布前不会影响任何比赛。</span>
      </div>
      {errors.length ? null : feedback}
    </form>
  );
}

export function AdjustDrawPanel({
  slug,
  competitionCode,
  drawId,
  format,
  groups,
  entries,
}: {
  slug: string;
  competitionCode: string;
  drawId: string;
  format: DrawFormat;
  groups: { code: string }[];
  entries: DrawEntryOption[];
}) {
  const { pending, run, feedback } = useAction();
  const [mode, setMode] = useState<"SWAP" | "MOVE">("SWAP");
  const [values, setValues] = useState({ entryA: "", entryB: "", toGroup: groups[0]?.code ?? "", reason: "" });
  const endpoint = `/api/admin/tournaments/${slug}/competitions/${competitionCode}/draws/${drawId}/adjust`;

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        const body =
          mode === "SWAP"
            ? { type: "SWAP", entryA: values.entryA, entryB: values.entryB, reason: values.reason }
            : { type: "MOVE", entryId: values.entryA, toGroup: values.toGroup, reason: values.reason };
        void run(() => sendJson(endpoint, "POST", body), "已调签，生成了新的草稿版本，冲突已重新计算。");
      }}
    >
      {format !== "KNOCKOUT" ? (
        <div className={styles.actions}>
          <label className={styles.checkRow}><input checked={mode === "SWAP"} name="adjust-mode" onChange={() => setMode("SWAP")} type="radio" /><span>交换两个报名单位</span></label>
          <label className={styles.checkRow}><input checked={mode === "MOVE"} name="adjust-mode" onChange={() => setMode("MOVE")} type="radio" /><span>移到另一组（各组人数须仍相差不超过 1）</span></label>
        </div>
      ) : (
        <p className={styles.muted}>单淘汰只能交换两个非种子的签位。</p>
      )}
      <div className={styles.fieldGrid}>
        <label className={styles.field}>
          <span>{mode === "SWAP" ? "报名单位甲" : "要移动的报名单位"}</span>
          <select onChange={(event) => setValues({ ...values, entryA: event.target.value })} required value={values.entryA}>
            <option value="">请选择</option>
            {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} {entry.label}</option>)}
          </select>
        </label>
        {mode === "SWAP" ? (
          <label className={styles.field}>
            <span>报名单位乙</span>
            <select onChange={(event) => setValues({ ...values, entryB: event.target.value })} required value={values.entryB}>
              <option value="">请选择</option>
              {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.code} {entry.label}</option>)}
            </select>
          </label>
        ) : (
          <label className={styles.field}>
            <span>目标小组</span>
            <select onChange={(event) => setValues({ ...values, toGroup: event.target.value })} value={values.toGroup}>
              {groups.map((group) => <option key={group.code} value={group.code}>{group.code} 组</option>)}
            </select>
          </label>
        )}
        <label className={`${styles.field} ${styles.full}`}>
          <span>调签原因（留痕，必填）</span>
          <input maxLength={200} onChange={(event) => setValues({ ...values, reason: event.target.value })} required value={values.reason} />
        </label>
      </div>
      <div className={styles.actions}>
        <ActionButton loading={pending} type="submit" variant="secondary">应用调签</ActionButton>
      </div>
      {feedback}
    </form>
  );
}

export function PublishDrawPanel({
  slug,
  competitionCode,
  drawId,
  blockers,
  summary,
}: {
  slug: string;
  competitionCode: string;
  drawId: string;
  blockers: string[];
  summary: string;
}) {
  const { pending, run, feedback } = useAction();
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);

  /** 发布成功后服务端已尝试自动生成赛程草稿；直接带结果跳到赛程页，让下一步就在眼前。 */
  async function publish() {
    const captured: { schedule: AutoSchedule | null } = { schedule: null };
    const ok = await run(async () => {
      const result = await sendJson<{ schedule: AutoSchedule }>(
        `/api/admin/tournaments/${slug}/competitions/${competitionCode}/draws/${drawId}/publish`,
        "POST",
        { confirm: true },
      );
      if (result.ok) captured.schedule = result.data.schedule;
      return result;
    }, "抽签已正式发布，对阵与比赛已生成。正在打开赛程排班…");
    const outcome = captured.schedule;
    if (!ok || !outcome) return;
    const query = new URLSearchParams({ auto: outcome.status, comp: competitionCode });
    if (outcome.status === "GENERATED") {
      query.set("scope", String(outcome.scope));
      query.set("placed", String(outcome.placed));
      if (outcome.shortfall) {
        query.set("sd", outcome.shortfall.date);
        query.set("se", outcome.shortfall.currentEnd);
        query.set("sr", outcome.shortfall.requiredEnd ?? "");
      }
    }
    if (outcome.status === "FAILED") query.set("msg", outcome.message);
    if (outcome.status === "SKIPPED_NOT_CONFIGURED") query.set("view", "settings");
    router.push(`/management/${slug}/schedule?${query.toString()}`);
  }

  return (
    <div className={styles.form}>
      {blockers.length ? (
        <div className={styles.alert}>
          暂时不能发布：
          <ul>{blockers.map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      ) : (
        <p className={styles.info}>{summary}</p>
      )}
      <label className={styles.checkRow}>
        <input checked={confirmed} disabled={blockers.length > 0} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />
        <span>我已核对分组与冲突。发布后本项目报名单位冻结、不能再增减或换人；只有裁判长能在一场都未开始时撤销。</span>
      </label>
      <div className={styles.actions}>
        <ActionButton
          disabled={!confirmed || blockers.length > 0}
          loading={pending}
          onClick={() => void publish()}
        >
          正式发布抽签
        </ActionButton>
      </div>
      {feedback}
    </div>
  );
}

type AutoSchedule =
  | { status: "GENERATED"; scope: number; placed: number; shortfall: { date: string; currentEnd: string; requiredEnd: string | null } | null }
  | { status: "SKIPPED_NOT_CONFIGURED" | "SKIPPED_ALREADY_ARRANGED" }
  | { status: "FAILED"; message: string };

export function RevokeDrawPanel({ slug, competitionCode }: { slug: string; competitionCode: string }) {
  const { pending, run, feedback } = useAction();
  const [reason, setReason] = useState("");
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () => sendJson(`/api/admin/tournaments/${slug}/competitions/${competitionCode}/draws/revoke`, "POST", { reason }),
          "已撤销发布：生成的比赛已删除，报名单位已解冻，可以重新抽签。",
        );
      }}
    >
      <label className={styles.field}>
        <span>撤销原因（漏报、错报或明确的算法错误）</span>
        <input maxLength={200} onChange={(event) => setReason(event.target.value)} required value={reason} />
      </label>
      <div className={styles.actions}>
        <ActionButton loading={pending} type="submit" variant="danger">撤销已发布的抽签</ActionButton>
        <span className={styles.hint}>任一场比赛已开始或有记录时会被拒绝，已打对阵不会改变。</span>
      </div>
      {feedback}
    </form>
  );
}

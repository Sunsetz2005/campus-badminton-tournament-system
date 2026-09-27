"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { RUBBER_LABEL, rubberSize, type RubberKind } from "@/domain/registration/team-roster";
import { eligibleForRubber, type LineupRosterMember } from "@/domain/team/lineup";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

/**
 * 裁判长修改已公开名单中尚未开始的小场（伤病换人等），必须写原因。
 */
export function AmendLineupPanel({
  slug,
  fixtureId,
  rubbers,
  rosters,
  sideNames,
}: {
  slug: string;
  fixtureId: string;
  rubbers: { order: number; kind: RubberKind }[];
  rosters: Record<"A" | "B", LineupRosterMember[]>;
  sideNames: Record<"A" | "B", string>;
}) {
  const router = useRouter();
  const [order, setOrder] = useState(rubbers[0]?.order ?? 0);
  const [side, setSide] = useState<"A" | "B">("A");
  const [players, setPlayers] = useState<string[]>(["", ""]);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const rubber = rubbers.find((item) => item.order === order);
  if (!rubber) return <p className={styles.muted}>没有尚未开始的小场可以修改。</p>;
  const pool = eligibleForRubber(rubber.kind, rosters[side]);
  const size = rubberSize(rubber.kind);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    const result = await sendJson<{ matchCode: string }>(`/api/admin/tournaments/${slug}/fixtures/${fixtureId}/lineup/amend`, "POST", {
      side,
      order,
      participantIds: players.slice(0, size).filter(Boolean),
      reason,
    });
    setPending(false);
    if (!result.ok) {
      const detail = (result.error.details as { errors?: string[] } | undefined)?.errors;
      setMessage({ ok: false, text: detail?.length ? detail.join("；") : result.error.message });
      return;
    }
    setMessage({ ok: true, text: `已修改 ${result.data.matchCode} 的上场队员并记入审计。` });
    setReason("");
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>小场</span>
          <select onChange={(event) => { setOrder(Number(event.target.value)); setPlayers(["", ""]); }} value={order}>
            {rubbers.map((item) => (
              <option key={item.order} value={item.order}>第 {item.order} 场 {RUBBER_LABEL[item.kind]}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>哪一方</span>
          <select onChange={(event) => { setSide(event.target.value as "A" | "B"); setPlayers(["", ""]); }} value={side}>
            <option value="A">{sideNames.A}</option>
            <option value="B">{sideNames.B}</option>
          </select>
        </label>
        {Array.from({ length: size }, (_, slot) => (
          <label className={styles.field} key={slot}>
            <span>{size === 1 ? "换上" : `换上 ${slot + 1}`}</span>
            <select
              aria-label={`修改后的队员 ${slot + 1}`}
              onChange={(event) => setPlayers(players.map((value, index) => (index === slot ? event.target.value : value)))}
              value={players[slot]}
            >
              <option value="">请选择</option>
              {pool.map((member) => (
                <option key={member.participantId} value={member.participantId}>{member.label}</option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <label className={styles.field}>
        <span>原因（必填，记入审计）</span>
        <input maxLength={200} onChange={(event) => setReason(event.target.value)} value={reason} />
      </label>
      {message ? <p className={message.ok ? styles.success : styles.alert} role={message.ok ? "status" : "alert"}>{message.text}</p> : null}
      <div className={styles.actions}>
        <ActionButton loading={pending} loadingLabel="正在修改…" type="submit" variant="secondary">修改上场队员</ActionButton>
      </div>
    </form>
  );
}

/**
 * 裁判长确认小组名次。成绩能分出的名次直接确认；须抽签的几队按抽签结果排好顺序并写明抽签情况。
 */
export function ConfirmRankingPanel({
  slug,
  competitionCode,
  groupCode,
  order,
  lots,
  names,
  title,
}: {
  slug: string;
  competitionCode: string;
  groupCode: string;
  /** 按钮文案，如「确认 A 组名次」或「确认循环赛名次」。 */
  title: string;
  /** 按成绩排出的顺序（报名单位 ID）。 */
  order: string[];
  /** 须抽签的几队（每组）。 */
  lots: string[][];
  names: Record<string, string>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(order);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inLots = new Set(lots.flat());

  function move(index: number, delta: number) {
    const target = index + delta;
    const next = [...draft];
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  }
  const sameLots = (left: string, right: string) => lots.some((group) => group.includes(left) && group.includes(right));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await sendJson<{ order: string[] }>(
      `/api/admin/tournaments/${slug}/competitions/${competitionCode}/groups/${groupCode}/ranking`,
      "POST",
      lots.length ? { order: draft, reason } : {},
    );
    setPending(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {lots.length ? (
        <>
          <p className={styles.info}>有名次无法由成绩区分，须抽签决定。请按抽签结果调整这几队的先后，并写明抽签的时间、方式与见证人。</p>
          <ol className={styles.rankOrder}>
            {draft.map((entryId, index) => (
              <li key={entryId}>
                <span>{index + 1}. {names[entryId] ?? entryId}</span>
                {inLots.has(entryId) ? (
                  <span className={styles.actions}>
                    <ActionButton
                      aria-label={`上移 ${names[entryId]}`}
                      disabled={index === 0 || !sameLots(entryId, draft[index - 1])}
                      onClick={() => move(index, -1)}
                      size="sm"
                      variant="ghost"
                    >
                      上移
                    </ActionButton>
                    <ActionButton
                      aria-label={`下移 ${names[entryId]}`}
                      disabled={index === draft.length - 1 || !sameLots(entryId, draft[index + 1])}
                      onClick={() => move(index, 1)}
                      size="sm"
                      variant="ghost"
                    >
                      下移
                    </ActionButton>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          <label className={styles.field}>
            <span>抽签情况（必填，记入审计）</span>
            <input maxLength={200} onChange={(event) => setReason(event.target.value)} value={reason} />
          </label>
        </>
      ) : (
        <p className={styles.muted}>名次已由成绩确定，确认后将回填到淘汰签位。</p>
      )}
      {error ? <p className={styles.alert} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <ActionButton loading={pending} loadingLabel="正在确认…" type="submit">{title}</ActionButton>
      </div>
    </form>
  );
}

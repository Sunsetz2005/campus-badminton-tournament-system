"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ActionButton } from "@/components/ui/action-button";
import { RUBBER_LABEL, rubberSize, type Gender, type RubberKind } from "@/domain/registration/team-roster";
import {
  appearanceCounts,
  appearanceErrors,
  eligibleForRubber,
  NO_APPEARANCE_LIMITS,
  type LineupRosterMember,
  type TieAppearanceLimits,
} from "@/domain/team/lineup";
import { sendJson } from "@/features/management/api-client";
import styles from "@/features/management/management.module.css";

export interface LineupEditorRubber {
  order: number;
  kind: RubberKind;
}

/**
 * 出场名单编辑器。负责人盲交与管理员代交共用；每个位置只列出报了该项且性别相符的队员。
 * 校验以服务端为准；只有服务端确认才提示成功，失败时保留已选内容并逐条列出错误。
 */
export function LineupEditor({
  endpoint,
  side,
  rubbers,
  roster,
  initial,
  expectedVersion,
  submitLabel,
  limits = NO_APPEARANCE_LIMITS,
  overlappingOrders = [],
}: {
  endpoint: string;
  /** 管理员代交时指定一方；负责人提交时由服务端按绑定判定。 */
  side?: "A" | "B";
  rubbers: LineupEditorRubber[];
  roster: LineupRosterMember[];
  initial: Record<number, string[]>;
  expectedVersion: number | null;
  submitLabel: string;
  /** 本项目按性别的兼项上限（null 表示不设上限）。 */
  limits?: TieAppearanceLimits;
  /** 已发布赛程中同时进行的小场序号对。 */
  overlappingOrders?: [number, number][];
}) {
  const router = useRouter();
  const [picks, setPicks] = useState<Record<number, string[]>>(() =>
    Object.fromEntries(
      rubbers.map((rubber) => [rubber.order, Array.from({ length: rubberSize(rubber.kind) }, (_, index) => initial[rubber.order]?.[index] ?? "")]),
    ),
  );
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  const setPick = (order: number, slot: number, value: string) =>
    setPicks({ ...picks, [order]: picks[order].map((current, index) => (index === slot ? value : current)) });

  const nameOf = new Map(roster.map((member) => [member.participantId, member.label]));
  const current = rubbers.map((rubber) => ({ order: rubber.order, kind: rubber.kind, participantIds: picks[rubber.order].filter(Boolean) }));
  const counts = appearanceCounts(current);
  const multi = [...counts.entries()].filter(([, count]) => count > 1);
  // 与服务端同一份纯规则：提交前先提示兼项超限与同时进行的小场重复出场，最终以服务端为准。
  const hints = appearanceErrors(current, roster, { limits, overlappingOrders });
  const limitText = [
    limits.MALE !== null ? `男队员每场最多 ${limits.MALE} 项` : null,
    limits.FEMALE !== null ? `女队员每场最多 ${limits.FEMALE} 项` : null,
  ].filter(Boolean).join("，");

  function options(kind: RubberKind, slot: number) {
    const pool = eligibleForRubber(kind, roster);
    if (kind !== "XD") return pool;
    const gender: Gender = slot === 0 ? "MALE" : "FEMALE";
    return pool.filter((member) => member.gender === gender);
  }

  function slotLabel(kind: RubberKind, slot: number) {
    if (kind === "XD") return slot === 0 ? "男" : "女";
    return rubberSize(kind) === 1 ? "队员" : `队员 ${slot + 1}`;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setErrors([]);
    setSaved(null);
    const result = await sendJson<{ side: "A" | "B"; version: number; revealed: boolean }>(endpoint, "POST", {
      side,
      expectedVersion,
      rubbers: rubbers.map((rubber) => ({ order: rubber.order, participantIds: picks[rubber.order].filter(Boolean) })),
    });
    setPending(false);
    if (!result.ok) {
      const detail = (result.error.details as { errors?: string[] } | undefined)?.errors;
      setErrors(detail?.length ? detail : [result.error.message]);
      return;
    }
    setSaved(
      result.data.revealed
        ? "双方出场名单已交齐，已同时公开并锁定。"
        : `出场名单已提交（第 ${result.data.version} 版）。对方提交前，双方互相看不到名单；交齐前仍可修改。`,
    );
    router.refresh();
  }

  return (
    <form className={styles.form} data-testid="lineup-editor" onSubmit={submit}>
      <ol className={styles.lineupRows}>
        {rubbers.map((rubber) => (
          <li className={styles.lineupRow} key={rubber.order}>
            <strong>第 {rubber.order} 场 {RUBBER_LABEL[rubber.kind]}</strong>
            <div className={styles.lineupSlots}>
              {picks[rubber.order].map((value, slot) => {
                const choices = options(rubber.kind, slot);
                return (
                  <label className={styles.field} key={slot}>
                    <span>{slotLabel(rubber.kind, slot)}</span>
                    <select
                      aria-label={`第 ${rubber.order} 场${RUBBER_LABEL[rubber.kind]}${slotLabel(rubber.kind, slot)}`}
                      onChange={(event) => setPick(rubber.order, slot, event.target.value)}
                      value={value}
                    >
                      <option value="">请选择</option>
                      {choices.map((member) => (
                        <option
                          disabled={picks[rubber.order].some((other, index) => index !== slot && other === member.participantId)}
                          key={member.participantId}
                          value={member.participantId}
                        >
                          {member.label}
                        </option>
                      ))}
                    </select>
                    {choices.length === 0 ? <span className={styles.hint}>名单里没有报这一项的队员</span> : null}
                  </label>
                );
              })}
            </div>
          </li>
        ))}
      </ol>
      {limitText || overlappingOrders.length ? (
        <p className={styles.hint} data-testid="lineup-rules">
          {limitText ? `兼项上限：${limitText}。` : ""}
          {overlappingOrders.length
            ? `按已发布赛程同时进行的小场：${overlappingOrders.map(([left, right]) => `第 ${left} 与第 ${right} 场`).join("、")}，同一队员不能都上。`
            : ""}
        </p>
      ) : null}
      {multi.length ? (
        <p className={styles.hint} data-testid="lineup-multi">
          兼项：{multi.map(([id, count]) => `${nameOf.get(id) ?? "?"} ${count} 场`).join("、")}
          {limitText ? "" : "（不设上限，请确认队员体能安排）"}
        </p>
      ) : null}
      {hints.length ? (
        <div className={styles.info} data-testid="lineup-hints">
          提交前请先调整：
          <ul>{hints.map((message) => <li key={message}>{message}</li>)}</ul>
        </div>
      ) : null}
      {errors.length ? (
        <div className={styles.alert} role="alert">
          出场名单未提交，请修改后重试：
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

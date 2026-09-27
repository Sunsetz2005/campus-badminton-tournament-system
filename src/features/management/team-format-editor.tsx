"use client";

import { ActionButton } from "@/components/ui/action-button";
import {
  genderSlotsPerTie,
  RUBBER_KINDS,
  RUBBER_LABEL,
  TEAM_RUBBERS_MAX,
  validateTeamFormat,
  type RubberKind,
  type TeamFormat,
} from "@/domain/registration/team-roster";
import styles from "@/features/management/management.module.css";

/**
 * 团体赛设置：每场对抗的小场顺序（可重复，如三单两双）与名单人数要求。
 * 校验与服务端共用同一份纯规则；这里只做即时提示，最终以服务端为准。
 */
export function TeamFormatEditor({
  value,
  onChange,
  idPrefix,
}: {
  value: TeamFormat;
  onChange: (next: TeamFormat) => void;
  idPrefix: string;
}) {
  const errors = validateTeamFormat(value);
  const needs = genderSlotsPerTie(value.rubbers);
  const setNumber = (key: "rosterMin" | "rosterMax" | "minMale" | "minFemale", raw: string) =>
    onChange({ ...value, [key]: raw === "" ? 0 : Number.parseInt(raw, 10) });
  const setLimit = (key: "maxRubbersMale" | "maxRubbersFemale", raw: string) =>
    onChange({ ...value, [key]: raw === "" ? null : Number.parseInt(raw, 10) });
  const setRubber = (index: number, kind: RubberKind) =>
    onChange({ ...value, rubbers: value.rubbers.map((item, position) => (position === index ? kind : item)) });
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= value.rubbers.length) return;
    const rubbers = [...value.rubbers];
    [rubbers[index], rubbers[target]] = [rubbers[target], rubbers[index]];
    onChange({ ...value, rubbers });
  };

  return (
    <fieldset className={styles.fieldset}>
      <legend>团体赛设置</legend>
      <p className={styles.muted}>
        每场学院对抗由下列小场组成，按顺序进行；抽签时每场对抗会生成同样的小场。每场派谁上场（出场名单）在后续阶段提交。
      </p>
      <ol className={styles.rubberList}>
        {value.rubbers.map((kind, index) => (
          <li key={`${index}-${kind}`}>
            <span className={styles.rubberNo}>第 {index + 1} 场</span>
            <select
              aria-label={`第 ${index + 1} 个小场`}
              onChange={(event) => setRubber(index, event.target.value as RubberKind)}
              value={kind}
            >
              {RUBBER_KINDS.map((option) => <option key={option} value={option}>{RUBBER_LABEL[option]}</option>)}
            </select>
            <ActionButton aria-label={`第 ${index + 1} 个小场上移`} disabled={index === 0} onClick={() => move(index, -1)} size="sm" variant="ghost">↑</ActionButton>
            <ActionButton aria-label={`第 ${index + 1} 个小场下移`} disabled={index === value.rubbers.length - 1} onClick={() => move(index, 1)} size="sm" variant="ghost">↓</ActionButton>
            <ActionButton
              aria-label={`删除第 ${index + 1} 个小场`}
              disabled={value.rubbers.length <= 1}
              onClick={() => onChange({ ...value, rubbers: value.rubbers.filter((_, position) => position !== index) })}
              size="sm"
              variant="ghost"
            >
              删除
            </ActionButton>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <ActionButton
          disabled={value.rubbers.length >= TEAM_RUBBERS_MAX}
          onClick={() => onChange({ ...value, rubbers: [...value.rubbers, "MS"] })}
          size="sm"
          variant="secondary"
        >
          ＋ 小场
        </ActionButton>
        <span className={styles.hint}>一场对抗至少需要 {needs.male} 男次、{needs.female} 女次上场（同一人可兼项）。</span>
      </div>
      <div className={styles.fieldGrid}>
        <label className={styles.field} htmlFor={`${idPrefix}-min`}>
          <span>名单最少人数</span>
          <input id={`${idPrefix}-min`} inputMode="numeric" min={1} max={30} onChange={(event) => setNumber("rosterMin", event.target.value)} type="number" value={value.rosterMin} />
        </label>
        <label className={styles.field} htmlFor={`${idPrefix}-max`}>
          <span>名单最多人数</span>
          <input id={`${idPrefix}-max`} inputMode="numeric" min={1} max={30} onChange={(event) => setNumber("rosterMax", event.target.value)} type="number" value={value.rosterMax} />
        </label>
        <label className={styles.field} htmlFor={`${idPrefix}-male`}>
          <span>至少男队员</span>
          <input id={`${idPrefix}-male`} inputMode="numeric" min={0} max={30} onChange={(event) => setNumber("minMale", event.target.value)} type="number" value={value.minMale} />
        </label>
        <label className={styles.field} htmlFor={`${idPrefix}-female`}>
          <span>至少女队员</span>
          <input id={`${idPrefix}-female`} inputMode="numeric" min={0} max={30} onChange={(event) => setNumber("minFemale", event.target.value)} type="number" value={value.minFemale} />
        </label>
        <label className={styles.field} htmlFor={`${idPrefix}-max-male`}>
          <span>男队员每场最多出场小场数</span>
          <input id={`${idPrefix}-max-male`} inputMode="numeric" min={1} max={TEAM_RUBBERS_MAX} onChange={(event) => setLimit("maxRubbersMale", event.target.value)} placeholder="不设上限" type="number" value={value.maxRubbersMale ?? ""} />
          <small>如规程写「不得兼项」填 1；留空表示不设上限。</small>
        </label>
        <label className={styles.field} htmlFor={`${idPrefix}-max-female`}>
          <span>女队员每场最多出场小场数</span>
          <input id={`${idPrefix}-max-female`} inputMode="numeric" min={1} max={TEAM_RUBBERS_MAX} onChange={(event) => setLimit("maxRubbersFemale", event.target.value)} placeholder="不设上限" type="number" value={value.maxRubbersFemale ?? ""} />
          <small>如规程写「女生兼项不超过 2 项」填 2。</small>
        </label>
      </div>
      {errors.length ? <p className={styles.alert} role="alert">{errors.join("；")}。</p> : null}
    </fieldset>
  );
}

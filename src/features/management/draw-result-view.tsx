import type { DrawAdjustment, DrawEntryInput, DrawResult, DrawSettings, SlotSource } from "@/domain/draw/draw-engine";
import { DRAW_FORMAT_LABEL } from "@/domain/draw/format";
import { describeRubbers, type RubberKind } from "@/domain/registration/team-roster";
import styles from "@/features/management/management.module.css";

/**
 * 抽签结果的只读展示。草稿与已发布版本共用；数据全部来自保存的抽签记录，不在这里重新计算。
 */
export function DrawResultView({
  result,
  entries,
  settings,
  rubbers,
}: {
  result: DrawResult;
  entries: DrawEntryInput[];
  settings: DrawSettings;
  rubbers: RubberKind[];
}) {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  const seedOf = new Map(settings.seeds.map((seed) => [seed.entryId, seed.seedNo]));
  const conflicted = new Set(result.conflicts.flatMap((conflict) => conflict.entryIds));
  const entryLabel = (entryId: string) => {
    const entry = byId.get(entryId);
    return entry ? `${entry.label}` : "未知报名单位";
  };
  // 团体报名单位的回避单位就是队伍本身，不重复显示。
  const entryMeta = (entryId: string) => {
    const entry = byId.get(entryId);
    if (!entry) return "";
    const units = entry.units.filter((unit) => unit !== entry.label);
    return units.length ? `${entry.code} · ${units.join("、")}` : entry.code;
  };
  const sourceLabel = (source: SlotSource | null) => {
    if (!source) return "轮空";
    switch (source.type) {
      case "ENTRY":
        return entryLabel(source.entryId);
      case "GROUP_RANK":
        return `${source.groupCode} 组第 ${source.rank} 名`;
      case "FIXTURE_WINNER":
        return `${source.fixtureCode} 胜者`;
      case "FIXTURE_LOSER":
        return `${source.fixtureCode} 负者`;
    }
  };
  const groupFixtures = result.fixtures.filter((fixture) => fixture.kind === "GROUP");
  const knockout = result.fixtures.filter((fixture) => fixture.kind !== "GROUP");
  const isTeam = rubbers.length > 0;

  return (
    <div className={styles.form} data-testid="draw-result">
      <div className={styles.stats}>
        <div><strong>{DRAW_FORMAT_LABEL[result.layout.format]}</strong><span>赛制</span></div>
        <div><strong>{entries.length}</strong><span>报名单位</span></div>
        <div><strong>{result.fixtures.length}</strong><span>{isTeam ? "场学院对抗" : "场比赛"}</span></div>
        <div><strong data-testid="conflict-count">{result.conflicts.length}</strong><span>回避冲突</span></div>
      </div>
      {isTeam ? <p className={styles.muted}>每场对抗含 {rubbers.length} 个小场：{describeRubbers(rubbers)}；出场名单在后续阶段提交。</p> : null}

      {result.conflicts.length ? (
        <div className={styles.alert} data-testid="draw-conflicts">
          以下同单位相遇无法完全避免（已按「不漏不重 → 人数均衡 → 种子分区 → 回避」的优先级处理）：
          <ul>
            {result.conflicts.map((conflict) => (
              <li key={`${conflict.where}-${conflict.unit}`}>
                {conflict.where}：{conflict.entryIds.map(entryLabel).join("、")}（{conflict.unit}）。{conflict.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : settings.avoidSameUnit ? (
        <p className={styles.success}>同单位回避已全部满足。</p>
      ) : (
        <p className={styles.muted}>未启用同单位回避。</p>
      )}
      {result.warnings.length ? (
        <div className={styles.info}>
          提示：
          <ul>{result.warnings.map((warning) => <li key={warning.code}>{warning.message}</li>)}</ul>
        </div>
      ) : null}

      {result.layout.groups.length ? (
        <div className={styles.groupGrid}>
          {result.layout.groups.map((group) => (
            <section aria-label={`${group.code} 组`} className={styles.groupCard} data-testid="draw-group" key={group.code}>
              <h3>{result.layout.format === "ROUND_ROBIN" ? "单循环" : `${group.code} 组`}（{group.entryIds.length}）</h3>
              <ol>
                {group.entryIds.map((entryId) => (
                  <li key={entryId}>
                    {entryLabel(entryId)}
                    {seedOf.has(entryId) ? <span className={styles.seedMark}>{seedOf.get(entryId)} 号种子</span> : null}
                    {conflicted.has(entryId) ? <span className={styles.conflictMark}> ⚠ 同单位</span> : null}
                    <div className={styles.muted}>{entryMeta(entryId)}</div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : null}

      {result.layout.bracket ? (
        <details open={result.layout.format === "KNOCKOUT"}>
          <summary>淘汰签表（{result.layout.bracket.size} 签位）</summary>
          <ol className={styles.bracket}>
            {result.layout.bracket.slots.map((slot, index) => (
              <li key={index}>
                <span>{index + 1}</span>
                <span className={slot ? undefined : styles.byeSlot}>
                  {sourceLabel(slot)}
                  {slot?.type === "ENTRY" && seedOf.has(slot.entryId) ? <span className={styles.seedMark}>{seedOf.get(slot.entryId)} 号种子</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {groupFixtures.length ? (
        <details>
          <summary>{result.layout.format === "ROUND_ROBIN" ? "循环对阵" : "小组对阵"}（{groupFixtures.length} 场）</summary>
          <ul className={styles.fixtureList}>
            {groupFixtures.map((fixture) => (
              <li key={fixture.code}>
                <code>{fixture.code}</code>
                <span>{fixture.label}：{sourceLabel(fixture.sideA)} 对 {sourceLabel(fixture.sideB)}</span>
              </li>
            ))}
          </ul>
          {result.groupByes.length ? (
            <p className={styles.muted}>
              轮空（不是比赛、不记比分）：{result.groupByes.map((bye) => `${bye.groupCode} 组第 ${bye.round} 轮 ${entryLabel(bye.entryId)}`).join("；")}
            </p>
          ) : null}
        </details>
      ) : null}
      {knockout.length ? (
        <details open>
          <summary>淘汰对阵（{knockout.length} 场，参赛者待前序结果产生）</summary>
          <ul className={styles.fixtureList}>
            {knockout.map((fixture) => (
              <li key={fixture.code}>
                <code>{fixture.code}</code>
                <span>{fixture.label}：{sourceLabel(fixture.sideA)} 对 {sourceLabel(fixture.sideB)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function DrawProvenance({
  version,
  randomSeed,
  algorithmVersion,
  inputHash,
  adjustments,
  settings,
}: {
  version: number;
  randomSeed: string;
  algorithmVersion: string;
  inputHash: string;
  adjustments: DrawAdjustment[];
  settings: DrawSettings;
}) {
  return (
    <details>
      <summary>复现依据（第 {version} 版）</summary>
      <dl className={styles.facts}>
        <div><dt>算法版本</dt><dd>{algorithmVersion}</dd></div>
        <div><dt>随机种子</dt><dd><code>{randomSeed}</code></dd></div>
        <div><dt>名单摘要</dt><dd><code>{inputHash.slice(0, 16)}…</code></dd></div>
        <div><dt>种子设置</dt><dd>{settings.seeds.length ? settings.seeds.map((seed) => `${seed.seedNo} 号：${seed.basis}`).join("；") : "无"}</dd></div>
        <div><dt>手动调签</dt><dd>{adjustments.length ? adjustments.map((item, index) => `${index + 1}. ${item.type === "SWAP" ? "交换" : `移到 ${item.toGroup} 组`}（${item.reason}）`).join("；") : "无"}</dd></div>
      </dl>
    </details>
  );
}

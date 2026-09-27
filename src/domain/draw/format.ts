/**
 * 赛制规模的纯规则（项目默认，见《赛事执行规则 v1.0》“分组、种子、回避和晋级”）：
 * - 0 个报名单位不编排；1 个只保留报名记录，不自动产生冠军。
 * - 2—5 个默认单循环；6 个及以上默认小组单循环＋淘汰，每组目标 4、允许 3—5、组间相差不超过 1，每组前 2 出线。
 * 这些是项目默认，正式赛事须由组织者采纳。
 */

export type DrawFormat = "ROUND_ROBIN" | "GROUPS_KNOCKOUT" | "KNOCKOUT";

export const DRAW_FORMAT_LABEL: Record<DrawFormat, string> = {
  ROUND_ROBIN: "单循环",
  GROUPS_KNOCKOUT: "小组循环＋淘汰",
  KNOCKOUT: "单淘汰",
};

export const GROUP_SIZE = { target: 4, recommendedMin: 3, recommendedMax: 5, hardMin: 2, hardMax: 8 } as const;
export const ROUND_ROBIN_MAX_DEFAULT = 5;
export const MAX_SEEDS = 16;

export function nextPowerOfTwo(value: number) {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/** 组数固定时的人数分配：前面的组多 1 个，组间相差不超过 1。 */
export function balancedGroupSizes(entryCount: number, groupCount: number) {
  if (groupCount <= 0) throw new Error("组数必须为正整数");
  const base = Math.floor(entryCount / groupCount);
  const extra = entryCount % groupCount;
  return Array.from({ length: groupCount }, (_, index) => base + (index < extra ? 1 : 0));
}

function isPowerOfTwo(value: number) {
  return value > 0 && (value & (value - 1)) === 0;
}

/**
 * 建议组数：只在每组都落在 3—5 的组数里挑；以「各组人数偏离 4 的总和」最小为准，
 * 并列时优先让出线总数是 2 的幂（签表不需要轮空），再并列取组数少的。
 */
export function suggestGroupCount(entryCount: number, qualifiersPerGroup = 2) {
  let best: { groupCount: number; deviation: number; clean: boolean } | null = null;
  for (let groupCount = 2; groupCount <= Math.floor(entryCount / GROUP_SIZE.recommendedMin); groupCount += 1) {
    const sizes = balancedGroupSizes(entryCount, groupCount);
    if (sizes.some((size) => size < GROUP_SIZE.recommendedMin || size > GROUP_SIZE.recommendedMax)) continue;
    const deviation = sizes.reduce((sum, size) => sum + Math.abs(size - GROUP_SIZE.target), 0);
    const clean = isPowerOfTwo(groupCount * qualifiersPerGroup);
    if (
      !best ||
      deviation < best.deviation ||
      (deviation === best.deviation && clean && !best.clean)
    ) {
      best = { groupCount, deviation, clean };
    }
  }
  return best?.groupCount ?? null;
}

export interface FormatSuggestion {
  format: DrawFormat;
  groupCount: number | null;
  reason: string;
}

export function suggestFormat(entryCount: number): FormatSuggestion | null {
  if (entryCount < 2) return null;
  if (entryCount <= ROUND_ROBIN_MAX_DEFAULT) {
    return { format: "ROUND_ROBIN", groupCount: null, reason: `${entryCount} 个报名单位，按项目默认采用单循环并直接产生名次` };
  }
  const groupCount = suggestGroupCount(entryCount);
  if (!groupCount) {
    return { format: "KNOCKOUT", groupCount: null, reason: `${entryCount} 个报名单位无法均分为每组 3—5 个，建议单淘汰` };
  }
  return {
    format: "GROUPS_KNOCKOUT",
    groupCount,
    reason: `${entryCount} 个报名单位，按项目默认分 ${groupCount} 组单循环，每组前 2 名进入淘汰赛`,
  };
}

/** 建议种子上限（超过只提示，不拒绝）：8—15 个 2 名、16—31 个 4 名、32—63 个 8 名、64 个以上 16 名。 */
export function recommendedSeedCap(entryCount: number) {
  if (entryCount >= 64) return 16;
  if (entryCount >= 32) return 8;
  if (entryCount >= 16) return 4;
  if (entryCount >= 8) return 2;
  return 0;
}

export function groupCodeAt(index: number) {
  if (index < 0 || index >= 26) throw new Error("小组数超出 A—Z");
  return String.fromCharCode(65 + index);
}

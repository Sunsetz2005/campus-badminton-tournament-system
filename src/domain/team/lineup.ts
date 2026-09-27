/**
 * 团体对抗出场名单的纯规则。无 IO、无框架。
 *
 * - 一场对抗的每个小场都要排人：单打 1 人、双打 2 人；
 * - 上场队员必须在本队名单里、报名时报了该项，且性别符合小场（男单/男双为男、女单/女双为女、混双一男一女）；
 * - 同一小场里不能重复同一个人；同一队员在一场对抗里可以上几个小场默认**不设上限**（2026-09-24 用户决定），
 *   兼项由报名时的报项约束。组织者可以按规程为团体项目设置按性别的上限（如「男队员不得兼项、女队员最多 2 项」，
 *   2026-09-25 按用户提供的校园联赛秩序册加入，为空仍表示不设上限）；
 * - 赛程发布后，计划时间重叠的两个小场（淘汰赛多块场地同时打）不能由同一名队员出场。
 */

import {
  GENDER_LABEL,
  RUBBER_LABEL,
  rubberGender,
  rubberSize,
  type Gender,
  type RubberKind,
} from "@/domain/registration/team-roster";

export interface LineupRosterMember {
  participantId: string;
  label: string;
  gender: Gender;
  rubberKinds: readonly RubberKind[];
}

export interface LineupRubber {
  order: number;
  kind: RubberKind;
}

export interface LineupRubberInput {
  order: number;
  participantIds: readonly string[];
}

/** 同一队员在一场对抗里最多上几个小场（按性别）；null 表示不设上限。 */
export interface TieAppearanceLimits {
  MALE: number | null;
  FEMALE: number | null;
}

export const NO_APPEARANCE_LIMITS: TieAppearanceLimits = { MALE: null, FEMALE: null };

export interface LineupOptions {
  limits?: TieAppearanceLimits;
  /** 已发布赛程中时间重叠的小场序号对（同一场对抗内）。 */
  overlappingOrders?: readonly (readonly [number, number])[];
}

export interface NormalizedLineupRubber {
  order: number;
  kind: RubberKind;
  participantIds: string[];
}

export function rubberTitle(rubber: LineupRubber) {
  return `第 ${rubber.order} 场${RUBBER_LABEL[rubber.kind]}`;
}

/** 某个小场可以从名单里选哪些人（报了该项且性别相符）。 */
export function eligibleForRubber(kind: RubberKind, roster: readonly LineupRosterMember[]) {
  const gender = rubberGender(kind);
  return roster.filter((member) => member.rubberKinds.includes(kind) && (gender === "MIXED" || member.gender === gender));
}

/**
 * 校验一方的出场名单。必须覆盖本场对抗的全部小场；出错时返回全部错误，便于一次改完。
 */
export function validateLineup(
  rubbers: readonly LineupRubber[],
  roster: readonly LineupRosterMember[],
  input: readonly LineupRubberInput[],
  options: LineupOptions = {},
): { lineup: NormalizedLineupRubber[] | null; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map(roster.map((member) => [member.participantId, member]));
  const inputByOrder = new Map<number, LineupRubberInput>();
  for (const item of input) {
    if (!rubbers.some((rubber) => rubber.order === item.order)) {
      errors.push(`本场对抗没有第 ${item.order} 场小场`);
      continue;
    }
    if (inputByOrder.has(item.order)) {
      errors.push(`第 ${item.order} 场小场重复提交`);
      continue;
    }
    inputByOrder.set(item.order, item);
  }

  const lineup: NormalizedLineupRubber[] = [];
  for (const rubber of [...rubbers].sort((left, right) => left.order - right.order)) {
    const title = rubberTitle(rubber);
    const item = inputByOrder.get(rubber.order);
    const ids = (item?.participantIds ?? []).filter((id) => typeof id === "string" && id !== "");
    const size = rubberSize(rubber.kind);
    if (ids.length !== size) {
      errors.push(`${title}需要 ${size} 名队员，当前 ${ids.length} 名`);
      continue;
    }
    if (new Set(ids).size !== ids.length) {
      errors.push(`${title}不能两个位置都选同一名队员`);
      continue;
    }
    const members = ids.map((id) => byId.get(id));
    if (members.some((member) => !member)) {
      errors.push(`${title}选择的队员不在本队名单中`);
      continue;
    }
    const chosen = members as LineupRosterMember[];
    const notEntered = chosen.filter((member) => !member.rubberKinds.includes(rubber.kind));
    if (notEntered.length) {
      errors.push(`${title}：${notEntered.map((member) => member.label).join("、")} 报名时没有报「${RUBBER_LABEL[rubber.kind]}」`);
      continue;
    }
    const gender = rubberGender(rubber.kind);
    if (gender === "MIXED") {
      const male = chosen.filter((member) => member.gender === "MALE").length;
      if (male !== 1) {
        errors.push(`${title}必须一男一女`);
        continue;
      }
    } else {
      const wrong = chosen.filter((member) => member.gender !== gender);
      if (wrong.length) {
        errors.push(`${title}只能由${GENDER_LABEL[gender]}队员出场`);
        continue;
      }
    }
    lineup.push({ order: rubber.order, kind: rubber.kind, participantIds: [...ids] });
  }

  if (!errors.length) errors.push(...appearanceErrors(lineup, roster, options));
  return errors.length ? { lineup: null, errors: [...new Set(errors)] } : { lineup, errors };
}

/**
 * 整份名单层面的约束：按性别的兼项上限、重叠小场不能同一人。
 * 裁判长只改一个小场时，把其余小场的现有名单一并传进来校验。
 */
export function appearanceErrors(
  lineup: readonly NormalizedLineupRubber[],
  roster: readonly LineupRosterMember[],
  options: LineupOptions = {},
): string[] {
  const errors: string[] = [];
  const byId = new Map(roster.map((member) => [member.participantId, member]));
  const limits = options.limits ?? NO_APPEARANCE_LIMITS;
  for (const [participantId, count] of appearanceCounts(lineup)) {
    const member = byId.get(participantId);
    if (!member) continue;
    const limit = limits[member.gender];
    if (limit !== null && count > limit) {
      errors.push(`${member.label} 在本场对抗里上了 ${count} 个小场，${GENDER_LABEL[member.gender]}队员最多 ${limit} 个`);
    }
  }
  const byOrder = new Map(lineup.map((rubber) => [rubber.order, rubber]));
  for (const [first, second] of options.overlappingOrders ?? []) {
    const left = byOrder.get(first);
    const right = byOrder.get(second);
    if (!left || !right) continue;
    const shared = left.participantIds.filter((id) => right.participantIds.includes(id));
    for (const id of shared) {
      errors.push(`第 ${first} 场与第 ${second} 场在赛程上同时进行，${byId.get(id)?.label ?? "同一名队员"} 不能两场都出场`);
    }
  }
  return errors;
}

/** 队员在一场对抗里上了几个小场，供负责人核对兼项与上限。 */
export function appearanceCounts(lineup: readonly NormalizedLineupRubber[]) {
  const counts = new Map<string, number>();
  for (const rubber of lineup) {
    for (const id of rubber.participantIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

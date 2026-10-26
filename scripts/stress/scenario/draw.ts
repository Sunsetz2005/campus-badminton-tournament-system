/**
 * 抽签（§4 第 4 步）：生成草稿（带种子与依据）→ 发布。发布接口同时为该项目生成赛程草稿（autoScheduleAfterDraw），
 * 结果原样记录；之后 schedule.ts 再对全部项目统一生成一次建议。
 */
import type { DrawFormat } from "../config/levels";
import type { RunContext, TournamentRuntime } from "./context";
import { addFinding } from "./context";

export interface DrawSettingsPlan {
  format: DrawFormat;
  groupCount?: number;
  qualifiersPerGroup?: 1 | 2;
  thirdPlaceMatch?: boolean;
  seeds?: number;
}

export async function publishDraws(context: RunContext, tournament: TournamentRuntime) {
  // 延后抽签的项目（M5）由赛务异常在运行中抽签，见 live/ops.ts。
  const plans: { code: string; settings: DrawSettingsPlan }[] = [
    ...tournament.plan.events.filter((event) => !event.deferDraw).map((event) => ({ code: event.code, settings: event })),
    ...(tournament.plan.team ? [{ code: tournament.plan.team.code, settings: tournament.plan.team }] : []),
  ];
  for (const { code, settings } of plans) await drawCompetition(context, tournament, code, settings);
}

/** 生成并发布一个项目的抽签；返回发布结果（对阵数、比赛数、自动排程状态）。 */
export async function drawCompetition(context: RunContext, tournament: TournamentRuntime, code: string, settings: DrawSettingsPlan) {
  const competition = tournament.competitions.get(code)!;
  const entryIds = [...competition.entryIdByKey.values()];
  const seeds = entryIds.slice(0, settings.seeds ?? 0).map((entryId, index) => ({ entryId, seedNo: index + 1, basis: "仿真设种：上届名次" }));
  const draft = await context.admin.must<{ drawId: string; conflicts: number }>(
    "POST",
    `/api/admin/tournaments/${tournament.slug}/competitions/${code}/draws`,
    {
      format: settings.format,
      groupCount: settings.format === "GROUPS_KNOCKOUT" ? settings.groupCount ?? 2 : null,
      qualifiersPerGroup: settings.qualifiersPerGroup ?? 2,
      thirdPlaceMatch: settings.thirdPlaceMatch ?? true,
      avoidSameUnit: true,
      seeds,
    },
    { route: "/api/admin/tournaments/[slug]/competitions/[code]/draws" },
  );
  if (draft.conflicts) {
    addFinding(context, { kind: "observation", area: "抽签", title: `${tournament.plan.key}/${code} 同单位回避无法完全满足`, detail: { conflicts: draft.conflicts } });
  }
  const published = await context.admin.must<{ matches: number; fixtures: number; schedule: { status: string } }>(
    "POST",
    `/api/admin/tournaments/${tournament.slug}/competitions/${code}/draws/${draft.drawId}/publish`,
    { confirm: true },
    { route: "/api/admin/tournaments/[slug]/competitions/[code]/draws/[drawId]/publish" },
  );
  context.log(`抽签发布 ${tournament.plan.key}/${code}：${published.fixtures} 个对阵、${published.matches} 场比赛，自动排程 ${published.schedule.status}`);
  return { ...published, conflicts: draft.conflicts };
}

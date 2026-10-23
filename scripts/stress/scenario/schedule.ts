/**
 * 赛程（§4 第 5 步）：设置时长与名单截止 → 场地 → 比赛日 → 自动建议 → 发布。
 * 发布要带「发布者确认过的警告摘要」；摘要只在赛程排班页上显示（没有 GET 接口），这里读取页面同源的
 * `loadScheduleWorkspace`（只读）取得，与操作员在页面上看到警告后点「发布」等价。
 */
import { loadScheduleWorkspace } from "../../../src/server/services/schedule-service";
import { ceilMinute, localDate, localDateTime } from "../core/time";
import type { RunContext, TournamentRuntime } from "./context";
import { addFinding } from "./context";

export async function configureSchedule(context: RunContext, tournament: TournamentRuntime, startsAt: Date) {
  const slug = tournament.slug;
  const profile = context.clock.profile;
  await context.admin.must("PATCH", `/api/admin/tournaments/${slug}/schedule/config`, {
    matchMinutes: profile.matchMinutes,
    rubberMinutes: profile.rubberMinutes,
    changeoverMinutes: profile.changeoverMinutes,
    knockoutTieCourts: Math.min(3, tournament.plan.courts),
    lineupDeadlineMinutes: profile.lineupDeadlineMinutes,
  }, { route: "/api/admin/tournaments/[slug]/schedule/config" });
  await context.admin.must("POST", `/api/admin/tournaments/${slug}/schedule/courts`, { count: tournament.plan.courts, namePrefix: "场地" }, {
    route: "/api/admin/tournaments/[slug]/schedule/courts",
  });
  const start = ceilMinute(startsAt);
  const nextDay = new Date(start.getTime() + 24 * 3600_000);
  const startTime = localDateTime(start).slice(11);
  await context.admin.must("POST", `/api/admin/tournaments/${slug}/schedule/days`, {
    days: [
      { date: localDate(start), start: startTime, end: "24:00" },
      { date: localDate(nextDay), start: "00:00", end: "24:00" },
    ],
  }, { route: "/api/admin/tournaments/[slug]/schedule/days" });
}

export async function suggestAndPublish(context: RunContext, tournament: TournamentRuntime, notBefore: Date, note: string) {
  const slug = tournament.slug;
  const suggestion = await context.admin.must<{ placed: number; unplaced: { reason: string; count: number }[]; hardCount: number; warningCount: number }>(
    "POST",
    `/api/admin/tournaments/${slug}/schedule/suggest`,
    { stage: "ALL", notBefore: localDateTime(ceilMinute(notBefore)), assignReferees: tournament.plan.refereeMode === "PER_MATCH" },
    { route: "/api/admin/tournaments/[slug]/schedule/suggest" },
  );
  if (suggestion.unplaced.length) {
    addFinding(context, { kind: "observation", area: "赛程", title: `${tournament.plan.key} 自动建议有未排入的比赛`, detail: { unplaced: suggestion.unplaced } });
  }
  const workspace = await loadScheduleWorkspace(tournament.id, new Date());
  const digest = (workspace as unknown as { warningDigest: string }).warningDigest;
  const published = await context.admin.call<{ version: number; matchCount: number }>(
    "POST",
    `/api/admin/tournaments/${slug}/schedule/publish`,
    { warningDigest: digest, note },
    { route: "/api/admin/tournaments/[slug]/schedule/publish" },
  );
  if (!published.ok) {
    addFinding(context, {
      kind: "blocked",
      area: "赛程",
      title: `${tournament.plan.key} 赛程发布被拒绝`,
      detail: { status: published.status, code: published.code, message: published.message, hard: suggestion.hardCount, warnings: suggestion.warningCount },
    });
    return null;
  }
  context.log(`赛程发布 ${tournament.plan.key}：第 ${published.json?.version} 版，排入 ${suggestion.placed} 场，警告 ${suggestion.warningCount}`);
  return published.json;
}

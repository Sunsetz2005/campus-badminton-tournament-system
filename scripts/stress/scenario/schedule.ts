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
  if (tournament.plan.refereeMode === "PER_MATCH") await adjustRefereeDraft(context, tournament);
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

export interface RefereeDraftRecord {
  suggested: Record<string, number>;
  reassigned: { code: string; from: string | null; to: string }[];
  overlaps: { first: string; second: string; referee: string }[];
  blockedPublish: { status: number; code: string | null; refereeOverlapIssues: number } | null;
  noReferee: number;
}

/**
 * 逐场指派模式的排班人工调整（§13.9 场景设定第 3 步）：
 * 1. 约 10% 的场次改给另一名在该时段空闲的裁判；
 * 2. 故意制造 2 处 REFEREE_OVERLAP（把一场改给同一时段正在另一块场地执裁的人），发布 → 预计被硬冲突拦截；
 * 3. 改回这 2 处，之后由调用方正式发布。
 */
async function adjustRefereeDraft(context: RunContext, tournament: TournamentRuntime) {
  const slug = tournament.slug;
  const rng = context.rng.fork(`referee-draft:${tournament.plan.key}`);
  const record: RefereeDraftRecord = { suggested: {}, reassigned: [], overlaps: [], blockedPublish: null, noReferee: 0 };
  let workspace = await loadScheduleWorkspace(tournament.id, new Date());
  const rows = workspace.draftRows.filter((row) => row.draft.start && row.movable);
  record.noReferee = rows.filter((row) => !row.draft.refereeId).length;
  for (const row of rows) if (row.draft.refereeId) record.suggested[row.draft.refereeId] = (record.suggested[row.draft.refereeId] ?? 0) + 1;
  const named = new Set(tournament.officials.map((official) => official.userId));
  const outsiders = Object.entries(record.suggested).filter(([id]) => !named.has(id));
  if (outsiders.length) {
    // 平台共用裁判账号在每个赛事自动带裁判员角色，逐场指派模式下自动建议也把它当作一名裁判分配。
    const labels = new Map(workspace.referees.map((referee) => [referee.id, referee.name]));
    addFinding(context, {
      kind: "design_undefined",
      area: "裁判排班",
      title: `逐场指派模式下自动建议把 ${outsiders.length} 个非本赛事开通的裁判账号（平台共用裁判账号）也当作具名裁判分配`,
      detail: { accounts: outsiders.map(([id, count]) => ({ name: labels.get(id) ?? id, matches: count })), note: "共用账号被指派的场次无法追溯到具体的人；仿真把它当作一名持场地平板的裁判照常执裁" },
    });
  }
  const referees = workspace.referees.map((referee) => referee.id);
  const interval = (row: (typeof rows)[number]) => [new Date(row.draft.start!).getTime(), new Date(row.draft.end!).getTime()] as const;
  const assignment = new Map(rows.map((row) => [row.code, row.draft.refereeId]));
  const busy = (referee: string, row: (typeof rows)[number], except: string) => {
    const [start, end] = interval(row);
    return rows.some((other) => other.code !== except && assignment.get(other.code) === referee && interval(other)[0] < end && start < interval(other)[1]);
  };
  const patch = (row: (typeof rows)[number], refereeUserId: string | null) =>
    context.admin.call("PATCH", `/api/admin/tournaments/${slug}/schedule/slots/${row.code}`, {
      courtCode: row.draft.courtCode,
      start: row.draft.startLocal,
      durationMinutes: row.draft.durationMinutes,
      refereeUserId,
      estimated: row.draft.estimated,
    }, { route: "/api/admin/tournaments/[slug]/schedule/slots/[matchCode]" });

  for (const row of rng.shuffle(rows).slice(0, Math.max(1, Math.round(rows.length * 0.1)))) {
    const to = rng.shuffle(referees).find((referee) => referee !== assignment.get(row.code) && !busy(referee, row, row.code));
    if (!to) continue;
    const result = await patch(row, to);
    if (result.ok) {
      record.reassigned.push({ code: row.code, from: assignment.get(row.code) ?? null, to });
      assignment.set(row.code, to);
    }
  }

  // 两处 REFEREE_OVERLAP：找时间重叠、不同场地的两场，把第二场改给第一场的裁判。
  const used = new Set<string>();
  const restore: { row: (typeof rows)[number]; referee: string | null }[] = [];
  for (const first of rows) {
    if (record.overlaps.length >= 2) break;
    const referee = assignment.get(first.code);
    if (!referee || used.has(first.code)) continue;
    const second = rows.find((other) => !used.has(other.code) && other.code !== first.code && other.draft.courtCode !== first.draft.courtCode && assignment.get(other.code) !== referee && interval(other)[0] < interval(first)[1] && interval(first)[0] < interval(other)[1]);
    if (!second) continue;
    const result = await patch(second, referee);
    if (!result.ok) continue;
    used.add(first.code).add(second.code);
    restore.push({ row: second, referee: assignment.get(second.code) ?? null });
    record.overlaps.push({ first: first.code, second: second.code, referee });
  }
  workspace = await loadScheduleWorkspace(tournament.id, new Date());
  const overlapIssues = workspace.draftCheck.issues.filter((issue) => issue.code === "REFEREE_OVERLAP").length;
  const blocked = await context.admin.call("POST", `/api/admin/tournaments/${slug}/schedule/publish`, { warningDigest: workspace.warningDigest, note: "仿真：含裁判冲突的草稿（预计被拦截）" }, {
    route: "/api/admin/tournaments/[slug]/schedule/publish",
  });
  record.blockedPublish = { status: blocked.status, code: blocked.code, refereeOverlapIssues: overlapIssues };
  if (record.overlaps.length && blocked.ok) {
    addFinding(context, { kind: "unexpected", area: "裁判排班", title: `${tournament.plan.key} 含 ${record.overlaps.length} 处同一裁判时间重叠的草稿被发布`, detail: { ...record } });
  } else if (record.overlaps.length) {
    context.log(`裁判冲突草稿发布被拦截：${blocked.status} ${blocked.code}（REFEREE_OVERLAP ${overlapIssues} 条）`);
  }
  for (const item of restore) await patch(item.row, item.referee);
  tournament.refereeDraft = record;
  context.log(`裁判排班调整：改派 ${record.reassigned.length} 场，制造冲突 ${record.overlaps.length} 处，未指派 ${record.noReferee} 场`);
}

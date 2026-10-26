/**
 * 单次运行的报告（report.md）。正式测试报告（知识库）在 M6 汇总多次运行后填写；这里只如实列出本次运行的事实。
 * 开头固定写明依赖声明（§13.8）与环境可信度（§13.5）。
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { CheckResult } from "../verify/checks";

interface Verification {
  golden: { passed: number; failed: { file: string; detail: string }[]; pending: string[] };
  tournaments: { key: string; slug: string; checks: CheckResult[]; delays?: Record<string, unknown> }[];
  passed: boolean;
}

interface RouteSummary {
  route: string;
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  statuses: Record<string, number>;
}

const KIND_LABEL: Record<string, string> = {
  blocked: "被阻断 / 预计卡住待分类",
  unexpected: "异常（待判定是否 bug）",
  observation: "观察记录",
  design_undefined: "设计未定义",
  script_error: "仿真脚本错误",
};

export function writeReport(runDir: string, run: Record<string, unknown>, verification: Verification) {
  const environment = (run.environment ?? {}) as Record<string, unknown>;
  const metrics = (run.metrics ?? { routes: [] }) as { total: number; serverErrors: number; rateLimited: number; durationMs: number; routes: RouteSummary[] };
  const findings = (run.findings ?? []) as { kind: string; area: string; title: string; detail: Record<string, unknown> }[];
  const matches = (run.matches ?? []) as { matchCode: string; outcome: string; reason?: string; startedAt: number; endedAt: number; commands: number }[];
  const reviews = (run.reviews ?? []) as { submittedSeenAt: number; confirmedAt: number | null }[];
  const server = (run.server ?? {}) as { log?: { unexpected: number; samples: string[] } };
  const lines: string[] = [];
  const push = (...items: string[]) => lines.push(...items);

  push(`# 并发仿真运行报告 ${String(run.runId)}`, "");
  push(
    "> **依赖声明**：本次仿真依赖提交 `9665321`（管理员为赛事指定裁判长）；该提交**尚未独立复验**，凡经 `chief-referees` 接口开通裁判长的路径，结论都以该提交的行为为前提。",
    ">",
    `> **环境**：${environment.sameMachine ? "压测端与被测服务**同机**运行，延迟数据可信度有限（§13.5）" : "压测端与被测服务分机运行"}；规模 ${environment.level}、时间档 ${environment.clock}、种子 ${environment.seed}；` +
      `来源地址 ${environment.distinctClientIps ? "每个模拟客户端各一个（x-forwarded-for）" : "全部共用一个"}。`,
    "",
  );
  if (verification.golden.pending.length || verification.golden.failed.length) {
    push(`> **oracle 尚未经人工用例核对**：人工核对用例 ${verification.golden.passed} 通过、${verification.golden.failed.length} 失败、${verification.golden.pending.length} 待填写。`, "");
  }

  push("## 结果", "", `- 运行结局：**${String(run.outcome)}**`);
  const status = run.finalStatus as { total: number; done: number; pendingReview: number; notStarted: number; groupsPending: number } | null;
  if (status) push(`- 比赛：${status.done}/${status.total} 场已锁定或未进行；待复核 ${status.pendingReview}；未开始 ${status.notStarted}；未确认小组 ${status.groupsPending}`);
  push(`- 执裁：${matches.filter((item) => item.outcome === "submitted").length}/${matches.length} 场由仿真打完并提交`);
  const reviewWaits = reviews.filter((item) => item.confirmedAt).map((item) => (item.confirmedAt! - item.submittedSeenAt) / 1000).sort((a, b) => a - b);
  if (reviewWaits.length) push(`- 复核排队（看到待复核 → 锁定）：中位 ${reviewWaits[Math.floor(reviewWaits.length / 2)].toFixed(1)} 秒，最长 ${reviewWaits[reviewWaits.length - 1].toFixed(1)} 秒`);
  push(`- 请求：${metrics.total} 次，5xx ${metrics.serverErrors}，429 ${metrics.rateLimited}；服务端日志可疑行 ${server.log?.unexpected ?? 0}`, "");

  // 系统发现：本轮每一次 5xx（重试成功也不抵消）+ 已知系统问题的排查结论（知识库，只读排查所得）。
  push("## 系统发现", "");
  push("> 已知问题与写入路径排查见知识库 `05-测试验收/并发仿真-系统发现.md`（SF-01：事务冲突 P2034 未重试即返回 500，严重度高）。", "");
  const serverErrorLog = ((run.metrics as { serverErrorLog?: { at: number; actor: string; method: string; route: string; status: number; code: string | null; note?: string }[] } | undefined)?.serverErrorLog) ?? [];
  if (!serverErrorLog.length) push("- 本轮没有 5xx。");
  else {
    push(`本轮 5xx 共 ${serverErrorLog.length} 次：`, "", "| 时间（UTC） | 接口 | 状态 | 错误码 | 客户端 | 备注 |", "|---|---|---|---|---|---|");
    for (const entry of serverErrorLog) push(`| ${new Date(entry.at).toISOString().slice(11, 19)} | ${entry.method} ${entry.route} | ${entry.status} | ${entry.code ?? ""} | ${entry.actor} | ${entry.note ?? ""} |`);
  }
  const serverSide = (server.log?.samples ?? []).filter((line) => /"status":5\d\d/.test(line));
  if (serverSide.length) {
    push("", "服务端日志中的对应记录（截断至 300 字符）：", "");
    for (const line of serverSide) push(`- \`${line.replace(/`/g, "'")}\``);
  }
  const lineupRetries = findings.filter((item) => item.area === "出场名单" && /5\d\d|重试|500 \+ 截止/.test(item.title));
  if (lineupRetries.length) {
    push("", "负责人遇到 5xx 后的处理：", "");
    for (const item of lineupRetries) push(`- [${item.kind}] ${item.title}`);
  }
  push("");

  push("## 自动判定", "", "| 赛事 | 判定 | 结果 | 检查数 | 失败 |", "|---|---|---|---|---|");
  for (const tournament of verification.tournaments) {
    for (const check of tournament.checks) push(`| ${tournament.key} | ${check.title} | ${check.passed ? "通过" : "**失败**"} | ${check.checked} | ${check.failures.length} |`);
  }
  push("");
  for (const tournament of verification.tournaments) {
    for (const check of tournament.checks.filter((item) => item.failures.length || item.notes.length)) {
      push(`### ${tournament.key} · ${check.title}`, "");
      for (const failure of check.failures.slice(0, 30)) push(`- ✗ \`${failure.subject}\`：${failure.detail}`);
      if (check.failures.length > 30) push(`- ……另有 ${check.failures.length - 30} 处，见 verify.json`);
      for (const note of check.notes.slice(0, 10)) push(`- 注：${note}`);
      push("");
    }
  }

  const probes = (run.probes ?? []) as { id: string; group: string; title: string; expected: string; actual: string; verdict: string; match?: string }[];
  if (probes.length) {
    const tally = new Map<string, number>();
    for (const item of probes) tally.set(item.verdict, (tally.get(item.verdict) ?? 0) + 1);
    push("## 异常注入（期望 / 实际）", "", `- ${[...tally].map(([verdict, count]) => `${verdict} ${count}`).join("，")}`, "");
    const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
    for (const group of [...new Set(probes.map((item) => item.group))]) {
      push(`### ${group}`, "", "| 编号 | 注入 | 期望 | 实际 | 结论 | 场次 |", "|---|---|---|---|---|---|");
      for (const item of probes.filter((probe) => probe.group === group)) {
        push(`| ${item.id} | ${cell(item.title)} | ${cell(item.expected)} | ${cell(item.actual)} | ${item.verdict} | ${item.match ?? ""} |`);
      }
      push("");
    }
  }

  const finalStatus = run.finalStatus as { expectedStuck?: { tournament: string; code: string; competition: string; sides: string; reason: string }[] } | null;
  if (finalStatus?.expectedStuck?.length) {
    push("## 预计卡住（§6 已知缺口，未计入未完成）", "");
    const byReason = new Map<string, string[]>();
    for (const item of finalStatus.expectedStuck) byReason.set(`${item.tournament}/${item.competition}：${item.reason}`, [...(byReason.get(`${item.tournament}/${item.competition}：${item.reason}`) ?? []), `${item.code}(${item.sides})`]);
    for (const [reason, codes] of byReason) push(`- ${reason}——${codes.length} 场：${codes.slice(0, 20).join("、")}${codes.length > 20 ? " ……" : ""}`);
    push("");
  }
  const ops = run.ops as { exclusions: { competition: string; group: string; reason: string; status: number; code: string | null }[] } | null | undefined;
  if (ops?.exclusions.length) {
    push("## 裁判长排除（§6.1）", "", "| 项目/小组 | 原因 | 回应 |", "|---|---|---|");
    for (const item of ops.exclusions) push(`| ${item.competition}/${item.group} | ${item.reason} | ${item.status}${item.code ? ` ${item.code}` : ""} |`);
    push("");
  }
  const auth = run.auth as { total: number; rateLimited: number; failed: number; groups: { key: string; count: number; rateLimited: number; limitedRequests: number; medianMs: number; maxMs: number; spanMs: number }[] } | undefined;
  if (auth?.total) {
    push("## 登录与改口令（§13.2 / §13.9）", "", `- 共 ${auth.total} 次，被限流（429）${auth.rateLimited} 次，最终失败 ${auth.failed} 次`, "", "| 类别 | 次数 | 遇到 429 的次数 | 429 合计 | 耗时中位 / 最长（秒） | 首末跨度（秒） |", "|---|---|---|---|---|---|");
    for (const item of auth.groups) push(`| ${item.key} | ${item.count} | ${item.limitedRequests} | ${item.rateLimited} | ${(item.medianMs / 1000).toFixed(1)} / ${(item.maxMs / 1000).toFixed(1)} | ${(item.spanMs / 1000).toFixed(0)} |`);
    push("");
  }
  const publicRoutes = metrics.routes.filter((item) => item.route.includes("/api/public/"));
  if (publicRoutes.some((item) => Object.keys(item.statuses).some((key) => key.startsWith("429")))) {
    push("## 公开接口限流（§13.2）", "", "| 接口 | 次数 | 状态分布 |", "|---|---|---|");
    for (const item of publicRoutes) push(`| ${item.route} | ${item.count} | ${Object.entries(item.statuses).map(([key, count]) => `${key}×${count}`).join("、")} |`);
    const writes429 = metrics.routes.filter((item) => item.route.includes("/api/matches/") && Object.keys(item.statuses).some((key) => key.startsWith("429")));
    push("", `- 裁判写接口（/api/matches/*）出现 429：${writes429.length ? writes429.map((item) => item.route).join("、") : "没有"}`, "");
  }
  const sessions = run.sessions as { authSessionsPeak: number; scoringSessionsPeak: number } | undefined;
  if (sessions) push(`- 登录会话峰值（本次运行的裁判账号）${sessions.authSessionsPeak}，活动控制会话峰值 ${sessions.scoringSessionsPeak}`, "");

  push("## 计划与实际偏差（分钟，只统计不判错）", "");
  for (const tournament of verification.tournaments) {
    if (!tournament.delays) continue;
    const d = tournament.delays as { startLagMinutes: unknown; endLagMinutes: unknown; actualDurationMinutes: unknown; earlyStarts: number; lateOverFiveMinutes: number };
    push(`- ${tournament.key}：开始偏差 ${JSON.stringify(d.startLagMinutes)}；结束偏差 ${JSON.stringify(d.endLagMinutes)}；实际时长 ${JSON.stringify(d.actualDurationMinutes)}；提前开赛 ${d.earlyStarts} 场，晚开超过 5 分钟 ${d.lateOverFiveMinutes} 场`);
  }
  push("");
  const tournamentsRun = (run.tournaments ?? []) as {
    key: string;
    refereeMode: string;
    delayScenarios?: { id: string; title: string; constructed: boolean; causes: string[]; watch: string[]; expected: string; note?: string; action?: Record<string, unknown>; observed?: Record<string, unknown> }[];
    rotation?: {
      officials: { key: string; matches: number; officiatingMinutes: number; longestStreak: number; restSeconds: number[]; waitedSeconds: number }[];
      matchesPerOfficial: { min: number; median: number; max: number } | null;
      unused: string[];
      handover?: { count: number; medianMs: number; maxMs: number; rateLimited: number } | null;
      relogin?: { count: number; byKind: Record<string, number[]> } | null;
    };
    refereeDraft?: { reassigned: unknown[]; overlaps: unknown[]; blockedPublish: { status: number; code: string | null; refereeOverlapIssues: number } | null; noReferee: number; suggested: Record<string, number> } | null;
  }[];
  for (const tournament of tournamentsRun.filter((item) => item.delayScenarios?.length)) {
    push(`## 延误七情形（${tournament.key}，期望 / 实际）`, "");
    for (const item of tournament.delayScenarios!) {
      push(`### ${item.id} ${item.title}${item.constructed ? "" : "（未构造 / 未触发）"}`, "", `- 期望：${item.expected}`);
      if (item.note) push(`- 说明：${item.note}`);
      if (item.causes.length) push(`- 注入：${item.causes.join("、")}`);
      if (item.action) push(`- 操作：\`${JSON.stringify(item.action)}\``);
      const observed = item.observed ?? {};
      for (const cause of (observed.causes as { code: string; plannedMinutes: number | null; actualMinutes: number | null; overrunSeen: boolean }[] | undefined) ?? []) {
        push(`- 注入场 ${cause.code}：计划 ${cause.plannedMinutes ?? "—"} 分钟，实际 ${cause.actualMinutes ?? "—"} 分钟，系统看到超时 ${cause.overrunSeen ? "是" : "否"}`);
      }
      const watch = (observed.watch as { code: string; startLagMinutes: number | null; delayedShown: boolean; maxDelayMinutes: number; causes: string[]; evidenced: boolean; publicShownDelayed: boolean }[] | undefined) ?? [];
      if (watch.length) {
        push("", "| 观察场 | 实际开始偏差（分） | 系统标延误 | 最大延误（分） | 原因 | 有据 | 公开显示延误 |", "|---|---|---|---|---|---|---|");
        for (const row of watch) push(`| ${row.code} | ${row.startLagMinutes ?? "未开赛"} | ${row.delayedShown ? "是" : "否"} | ${row.maxDelayMinutes} | ${row.causes.join("/") || "—"} | ${row.evidenced ? "是" : "否"} | ${row.publicShownDelayed ? "是" : "否"} |`);
      }
      for (const key of ["timeline", "window", "lagByRound", "lineup"]) if (observed[key]) push(`- ${key}：\`${JSON.stringify(observed[key])}\``);
      push("");
    }
  }
  for (const tournament of tournamentsRun.filter((item) => item.rotation?.officials.length)) {
    const rotation = tournament.rotation!;
    push(`## 裁判轮换（${tournament.key}，${tournament.refereeMode === "PER_MATCH" ? "逐场指派、个人设备" : "共用账号、场地平板，执裁人只在仿真内部可知"}）`, "");
    if (rotation.matchesPerOfficial) push(`- 每人执裁场数：最少 ${rotation.matchesPerOfficial.min}、中位 ${rotation.matchesPerOfficial.median}、最多 ${rotation.matchesPerOfficial.max}；未上场 ${rotation.unused.length} 人`);
    const longest = Math.max(0, ...rotation.officials.map((item) => item.longestStreak));
    const rests = rotation.officials.flatMap((item) => item.restSeconds).sort((a, b) => a - b);
    push(`- 最长连续执裁 ${longest} 场；休息 ${rests.length} 次，时长中位 ${rests[Math.floor(rests.length / 2)] ?? "—"} 秒`);
    const waited = rotation.officials.reduce((sum, item) => sum + item.waitedSeconds, 0);
    if (tournament.refereeMode === "PER_MATCH") push(`- 场地等指派裁判到场累计 ${waited} 秒（系统的延误推算只沿裁判上一场的结束时间，不知道休息）`);
    if (rotation.handover) push(`- 场地平板交接（退出上一人 + 本人登录）${rotation.handover.count} 次：中位 ${(rotation.handover.medianMs / 1000).toFixed(1)} 秒、最长 ${(rotation.handover.maxMs / 1000).toFixed(1)} 秒，交接时登录被限流 ${rotation.handover.rateLimited} 次`);
    if (rotation.relogin) push(`- 个人设备重新登录 ${rotation.relogin.count} 次：${Object.entries(rotation.relogin.byKind).map(([kind, values]) => `${kind === "sign-out" ? "退出后登录" : "清空 Cookie 后登录"} ${values.length} 次${values.length ? `（最长 ${(Math.max(...values) / 1000).toFixed(1)} 秒）` : ""}`).join("，")}`);
    const draft = tournament.refereeDraft;
    if (draft) {
      push(`- 排班：自动建议给 ${Object.keys(draft.suggested).length} 人分配，未指派 ${draft.noReferee} 场；人工改派 ${draft.reassigned.length} 场；制造冲突 ${draft.overlaps.length} 处，含冲突草稿发布结果 ${draft.blockedPublish ? `${draft.blockedPublish.status} ${draft.blockedPublish.code ?? ""}（REFEREE_OVERLAP ${draft.blockedPublish.refereeOverlapIssues} 条）` : "—"}`);
    }
    push("", "| 裁判 | 场数 | 执裁分钟 | 最长连续 | 休息次数 |", "|---|---|---|---|---|");
    for (const item of rotation.officials) push(`| ${item.key} | ${item.matches} | ${item.officiatingMinutes} | ${item.longestStreak} | ${item.restSeconds.length} |`);
    push("");
  }
  if (String(run.outcome) === "host_paused") push("> **本次运行无效**：检测到宿主暂停（本机睡眠），租约在暂停期间过期，相关发现不代表系统问题。", "");
  push("## 发现", "");
  if (!findings.length) push("本次运行没有记录到发现。", "");
  for (const [kind, label] of Object.entries(KIND_LABEL)) {
    const items = findings.filter((item) => item.kind === kind);
    if (!items.length) continue;
    push(`### ${label}（${items.length}）`, "");
    for (const item of items.slice(0, 40)) push(`- [${item.area}] ${item.title}`);
    push("");
  }

  push("## 接口延迟（毫秒）", "", "| 接口 | 次数 | P50 | P95 | P99 | 最大 | 状态分布 |", "|---|---|---|---|---|---|---|");
  for (const route of metrics.routes.slice(0, 30)) {
    push(`| \`${route.route}\` | ${route.count} | ${route.p50} | ${route.p95} | ${route.p99} | ${route.max} | ${Object.entries(route.statuses).map(([key, value]) => `${key}×${value}`).join(" ")} |`);
  }
  push("");
  writeFileSync(path.join(runDir, "report.md"), `${lines.join("\n")}\n`);
}

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

  push("## 计划与实际偏差（分钟，只统计不判错）", "");
  for (const tournament of verification.tournaments) {
    if (!tournament.delays) continue;
    const d = tournament.delays as { startLagMinutes: unknown; endLagMinutes: unknown; actualDurationMinutes: unknown; earlyStarts: number; lateOverFiveMinutes: number };
    push(`- ${tournament.key}：开始偏差 ${JSON.stringify(d.startLagMinutes)}；结束偏差 ${JSON.stringify(d.endLagMinutes)}；实际时长 ${JSON.stringify(d.actualDurationMinutes)}；提前开赛 ${d.earlyStarts} 场，晚开超过 5 分钟 ${d.lateOverFiveMinutes} 场`);
  }
  push("");
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

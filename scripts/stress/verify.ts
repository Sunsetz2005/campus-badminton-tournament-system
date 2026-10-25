/**
 * 对已有运行重跑判定（只读）：
 *   pnpm run stress:verify -- --run artifacts/stress/<目录>
 * run.ts 结束时也调用同一个 verifyRun。判定前先跑 oracle 的人工核对用例（§13.6），失败即停止排名类判定。
 */
import "./core/readonly-env";

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { prisma } from "./core/db";
import { runManualGoldenCases } from "./oracle/golden";
import { writeReport } from "./report/write";
import { checkRanking, runAll, type CheckResult } from "./verify/checks";
import { loadTournamentData } from "./verify/data";
import { checkForcedTies, checkOfficials } from "./verify/scenarios";
import { delayStats } from "./verify/delays";

export interface RunResultFile {
  outcome: string;
  runId: string;
  tournaments: {
    key: string;
    slug: string;
    rulePreset: string;
    refereeMode: string;
    tieScenarios?: Parameters<typeof checkForcedTies>[1];
    officials?: Parameters<typeof checkOfficials>[1];
  }[];
  matches: { matchCode: string; acceptedCommandIds?: string[]; officialUserId?: string; outcome?: string; officialSegments?: { userId: string; from: number }[] }[];
  reviews: { matchCode: string; commandId?: string | null }[];
  [key: string]: unknown;
}

export async function verifyRun(runDir: string, run: RunResultFile) {
  const golden = runManualGoldenCases();
  const accepted = new Map<string, Set<string>>();
  for (const match of run.matches) {
    if (!match.acceptedCommandIds) continue;
    const set = accepted.get(match.matchCode) ?? new Set<string>();
    for (const id of match.acceptedCommandIds ?? []) set.add(id);
    accepted.set(match.matchCode, set);
  }
  for (const review of run.reviews) {
    if (!review.commandId || !accepted.has(review.matchCode)) continue;
    const set = accepted.get(review.matchCode) ?? new Set<string>();
    set.add(review.commandId);
    accepted.set(review.matchCode, set);
  }
  const perTournament: { key: string; slug: string; checks: CheckResult[]; delays: ReturnType<typeof delayStats> }[] = [];
  for (const tournament of run.tournaments) {
    const data = await loadTournamentData(tournament.slug);
    // 只有本次仿真执裁过的比赛才做请求↔事件对应；其余比赛（未开赛）在 events 检查里只看版本连续。
    const checks = runAll(data, accepted);
    if (golden.failed.length === 0) checks.push(await checkRanking(data));
    else checks.push({ name: "ranking", title: "小组名次、淘汰签位与最终名次独立重算", passed: false, checked: 0, failures: golden.failed.map((item) => ({ subject: item.file, detail: `人工核对用例未通过：${item.detail}` })), notes: ["oracle 未通过人工核对用例，排名类判定停止"] });
    if (tournament.tieScenarios) checks.push(checkForcedTies(data, tournament.tieScenarios));
    if (tournament.officials) {
      const submitted = run.matches.filter((match) => match.officialUserId && match.outcome === "submitted");
      const matchOfficials = new Map(submitted.filter((match) => !match.officialSegments).map((match) => [match.matchCode, match.officialUserId!]));
      const segments = new Map(submitted.filter((match) => match.officialSegments).map((match) => [match.matchCode, match.officialSegments!]));
      checks.push(checkOfficials(data, tournament.officials, matchOfficials, segments));
    }
    perTournament.push({ key: tournament.key, slug: tournament.slug, checks, delays: delayStats(data) });
  }
  const verification = { verifiedAt: new Date().toISOString(), golden, tournaments: perTournament, passed: perTournament.every((item) => item.checks.every((check) => check.passed)) };
  writeFileSync(path.join(runDir, "verify.json"), JSON.stringify(verification, null, 2));
  writeReport(runDir, run, verification);
  return verification;
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith("verify")) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((item) => item !== "--"), options: { run: { type: "string" } } });
  if (!values.run) throw new Error("用法：pnpm run stress:verify -- --run artifacts/stress/<目录>");
  const runDir = path.resolve(values.run);
  const run = JSON.parse(readFileSync(path.join(runDir, "result.json"), "utf8")) as RunResultFile;
  verifyRun(runDir, run)
    .then((verification) => {
      for (const tournament of verification.tournaments) {
        for (const check of tournament.checks) console.info(`${tournament.key} ${check.passed ? "通过" : "失败"} ${check.title}（${check.checked} 项，${check.failures.length} 处失败）`);
      }
      console.info(`人工核对用例：${verification.golden.passed} 通过、${verification.golden.failed.length} 失败、${verification.golden.pending.length} 待填写`);
      console.info(verification.passed ? "判定全部通过" : "判定有失败，见 verify.json / report.md");
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

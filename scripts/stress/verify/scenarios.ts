/**
 * M3 增加的判定：
 *
 * 8 forced-ties  强制同分是否真的形成，系统是否按期望识别（T1/T3 须抽签，T2 由净胜分决出 X、Z、Y）。
 *                「真的形成」由逐局指定比分保证；若没形成，先怀疑仿真脚本，再看系统。
 * 9 officials    §13.9 判定补充 1、2：
 *                - 同一名裁判（仿真内部的人）任何时刻只在一场进行中的比赛里执裁（仿真自身不变量）；
 *                - 逐场指派模式：按 MatchEvent.actorUserId 与 occurredAt 构造每个账号的执裁区间，两两不重叠；
 *                  每场的执裁事件全部来自仿真记录的那名裁判；结果提交（ResultRevision.actorUserId）也是他；
 *                - 共用账号模式：系统侧无法核对，标注设计未定义（不算失败）。
 */
import type { CheckResult } from "./checks";
import type { TournamentData } from "./data";

interface TieScenarioRecord {
  id: string;
  competition: string;
  group: string;
  cycle: string[];
  expect: string;
}

interface OfficialRecord {
  key: string;
  userId: string;
  log: { matchCode: string; start: number; end: number; outcome: string }[];
}

function result(name: string, title: string): CheckResult {
  return { name, title, passed: true, checked: 0, failures: [], notes: [] };
}

function fail(check: CheckResult, subject: string, detail: string) {
  check.passed = false;
  if (check.failures.length < 200) check.failures.push({ subject, detail });
}

export function checkForcedTies(data: TournamentData, scenarios: TieScenarioRecord[]): CheckResult {
  const check = result("forced-ties", "强制同分形成并被系统正确识别");
  if (!scenarios.length) {
    check.notes.push("本次运行没有构造强制同分");
    return check;
  }
  for (const scenario of scenarios) {
    const competition = data.competitions.find((item) => item.code === scenario.competition);
    const group = data.groups.find((item) => item.code === scenario.group && item.stage.competitionId === competition?.id);
    const subject = `${scenario.id} ${scenario.competition}/${scenario.group}`;
    check.checked += 1;
    const stored = group?.ranking as { order?: string[]; lots?: string[][] } | null | undefined;
    if (!group?.rankingConfirmedAt || !stored?.order) {
      fail(check, subject, "名次未确认，无法核对");
      continue;
    }
    const cycle = [...scenario.cycle].sort().join(",");
    const lots = (stored.lots ?? []).map((block) => [...block].sort().join(","));
    if (scenario.id === "T2") {
      const [x, y, z] = scenario.cycle;
      const positions = [x, z, y].map((id) => stored.order!.indexOf(id));
      if (lots.some((block) => scenario.cycle.some((id) => block.includes(id)))) fail(check, subject, `不应要求抽签，系统并列块 ${lots.join(" | ")}`);
      else if (!(positions[0] < positions[1] && positions[1] < positions[2])) fail(check, subject, `顺序应为 X、Z、Y（净胜分 +18、−8、−10），实际位置 ${positions.join("、")}`);
      else check.notes.push(`${subject}：按净胜分决出 X、Z、Y，未要求抽签`);
    } else if (!lots.includes(cycle)) {
      fail(check, subject, `应形成三方须抽签的并列，系统并列块 [${lots.join(" | ") || "无"}]`);
    } else {
      check.notes.push(`${subject}：系统列出三方并列待裁定，裁判长抽签后确认`);
    }
  }
  return check;
}

export function checkOfficials(data: TournamentData, officials: OfficialRecord[], matchOfficials: Map<string, string>): CheckResult {
  const check = result("officials", "同一名裁判不同时执裁两场；执裁人与实际一致");
  // 1. 仿真自身：同一人的执裁区间不重叠。
  for (const official of officials) {
    const intervals = official.log.filter((entry) => entry.outcome !== "not_started").sort((x, y) => x.start - y.start);
    for (let index = 1; index < intervals.length; index += 1) {
      check.checked += 1;
      if (intervals[index].start < intervals[index - 1].end) fail(check, `仿真 ${official.key}`, `${intervals[index - 1].matchCode} 与 ${intervals[index].matchCode} 时间重叠（脚本错误）`);
    }
  }
  if (data.tournament.refereeMode !== "PER_MATCH") {
    const sessions = new Map<string, Set<string>>();
    for (const event of data.events) if (event.scoringSessionId) sessions.set(event.matchId, new Set([...(sessions.get(event.matchId) ?? []), event.scoringSessionId]));
    check.notes.push(`共用账号模式：系统侧只能追溯到设备（scoringSessionId），无法核对是哪名裁判——设计未定义（§13.9）。${sessions.size} 场共出现 ${[...sessions.values()].reduce((sum, set) => sum + set.size, 0)} 个控制会话`);
    return check;
  }
  // 2. 系统侧：每个账号的执裁区间（排除裁判长复核的 CONFIRM_RESULT / REOPEN_RESULT）。
  const codeById = new Map(data.matches.map((match) => [match.id, match.code]));
  const reviewTypes = new Set(["CONFIRM_RESULT", "REOPEN_RESULT"]);
  const spans = new Map<string, { code: string; start: number; end: number }[]>();
  const actorsByMatch = new Map<string, Set<string>>();
  const perMatch = new Map<string, { actor: string; start: number; end: number }>();
  for (const event of data.events) {
    if (reviewTypes.has(event.type) || !event.actorUserId) continue;
    const code = codeById.get(event.matchId)!;
    actorsByMatch.set(code, new Set([...(actorsByMatch.get(code) ?? []), event.actorUserId]));
    const key = `${code}:${event.actorUserId}`;
    const at = event.occurredAt.getTime();
    const span = perMatch.get(key) ?? { actor: event.actorUserId, start: at, end: at };
    span.start = Math.min(span.start, at);
    span.end = Math.max(span.end, at);
    perMatch.set(key, span);
  }
  for (const [key, span] of perMatch) spans.set(span.actor, [...(spans.get(span.actor) ?? []), { code: key.split(":")[0], start: span.start, end: span.end }]);
  for (const [actor, list] of spans) {
    list.sort((x, y) => x.start - y.start);
    for (let index = 1; index < list.length; index += 1) {
      check.checked += 1;
      if (list[index].start < list[index - 1].end) fail(check, `账号 ${actor.slice(0, 8)}`, `${list[index - 1].code} 与 ${list[index].code} 执裁区间重叠`);
    }
  }
  // 3. 执裁人 = 仿真记录的那名裁判；提交人也是他。
  for (const [code, officialUserId] of matchOfficials) {
    const actors = actorsByMatch.get(code);
    if (!actors) continue;
    check.checked += 1;
    if (actors.size !== 1 || !actors.has(officialUserId)) fail(check, code, `执裁事件的账号 ${[...actors].map((id) => id.slice(0, 8)).join("、")}，仿真记录 ${officialUserId.slice(0, 8)}`);
    const match = data.matches.find((item) => item.code === code);
    const submitted = data.revisions.filter((revision) => revision.matchId === match?.id).sort((x, y) => x.revision - y.revision)[0];
    if (submitted) {
      check.checked += 1;
      if (submitted.actorUserId !== officialUserId) fail(check, code, `结果提交人 ${submitted.actorUserId?.slice(0, 8)} ≠ 实际执裁 ${officialUserId.slice(0, 8)}`);
    }
  }
  return check;
}

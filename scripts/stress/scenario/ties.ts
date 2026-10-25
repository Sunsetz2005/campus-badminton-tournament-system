/**
 * 强制同分（M2 检查点确认的补强）：随机走向下小组几乎不出现「规则都无法区分」的并列，判定只覆盖了无并列的路径。
 * 抽签发布后、开赛前，挑选小组并逐局指定比分（SCRIPT 走向），让下面三种情形必然出现：
 *
 *   T1 个人项目完全同分：组内三方循环相克（X 胜 Y、Y 胜 Z、Z 胜 X），比分完全相同；
 *      组内其余单位全负、比分也相同 → 胜场、净胜局、净胜分全部相同 → 须抽签（§6.5）。
 *   T2 个人项目三方同胜场、净胜分区分：同样三方循环，但三场比分不同 → 净胜局相同、净胜分决出顺序。
 *   T3 团体项目完全同分：三队循环相克，每场对抗 2:1 且各小场比分相同；其余队伍 0:3 全负 → 须抽签。
 *
 * 期望顺序由 oracle 独立计算；这里只负责制造局面，并把「应当出现的并列」写进记录，供判定核对系统是否同样识别为并列。
 */
import { fixturesOf, groupsOf, matchesOfTournament } from "../core/db";
import type { ForcedNarrative } from "../live/narrative";
import type { RunContext, TournamentRuntime } from "./context";

export interface TieScenario {
  id: "T1" | "T2" | "T3";
  competition: string;
  group: string;
  cycle: string[];
  others: string[];
  expect: string;
  matches: string[];
}

type Score = { A: number; B: number };

/** 胜方逐局比分（胜方在前）→ 按本场 A/B 方向翻成 A/B 视角。 */
function oriented(games: [number, number][], winnerIsA: boolean): Score[] {
  return games.map(([w, l]) => (winnerIsA ? { A: w, B: l } : { A: l, B: w }));
}

export async function planForcedTies(context: RunContext, tournament: TournamentRuntime) {
  const scenarios: TieScenario[] = [];
  const matches = await matchesOfTournament(tournament.id);
  const groupCode = new Map<string, string>();
  for (const competition of tournament.competitions.values()) {
    for (const group of await groupsOf(competition.id)) groupCode.set(group.id, `${competition.code}/${group.code}`);
  }

  // 个人项目：按组收集组内比赛与参赛单位。
  const individualGroups = new Map<string, { entries: string[]; matches: typeof matches }>();
  for (const match of matches) {
    if (!match.groupId || match.rubberKind || !match.sideAEntryId || !match.sideBEntryId) continue;
    const bucket = individualGroups.get(match.groupId) ?? { entries: [], matches: [] };
    for (const id of [match.sideAEntryId, match.sideBEntryId]) if (!bucket.entries.includes(id)) bucket.entries.push(id);
    bucket.matches.push(match);
    individualGroups.set(match.groupId, bucket);
  }
  // 大组优先；同一项目只造一种，尽量分散到不同项目。
  const candidates = [...individualGroups.entries()].filter(([, group]) => group.entries.length >= 3).sort((x, y) => y[1].entries.length - x[1].entries.length);
  const usedCompetitions = new Set<string>();
  const plans: { id: "T1" | "T2"; cycleGames: [[number, number][], [number, number][], [number, number][]]; expect: string }[] = [
    {
      id: "T1",
      cycleGames: [[[21, 15], [21, 15]], [[21, 15], [21, 15]], [[21, 15], [21, 15]]],
      expect: "三方胜场、净胜局、净胜分全部相同 → 系统应列为并列待裁定（须抽签），三者占据第 1—3 名的位置",
    },
    {
      id: "T2",
      cycleGames: [[[21, 10], [21, 10]], [[21, 15], [21, 15]], [[21, 19], [21, 19]]],
      expect: "三方胜场相同、净胜局相同，净胜分 X +18、Z −8、Y −10 → 顺序 X、Z、Y，不应要求抽签",
    },
  ];
  for (const plan of plans) {
    const pick = candidates.find(([groupId]) => !usedCompetitions.has(groupCode.get(groupId)!.split("/")[0]));
    if (!pick) {
      context.log(`强制同分 ${plan.id}：没有可用的小组（需要至少 3 个单位），未构造`);
      continue;
    }
    const [groupId, group] = pick;
    const label = groupCode.get(groupId)!;
    usedCompetitions.add(label.split("/")[0]);
    candidates.splice(candidates.indexOf(pick), 1);
    const [x, y, z, ...others] = context.rng.fork(`ties:${plan.id}`).shuffle(group.entries);
    const cycle: [string, string, [number, number][]][] = [[x, y, plan.cycleGames[0]], [y, z, plan.cycleGames[1]], [z, x, plan.cycleGames[2]]];
    const codes: string[] = [];
    for (const match of group.matches) {
      const pair = [match.sideAEntryId!, match.sideBEntryId!];
      const inCycle = cycle.find(([winner, loser]) => pair.includes(winner) && pair.includes(loser));
      let spec: ForcedNarrative;
      if (inCycle) {
        spec = { kind: "SCRIPT", games: oriented(inCycle[2], match.sideAEntryId === inCycle[0]), why: `${plan.id} 循环相克` };
      } else {
        // 一方是循环中的单位、另一方是其余单位：循环单位 2:0 胜，比分全组一致；其余单位之间随便打一场 2:0。
        const winnerIsA = [x, y, z].includes(match.sideAEntryId!) || ![x, y, z].includes(match.sideBEntryId!);
        spec = { kind: "SCRIPT", games: oriented([[21, 10], [21, 10]], winnerIsA), why: `${plan.id} 陪打` };
      }
      tournament.forced.set(match.code, spec);
      codes.push(match.code);
    }
    scenarios.push({ id: plan.id, competition: label.split("/")[0], group: label.split("/")[1], cycle: [x, y, z], others, expect: plan.expect, matches: codes });
    context.log(`强制同分 ${plan.id}：${label}（${group.entries.length} 个单位，${codes.length} 场指定比分）`);
  }

  // 团体项目：三队循环，每场对抗 2:1（胜方赢第 1、3 小场，负方赢第 2 小场），各小场 21:15 21:15。
  const team = tournament.plan.team;
  if (team) {
    const competition = tournament.competitions.get(team.code)!;
    const fixtures = (await fixturesOf(competition.id)).filter((fixture) => fixture.groupId && fixture.sideAEntryId && fixture.sideBEntryId);
    const byGroup = new Map<string, typeof fixtures>();
    for (const fixture of fixtures) byGroup.set(fixture.groupId!, [...(byGroup.get(fixture.groupId!) ?? []), fixture]);
    const pick = [...byGroup.entries()]
      .map(([groupId, list]) => ({ groupId, list, entries: [...new Set(list.flatMap((fixture) => [fixture.sideAEntryId!, fixture.sideBEntryId!]))] }))
      .filter((group) => group.entries.length >= 3)
      .sort((x, y) => y.entries.length - x.entries.length)[0];
    if (!pick || team.rubbers.length < 3) {
      context.log("强制同分 T3：没有至少 3 队、至少 3 个小场的团体小组，未构造");
    } else {
      const [x, y, z, ...others] = context.rng.fork("ties:T3").shuffle(pick.entries);
      const cycle: [string, string][] = [[x, y], [y, z], [z, x]];
      const sideOf = new Map(matches.map((match) => [match.code, match.sideAEntryId]));
      const codes: string[] = [];
      for (const fixture of pick.list) {
        const pair = [fixture.sideAEntryId!, fixture.sideBEntryId!];
        const inCycle = cycle.find(([winner, loser]) => pair.includes(winner) && pair.includes(loser));
        const fixtureWinner = inCycle ? inCycle[0] : [x, y, z].includes(pair[0]) || ![x, y, z].includes(pair[1]) ? pair[0] : pair[1];
        for (const rubber of fixture.matches) {
          const order = rubber.rubberOrder ?? 0;
          // 循环内：胜方赢第 1、3 小场，负方赢第 2 小场（保证第 3 小场一定要打）；陪打：胜方全胜，其余小场按团体规则可能不再进行。
          const rubberWinner = inCycle && order === 2 ? (fixtureWinner === pair[0] ? pair[1] : pair[0]) : fixtureWinner;
          const rubberSideA = sideOf.get(rubber.code) ?? fixture.sideAEntryId;
          const games: [number, number][] = inCycle ? [[21, 15], [21, 15]] : [[21, 10], [21, 10]];
          tournament.forced.set(rubber.code, { kind: "SCRIPT", games: oriented(games, rubberSideA === rubberWinner), why: `T3 ${inCycle ? "循环相克" : "陪打"}` });
          codes.push(rubber.code);
        }
      }
      const label = groupCode.get(pick.groupId)!;
      scenarios.push({
        id: "T3",
        competition: label.split("/")[0],
        group: label.split("/")[1],
        cycle: [x, y, z],
        others,
        expect: "三队对抗胜场、小场差、局差、分差全部相同 → 系统应列为并列待裁定（须抽签）",
        matches: codes,
      });
      context.log(`强制同分 T3：${label}（${pick.entries.length} 队，${codes.length} 个小场指定比分）`);
    }
  }
  tournament.tieScenarios = scenarios;
  return scenarios;
}

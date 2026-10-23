/**
 * oracle 黄金用例（§13.6）。
 *
 * tests/stress/golden/
 *   manual/<类别>/*.json   人工核对用例：由用户按竞赛规程手算 `expected`，**oracle 必须先通过这些用例**；
 *                           没有 `expected` 的（含 TEMPLATE.json）记为待填写，不算通过。
 *   auto/*.json            本仿真作者写的用例，与人工用例分开，避免混淆。
 *
 * 用例格式见 tests/stress/golden/README.md。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { byePlan, knockoutPlacements, type KnockoutFact } from "./placements";
import { rankGroup, type RankedMatch } from "./ranking";

const ROOT = path.join(process.cwd(), "tests", "stress", "golden");

type Games = [number, number][];

interface RankingCase {
  kind: "ranking";
  input: {
    entryKind: "INDIVIDUAL" | "TEAM";
    entries: string[];
    /** 个人：每场一组逐局比分（A 方在前）。团体：每场对抗给出各小场逐局比分。 */
    matches: { a: string; b: string; games?: Games; rubbers?: Games[] }[];
  };
  expected?: { order: string[]; unresolved?: string[][] };
}

interface PlacementCase {
  kind: "placements";
  input: { thirdPlaceMatch: boolean; fixtures: KnockoutFact[] };
  expected?: { entryId: string; place: number | null; tied: boolean }[];
}

interface ByeCase {
  kind: "byes";
  input: { qualifierRanks: number[] };
  expected?: { bracketSize: number; byes: number; byeRanks: number[] };
}

type GoldenCase = (RankingCase | PlacementCase | ByeCase) & { title?: string; basis?: string };

function listJson(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return listJson(full);
    return name.endsWith(".json") ? [full] : [];
  });
}

function gameWinner([a, b]: [number, number]) {
  return a > b ? "A" : "B";
}

function rankedFromGames(a: string, b: string, games: Games): RankedMatch {
  const gamesA = games.filter((game) => gameWinner(game) === "A").length;
  const gamesB = games.length - gamesA;
  return {
    a,
    b,
    winner: gamesA > gamesB ? a : b,
    gamesA,
    gamesB,
    pointsA: games.reduce((sum, game) => sum + game[0], 0),
    pointsB: games.reduce((sum, game) => sum + game[1], 0),
  };
}

export function evaluateCase(golden: GoldenCase): unknown {
  if (golden.kind === "ranking") {
    const matches = golden.input.matches.map((match) => {
      if (golden.input.entryKind === "INDIVIDUAL") return rankedFromGames(match.a, match.b, match.games ?? []);
      const rubbers = (match.rubbers ?? []).map((games) => rankedFromGames("A", "B", games));
      const rubbersA = rubbers.filter((item) => item.winner === "A").length;
      const rubbersB = rubbers.length - rubbersA;
      return {
        a: match.a,
        b: match.b,
        winner: rubbersA > rubbersB ? match.a : match.b,
        rubbersA,
        rubbersB,
        gamesA: rubbers.reduce((sum, item) => sum + item.gamesA, 0),
        gamesB: rubbers.reduce((sum, item) => sum + item.gamesB, 0),
        pointsA: rubbers.reduce((sum, item) => sum + item.pointsA, 0),
        pointsB: rubbers.reduce((sum, item) => sum + item.pointsB, 0),
      };
    });
    const outcome = rankGroup(golden.input.entries, matches, golden.input.entryKind);
    return { order: outcome.order, unresolved: outcome.unresolved };
  }
  if (golden.kind === "placements") {
    return knockoutPlacements(golden.input.fixtures, golden.input.thirdPlaceMatch)
      .map(({ entryId, place, tied }) => ({ entryId, place, tied }))
      .sort((x, y) => x.entryId.localeCompare(y.entryId));
  }
  return byePlan(golden.input.qualifierRanks);
}

function normalize(kind: GoldenCase["kind"], value: unknown) {
  if (kind === "placements") return [...(value as { entryId: string }[])].sort((x, y) => x.entryId.localeCompare(y.entryId));
  if (kind === "ranking") {
    const ranking = value as { order: string[]; unresolved?: string[][] };
    return { order: ranking.order, unresolved: (ranking.unresolved ?? []).map((block) => [...block].sort()) };
  }
  return value;
}

/** 有并列块时，块内先后不要求一致（由抽签决定）。 */
function rankingEqual(actual: { order: string[]; unresolved: string[][] }, expected: { order: string[]; unresolved: string[][] }) {
  if (JSON.stringify(actual.unresolved) !== JSON.stringify(expected.unresolved)) return false;
  const block = new Map<string, number>();
  expected.unresolved.forEach((items, index) => items.forEach((id) => block.set(id, index)));
  return actual.order.length === expected.order.length && actual.order.every((id, index) => id === expected.order[index] || (block.has(id) && block.get(id) === block.get(expected.order[index])));
}

export function runGoldenDirectory(directory: string) {
  const passed: string[] = [];
  const failed: { file: string; detail: string }[] = [];
  const pending: string[] = [];
  for (const file of listJson(directory)) {
    const relative = path.relative(process.cwd(), file);
    const golden = JSON.parse(readFileSync(file, "utf8")) as GoldenCase;
    if (golden.expected === undefined || golden.expected === null) {
      pending.push(relative);
      continue;
    }
    try {
      const actual = normalize(golden.kind, evaluateCase(golden));
      const expected = normalize(golden.kind, golden.expected);
      const equal = golden.kind === "ranking" ? rankingEqual(actual as never, expected as never) : JSON.stringify(actual) === JSON.stringify(expected);
      if (equal) passed.push(relative);
      else failed.push({ file: relative, detail: `期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(actual)}` });
    } catch (error) {
      failed.push({ file: relative, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { passed: passed.length, passedFiles: passed, failed, pending };
}

export function runManualGoldenCases() {
  return runGoldenDirectory(path.join(ROOT, "manual"));
}

export function runAutoGoldenCases() {
  return runGoldenDirectory(path.join(ROOT, "auto"));
}

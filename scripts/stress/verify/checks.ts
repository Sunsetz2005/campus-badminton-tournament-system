/**
 * 自动判定（§8）。每项判定返回 { name, passed, checked, failures[] }，失败条目带足够复现的信息。
 *
 * 1 replay      逐场用 src/domain 引擎重放事件，与 MatchSnapshot 的版本、哈希、内容一致（引擎一致性，与 oracle 分开）
 * 2 scoring     独立期望比分模型逐条比较每个事件的 stateAfter，最终与 Game 表比较
 * 3 events      版本从 1 连续、stateBefore/After 首尾相接、commandId 全局唯一、成功请求与事件一一对应
 * 4 ties        团体对抗胜负与「未进行」集合独立推算
 * 5 ranking     小组名次独立重算（含并列块），淘汰首轮映射与胜者/负者去向，最终名次
 * 6 schedule    同一选手 / 同一场地不同时进行两场；无永久待开赛（另列）
 * 7 isolation   比赛与事件只引用本赛事本项目的报名单位与参赛者
 */
import { replayMatch, stableStringify, type MatchEvent as DomainEvent, type MatchState } from "../../../src/domain/rules/match-engine";
import { asMatchState, domainEventFromRecord, hashMatchValue, MATCH_ENGINE_VERSION } from "../../../src/server/services/match-state-service";
import { downgradeMatchStateToEngineV1 } from "../../../src/domain/rules/match-engine";
import { loadCompetitionResults } from "../../../src/server/services/results-service";
import { prisma } from "../core/db";
import { compareRanking, rankGroup, type RankedMatch } from "../oracle/ranking";
import { fixedFirstRound, knockoutPlacements, tieOutcome, type KnockoutFact } from "../oracle/placements";
import { applyOracle, diffAgainst, initialOracleState, type OracleRule } from "../oracle/scoring";
import type { EventRow, MatchRow, TournamentData } from "./data";

export interface CheckResult {
  name: string;
  title: string;
  passed: boolean;
  checked: number;
  failures: { subject: string; detail: string }[];
  notes: string[];
}

function result(name: string, title: string): CheckResult {
  return { name, title, passed: true, checked: 0, failures: [], notes: [] };
}

function fail(check: CheckResult, subject: string, detail: string) {
  check.passed = false;
  if (check.failures.length < 200) check.failures.push({ subject, detail });
}

function eventsByMatch(data: TournamentData) {
  const map = new Map<string, EventRow[]>();
  for (const event of data.events) map.set(event.matchId, [...(map.get(event.matchId) ?? []), event]);
  return map;
}

export function checkReplay(data: TournamentData): CheckResult {
  const check = result("replay", "逐场重放与权威快照一致");
  const grouped = eventsByMatch(data);
  for (const match of data.matches) {
    if (!match.snapshot) continue;
    check.checked += 1;
    try {
      const initial = asMatchState(match.snapshot.initialState as never);
      if (hashMatchValue(initial) !== match.snapshot.initialStateHash) {
        fail(check, match.code, "初始状态哈希不符");
        continue;
      }
      const events = (grouped.get(match.id) ?? []).map((row) => domainEventFromRecord(row as never) as DomainEvent);
      const replayed = replayMatch(initial, events);
      const stored = asMatchState(match.snapshot.state as never);
      const comparable = match.snapshot.engineVersion < MATCH_ENGINE_VERSION ? downgradeMatchStateToEngineV1(replayed) : replayed;
      if (match.snapshot.version !== replayed.version) fail(check, match.code, `快照版本 ${match.snapshot.version} ≠ 重放 ${replayed.version}`);
      else if (hashMatchValue(comparable) !== match.snapshot.stateHash) fail(check, match.code, "重放状态哈希与快照不符");
      else if (stableStringify(comparable) !== stableStringify(stored)) fail(check, match.code, "重放状态内容与快照不符");
      if (match.version !== replayed.version) fail(check, match.code, `Match.version ${match.version} ≠ 重放 ${replayed.version}`);
    } catch (error) {
      fail(check, match.code, `重放抛错：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return check;
}

export function checkEvents(data: TournamentData, accepted: Map<string, Set<string>>): CheckResult {
  const check = result("events", "事件完整性与请求↔事件一一对应");
  const grouped = eventsByMatch(data);
  const matchIds = new Set(data.matches.map((match) => match.id));
  const seen = new Map<string, string>();
  for (const event of data.events) {
    if (!matchIds.has(event.matchId)) fail(check, event.id, "事件挂在不属于本赛事的比赛上");
    if (event.commandId) {
      if (seen.has(event.commandId)) fail(check, event.commandId, `commandId 重复（${seen.get(event.commandId)} 与 ${event.matchId}）`);
      seen.set(event.commandId, event.matchId);
    }
  }
  for (const match of data.matches) {
    const list = grouped.get(match.id) ?? [];
    check.checked += 1;
    list.forEach((event, index) => {
      if (event.version !== index + 1) fail(check, match.code, `第 ${index + 1} 条事件版本为 ${event.version}`);
      if (index > 0 && event.stateBeforeHash && list[index - 1].stateAfterHash && event.stateBeforeHash !== list[index - 1].stateAfterHash) {
        fail(check, match.code, `v${event.version} 的 stateBefore 与 v${event.version - 1} 的 stateAfter 不衔接`);
      }
    });
    const expected = accepted.get(match.code);
    if (expected) {
      const recorded = new Set(list.map((event) => event.commandId).filter(Boolean) as string[]);
      const missing = [...expected].filter((id) => !recorded.has(id));
      const extra = [...recorded].filter((id) => !expected.has(id));
      if (missing.length) fail(check, match.code, `${missing.length} 条已受理的命令在库里没有事件`);
      if (extra.length) fail(check, match.code, `${extra.length} 条事件不对应仿真端任何已受理命令`);
    }
  }
  return check;
}

function ruleOf(match: MatchRow): OracleRule {
  const config = match.ruleSnapshot?.config as Record<string, number | null> | undefined;
  return {
    bestOf: Number(config?.bestOf ?? 3),
    targetPoints: Number(config?.targetPoints ?? 21),
    winBy: Number(config?.winBy ?? 2),
    capPoints: Number(config?.capPoints ?? 30),
    intervalAt: (config?.intervalAt as number | null) ?? null,
    decidingGameChangeEndsAt: (config?.decidingGameChangeEndsAt as number | null) ?? null,
    betweenGamesSeconds: Number(config?.betweenGamesSeconds ?? 0),
  };
}

export function checkScoring(data: TournamentData): CheckResult {
  const check = result("scoring", "独立期望比分与服务端逐条一致");
  const grouped = eventsByMatch(data);
  for (const match of data.matches) {
    const list = grouped.get(match.id) ?? [];
    if (!list.length) continue;
    check.checked += 1;
    const rule = ruleOf(match);
    const oracle = initialOracleState();
    let stopped = false;
    for (const event of list) {
      const step = applyOracle(oracle, rule, event.type, (event.payload ?? {}) as Record<string, unknown>);
      if (!step.ok) {
        if (step.reason === "unsupported") check.notes.push(`${match.code} v${event.version}：${step.detail}，之后不再逐条比较`);
        else fail(check, match.code, `v${event.version} ${event.type}：${step.detail}`);
        stopped = true;
        break;
      }
      const after = event.stateAfter as unknown as MatchState | null;
      if (!after) continue;
      const differences = diffAgainst(oracle, after as never);
      if (differences.length) {
        fail(check, match.code, `v${event.version} ${event.type}：${differences.join("；")}`);
        stopped = true;
        break;
      }
    }
    if (stopped || oracle.frozen) continue;
    const games = match.games.filter((game) => game.completed);
    const want = oracle.completedGames;
    if (games.length !== want.length || games.some((game, index) => game.scoreA !== want[index].A || game.scoreB !== want[index].B)) {
      fail(check, match.code, `Game 表 ${games.map((game) => `${game.scoreA}-${game.scoreB}`).join(" ")} ≠ 期望 ${want.map((game) => `${game.A}-${game.B}`).join(" ")}`);
    }
  }
  return check;
}

function winnerSideOf(match: MatchRow): "A" | "B" | null {
  const state = match.snapshot?.state as unknown as MatchState | undefined;
  if (state?.specialOutcome) return (state.specialOutcome as { winnerSide?: "A" | "B" }).winnerSide ?? null;
  if (!state) return null;
  if (state.gamesWon.A > state.gamesWon.B) return "A";
  if (state.gamesWon.B > state.gamesWon.A) return "B";
  return null;
}

function rankedMatchOf(match: MatchRow): RankedMatch | null {
  if (!match.sideAEntryId || !match.sideBEntryId) return null;
  const side = winnerSideOf(match);
  const completed = match.games.filter((game) => game.completed);
  return {
    a: match.sideAEntryId,
    b: match.sideBEntryId,
    winner: side === "A" ? match.sideAEntryId : side === "B" ? match.sideBEntryId : null,
    gamesA: completed.filter((game) => game.scoreA > game.scoreB).length,
    gamesB: completed.filter((game) => game.scoreB > game.scoreA).length,
    pointsA: match.games.reduce((sum, game) => sum + game.scoreA, 0),
    pointsB: match.games.reduce((sum, game) => sum + game.scoreB, 0),
  };
}

export function checkTies(data: TournamentData): CheckResult {
  const check = result("ties", "团体对抗胜负与「未进行」独立推算");
  const team = new Set(data.competitions.filter((item) => item.entryType === "TEAM").map((item) => item.id));
  const withdrawn = new Set(data.entries.filter((entry) => entry.withdrawnAt).map((entry) => entry.id));
  for (const fixture of data.fixtures.filter((item) => team.has(item.competitionId))) {
    const rubbers = data.matches.filter((match) => match.fixtureId === fixture.id);
    if (!rubbers.length) continue;
    check.checked += 1;
    const facts = rubbers.map((match) => ({
      order: match.rubberOrder ?? 0,
      winnerSide: match.verificationStatus === "LOCKED" ? winnerSideOf(match) : null,
      settled: match.verificationStatus === "LOCKED" || Boolean(match.notPlayedAt),
      notPlayed: Boolean(match.notPlayedAt),
      started: match.version > 0,
    }));
    const outcome = tieOutcome(facts, fixture.kind !== "GROUP");
    // 赛务口径 W-7（GCR 16.3.7）：一队整体退出，按小场还没决出的小组对抗判给对手，剩下的小场记为未进行。
    const conceded = fixture.kind === "GROUP" && !outcome.winner
      ? withdrawn.has(fixture.sideAEntryId ?? "") && !withdrawn.has(fixture.sideBEntryId ?? "") ? "B" : withdrawn.has(fixture.sideBEntryId ?? "") && !withdrawn.has(fixture.sideAEntryId ?? "") ? "A" : null
      : null;
    const winnerSide = outcome.winner ?? conceded;
    const expectedWinner = winnerSide === "A" ? fixture.sideAEntryId : winnerSide === "B" ? fixture.sideBEntryId : null;
    if ((fixture.winnerEntryId ?? null) !== (expectedWinner ?? null)) {
      fail(check, fixture.code, `对抗胜方 期望 ${expectedWinner ?? "未决"} 实际 ${fixture.winnerEntryId ?? "未决"}（小场 ${outcome.rubbersA}:${outcome.rubbersB}）`);
    }
    if (fixture.kind === "GROUP" && !conceded && rubbers.some((match) => match.notPlayedAt)) fail(check, fixture.code, "小组对抗出现「未进行」的小场（应打满）");
    if (fixture.kind !== "GROUP" && fixture.winnerEntryId) {
      const notPlayed = rubbers.filter((match) => match.notPlayedAt).map((match) => match.rubberOrder).sort().join(",");
      const want = outcome.expectNotPlayed.sort().join(",");
      if (notPlayed !== want) fail(check, fixture.code, `未进行小场 期望 [${want}] 实际 [${notPlayed}]`);
    }
  }
  return check;
}

export async function checkRanking(data: TournamentData): Promise<CheckResult> {
  const check = result("ranking", "小组名次、淘汰签位与最终名次独立重算");
  const excluded = new Map<string, Set<string>>();
  for (const item of data.exclusions) excluded.set(item.groupId, new Set([...(excluded.get(item.groupId) ?? []), item.entryId]));
  // 赛务口径 R-3（GCR 16.2.5）：小组里以弃权、退赛、取消资格告负的一方没有打完本组，全部小组成绩自动删除。
  for (const match of data.matches) {
    // 团体小场不适用：单个小场退赛或认输按 R-4 补完计入，不删除整队。
    if (!match.groupId || match.rubberKind || match.verificationStatus !== "LOCKED" || !["WO", "RET", "DSQ"].includes(match.outcomeType ?? "")) continue;
    const side = winnerSideOf(match);
    const loser = side === "A" ? match.sideBEntryId : side === "B" ? match.sideAEntryId : null;
    if (loser) excluded.set(match.groupId, new Set([...(excluded.get(match.groupId) ?? []), loser]));
  }
  // 赛务口径 R-4 / W-7（GCR 16.3.7）：整体退出的团体打不完全部小组对抗，全部小组成绩删除。
  const withdrawnEntries = new Set(data.entries.filter((entry) => entry.withdrawnAt).map((entry) => entry.id));
  const confirmedOrder = new Map<string, string[]>();
  for (const competition of data.competitions) {
    const isTeam = competition.entryType === "TEAM";
    const groups = data.groups.filter((group) => group.stage.competitionId === competition.id);
    for (const group of groups) {
      const out = excluded.get(group.id) ?? new Set();
      let entries: string[];
      let ranked: RankedMatch[];
      if (isTeam) {
        const fixtures = data.fixtures.filter((fixture) => fixture.groupId === group.id);
        entries = [...new Set(fixtures.flatMap((fixture) => [fixture.sideAEntryId, fixture.sideBEntryId]).filter(Boolean) as string[])].filter((id) => !out.has(id) && !withdrawnEntries.has(id));
        ranked = fixtures.filter((fixture) => entries.includes(fixture.sideAEntryId ?? "") && entries.includes(fixture.sideBEntryId ?? "")).map((fixture) => {
          const rubbers = data.matches.filter((match) => match.fixtureId === fixture.id && match.verificationStatus === "LOCKED");
          let rubbersA = 0;
          let rubbersB = 0;
          let gamesA = 0;
          let gamesB = 0;
          let pointsA = 0;
          let pointsB = 0;
          for (const rubber of rubbers) {
            const fact = rankedMatchOf(rubber);
            if (!fact) continue;
            if (fact.winner === rubber.sideAEntryId) rubbersA += 1;
            else if (fact.winner === rubber.sideBEntryId) rubbersB += 1;
            gamesA += fact.gamesA;
            gamesB += fact.gamesB;
            pointsA += fact.pointsA;
            pointsB += fact.pointsB;
          }
          return { a: fixture.sideAEntryId!, b: fixture.sideBEntryId!, winner: fixture.winnerEntryId, gamesA, gamesB, pointsA, pointsB, rubbersA, rubbersB };
        });
      } else {
        const groupMatches = data.matches.filter((match) => match.groupId === group.id);
        entries = [...new Set(groupMatches.flatMap((match) => [match.sideAEntryId, match.sideBEntryId]).filter(Boolean) as string[])].filter((id) => !out.has(id));
        ranked = groupMatches
          .filter((match) => match.verificationStatus === "LOCKED" && match.outcomeType === "NORMAL")
          .map(rankedMatchOf)
          .filter((item): item is RankedMatch => Boolean(item))
          .filter((item) => !out.has(item.a) && !out.has(item.b));
      }
      const stored = group.ranking as { order?: string[] } | null;
      if (!group.rankingConfirmedAt || !stored?.order) {
        check.notes.push(`${competition.code}/${group.code} 名次未确认，跳过`);
        continue;
      }
      check.checked += 1;
      confirmedOrder.set(group.id, stored.order);
      const expected = rankGroup(entries, ranked, isTeam ? "TEAM" : "INDIVIDUAL");
      const differences = compareRanking(expected, stored.order);
      // 团体的「分层后剩两队」口径文档未写（oracle 头注释）：系统顺序若与另一口径一致，标为口径差异，仍记失败，待用户裁定口径。
      const variantMatches = isTeam && differences.length > 0 && compareRanking(rankGroup(entries, ranked, "TEAM", "AFTER_ALL"), stored.order).length === 0;
      for (const difference of differences) fail(check, `${competition.code}/${group.code}`, variantMatches ? `口径差异：${difference}` : difference);
      if (variantMatches) {
        check.notes.push(`${competition.code}/${group.code} 口径差异：系统按「小场差、局差、分差全部比完仍剩两队才看相互胜负」排序，oracle 假设「每一层分出两队即回到相互胜负」；文档未写明，待裁定`);
      }
      // 并列待裁定块本身也要一致：系统要求抽签的集合 = 独立计算认为规则无法区分的集合。
      const storedLots = ((group.ranking as { lots?: string[][] } | null)?.lots ?? []).map((block) => [...block].sort().join(",")).sort();
      const expectedLots = expected.unresolved.map((block) => [...block].sort().join(",")).sort();
      if (storedLots.join(" | ") !== expectedLots.join(" | ")) {
        fail(check, `${competition.code}/${group.code}`, `并列待裁定块 期望 [${expectedLots.join(" | ") || "无"}] 实际 [${storedLots.join(" | ") || "无"}]`);
      }
      if (expectedLots.length) check.notes.push(`${competition.code}/${group.code} 出现须抽签的并列：${expectedLots.join(" | ")}`);
    }

    // 淘汰首轮映射（两组 / 四组）与胜者、负者去向。
    const knockout = data.fixtures.filter((fixture) => fixture.competitionId === competition.id && fixture.kind !== "GROUP");
    const groupCode = new Map(groups.map((group) => [group.id, group.code]));
    const drawSettings = data.draws.find((draw) => draw.competitionId === competition.id)?.settings as { qualifiersPerGroup?: number } | undefined;
    // 文档只规定了每组出线 2 时的两组 / 四组映射；每组出线 1 的签位只校验去向，不校验首轮配对。
    const mapping = drawSettings?.qualifiersPerGroup === 2 ? fixedFirstRound(groups.map((group) => group.code)) : null;
    if (mapping && groups.length) {
      const firstRound = knockout.filter((fixture) => fixture.kind === "KNOCKOUT" && fixture.round === 1).sort((x, y) => x.sequence - y.sequence);
      const labels = firstRound.map((fixture) => [
        fixture.sideAGroupId ? `${groupCode.get(fixture.sideAGroupId)}${fixture.sideARank}` : "?",
        fixture.sideBGroupId ? `${groupCode.get(fixture.sideBGroupId)}${fixture.sideBRank}` : "?",
      ]);
      const want = mapping.map((pair) => pair.join("—")).sort().join(" ");
      const got = labels.map((pair) => pair.join("—")).sort().join(" ");
      check.checked += 1;
      if (want !== got) fail(check, `${competition.code} 首轮`, `映射 期望 ${want} 实际 ${got}`);
    }
    for (const fixture of knockout) {
      for (const side of ["A", "B"] as const) {
        const source = side === "A" ? fixture.sideASource : fixture.sideBSource;
        const actual = side === "A" ? fixture.sideAEntryId : fixture.sideBEntryId;
        let expected: string | null | undefined;
        if (source === "GROUP_RANK") {
          const groupId = side === "A" ? fixture.sideAGroupId : fixture.sideBGroupId;
          const rank = side === "A" ? fixture.sideARank : fixture.sideBRank;
          const order = groupId ? confirmedOrder.get(groupId) : undefined;
          expected = order && rank ? order[rank - 1] ?? null : undefined;
        } else if (source === "FIXTURE_WINNER" || source === "FIXTURE_LOSER") {
          const upstream = data.fixtures.find((item) => item.id === (side === "A" ? fixture.sideAFixtureId : fixture.sideBFixtureId));
          if (upstream?.winnerEntryId) {
            const loser = upstream.winnerEntryId === upstream.sideAEntryId ? upstream.sideBEntryId : upstream.sideAEntryId;
            expected = source === "FIXTURE_WINNER" ? upstream.winnerEntryId : loser;
          }
        }
        if (expected === undefined) continue;
        check.checked += 1;
        if ((expected ?? null) !== (actual ?? null)) fail(check, `${competition.code}/${fixture.code}${side}`, `签位 期望 ${expected ?? "空"} 实际 ${actual ?? "空"}（来源 ${source}）`);
      }
    }

    // 最终名次（个人项目；团体项目没有名次页）。
    if (!isTeam) {
      const loaded = await loadCompetitionResults(prisma, data.tournament.id, competition.code);
      const placements = loaded?.results?.placements ?? [];
      const settings = data.draws.find((draw) => draw.competitionId === competition.id)?.settings as { thirdPlaceMatch?: boolean; format?: string } | undefined;
      if (settings?.format && settings.format !== "ROUND_ROBIN") {
        const facts: KnockoutFact[] = knockout.map((fixture) => ({
          code: fixture.code,
          kind: fixture.kind as KnockoutFact["kind"],
          round: fixture.round,
          sideA: fixture.sideAEntryId,
          sideB: fixture.sideBEntryId,
          winner: fixture.winnerEntryId,
        }));
        const expected = knockoutPlacements(facts, settings.thirdPlaceMatch !== false);
        for (const want of expected) {
          check.checked += 1;
          const got = placements.find((item: { entryId: string }) => item.entryId === want.entryId) as { place: number | null; tied: boolean } | undefined;
          if (!got || got.place !== want.place || got.tied !== want.tied) {
            fail(check, `${competition.code} 名次`, `${want.entryId} 期望 ${want.label} 实际 ${got ? `${got.place}${got.tied ? "（并列）" : ""}` : "无"}`);
          }
        }
      }
    }
  }
  return check;
}

export function checkSchedule(data: TournamentData): CheckResult {
  const check = result("schedule", "同一选手 / 同一场地不同时进行两场");
  const intervals = data.matches
    .filter((match) => match.startedAt)
    .map((match) => {
      const persons = match.rubberKind
        ? match.players.map((item) => item.participantId)
        : [...(match.sideAEntry?.members ?? []), ...(match.sideBEntry?.members ?? [])].map((item) => item.participantId);
      return { code: match.code, court: match.courtId, start: match.startedAt!.getTime(), end: (match.endedAt ?? new Date()).getTime(), persons };
    });
  check.checked = intervals.length;
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const x = intervals[i];
      const y = intervals[j];
      if (x.start >= y.end || y.start >= x.end) continue;
      const shared = x.persons.filter((id) => y.persons.includes(id));
      if (shared.length) fail(check, `${x.code} × ${y.code}`, `同一选手同时在两场进行中（${shared.length} 人）`);
      if (x.court && x.court === y.court) fail(check, `${x.code} × ${y.code}`, "同一场地同时进行两场");
    }
  }
  const pending = data.matches.filter((match) => !match.notPlayedAt && match.verificationStatus !== "LOCKED");
  if (pending.length) check.notes.push(`结束时仍有 ${pending.length} 场未锁定：${pending.slice(0, 20).map((match) => `${match.code}(${match.lifecycleStatus}/${match.verificationStatus})`).join("，")}`);
  return check;
}

export function checkIsolation(data: TournamentData): CheckResult {
  const check = result("isolation", "数据隔离：比赛与名单只引用本赛事本项目");
  const participantIds = new Set(data.participants.map((item) => item.id));
  const entryCompetition = new Map(data.entries.map((entry) => [entry.id, entry.competitionId]));
  for (const match of data.matches) {
    check.checked += 1;
    const competitionId = match.stage.competitionId;
    for (const [side, entryId] of [["A", match.sideAEntryId], ["B", match.sideBEntryId]] as const) {
      if (entryId && entryCompetition.get(entryId) !== competitionId) fail(check, match.code, `${side} 方报名单位不属于本项目`);
    }
    for (const player of match.players) {
      if (!participantIds.has(player.participantId)) fail(check, match.code, "上场队员不是本赛事参赛者");
      if (entryCompetition.get(player.entryId) !== competitionId) fail(check, match.code, "上场队员所属报名单位不属于本项目");
    }
  }
  return check;
}

export function runAll(data: TournamentData, accepted: Map<string, Set<string>>) {
  return [checkReplay(data), checkScoring(data), checkEvents(data, accepted), checkTies(data), checkSchedule(data), checkIsolation(data)];
}

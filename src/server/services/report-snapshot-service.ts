import { createHash } from "node:crypto";

import { Prisma, type NamePublicationPolicy } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { DRAW_FORMAT_LABEL } from "@/domain/draw/format";
import { COMPETITION_KIND_LABEL } from "@/domain/registration/registration-rules";
import { RUBBER_LABEL, type RubberKind } from "@/domain/registration/team-roster";
import { OUTCOME_LABEL, RESULT_STAGE_LABEL } from "@/domain/results/match-result";
import { computePlacements, type PlacementFixtureFact } from "@/domain/results/placements";
import { CAMPUS_DEMO_RANKING, RANKING_BASIS_LABEL } from "@/domain/results/ranking";
import { stableStringify } from "@/domain/rules/match-engine";
import { STANDING_BASIS_LABEL } from "@/domain/team/standings";
import { formatZonedClock, utcToZonedLocal } from "@/domain/time/zoned-time";
import {
  formatScoreline,
  type CapturedSnapshot,
  type ReportCompetition,
  type ReportEditionValue,
  type ReportGroup,
  type ReportGroupRanking,
  type ReportMatch,
  type ReportPlacement,
  type ReportRule,
  type ReportSide,
  type ReportSnapshot,
  type ReportTie,
} from "@/reports/report-model";
import { publishedMatchWhere } from "@/reports/public-fields";
import { AppError } from "@/server/services/errors";
import { assertIanaTimeZone, projectRuleSummary } from "@/server/services/public-projection";
import { loadCompetitionResults, matchFactOf, matchFactSelect, type StandingsSnapshot } from "@/server/services/results-service";
import { loadCompetitionTies, loadGroupStandings, summarizeTie } from "@/server/services/team-tie-service";

type Tx = Prisma.TransactionClient;

/** 单份报告的比赛数上限：超过即拒绝并给出可理解的提示，而不是生成难以打开的超大文件。 */
export const REPORT_MAX_MATCHES = 3000;

const KIND_LABEL: Record<string, string> = { ...COMPETITION_KIND_LABEL, TEAM: "团体", CUSTOM: "自定义" };

// ---------------------------------------------------------------------------
// 姓名投影：`CODES_ONLY` 时只出现编号，未获批准的姓名不进入快照
// ---------------------------------------------------------------------------

type ParticipantRow = { publicCode: string; displayName: string; teamName: string | null };
type EntryRow = { code: string; displayName: string; members: { slot: number; participant: ParticipantRow }[] };

function memberLabel(participant: ParticipantRow, policy: NamePublicationPolicy) {
  return policy === "DISPLAY_NAMES" ? `${participant.publicCode} ${participant.displayName}` : participant.publicCode;
}

function entryName(entry: { code: string; displayName: string }, policy: NamePublicationPolicy) {
  return policy === "DISPLAY_NAMES" ? entry.displayName : entry.code;
}

function projectSide(entry: EntryRow | null, pending: string, policy: NamePublicationPolicy, players?: ParticipantRow[]): ReportSide {
  if (!entry) return { code: null, name: pending, members: [], pending: true };
  const members = players ?? [...entry.members].sort((a, b) => a.slot - b.slot).map((member) => member.participant);
  return { code: entry.code, name: entryName(entry, policy), members: members.map((member) => memberLabel(member, policy)), pending: false };
}

function teamOf(entry: EntryRow, policy: NamePublicationPolicy) {
  if (policy !== "DISPLAY_NAMES") return null;
  const names = [...new Set(entry.members.map((member) => member.participant.teamName).filter((name): name is string => Boolean(name)))];
  return names.length ? names.join("／") : null;
}

// ---------------------------------------------------------------------------
// 取数
// ---------------------------------------------------------------------------

const participantSelect = { publicCode: true, displayName: true, teamName: true } as const;
const entrySelect = {
  id: true,
  code: true,
  displayName: true,
  members: { orderBy: { slot: "asc" }, select: { slot: true, participant: { select: participantSelect } } },
} satisfies Prisma.EntrySelect;

const reportMatchSelect = {
  ...matchFactSelect,
  scheduledAt: true,
  scheduleEstimated: true,
  rubberKind: true,
  rubberOrder: true,
  court: { select: { code: true, name: true, sortOrder: true } },
  stage: { select: { name: true, order: true, competition: { select: { code: true, name: true } } } },
  group: { select: { code: true } },
  fixture: {
    select: {
      code: true,
      label: true,
      lineupsRevealedAt: true,
      sideASource: true,
      sideARank: true,
      sideBSource: true,
      sideBRank: true,
      sideAGroup: { select: { code: true } },
      sideBGroup: { select: { code: true } },
      sideAFixture: { select: { code: true } },
      sideBFixture: { select: { code: true } },
    },
  },
  sideAEntry: { select: entrySelect },
  sideBEntry: { select: entrySelect },
  players: { orderBy: [{ side: "asc" }, { slot: "asc" }], select: { side: true, participant: { select: participantSelect } } },
} satisfies Prisma.MatchSelect;

type ReportMatchRow = Prisma.MatchGetPayload<{ select: typeof reportMatchSelect }>;
type FixtureLabelRow = NonNullable<ReportMatchRow["fixture"]>;

function pendingLabel(fixture: FixtureLabelRow | null, side: "A" | "B") {
  if (!fixture) return "待定";
  const source = side === "A" ? fixture.sideASource : fixture.sideBSource;
  if (source === "GROUP_RANK") {
    const group = side === "A" ? fixture.sideAGroup : fixture.sideBGroup;
    return `${group?.code ?? "?"} 组第 ${side === "A" ? fixture.sideARank : fixture.sideBRank} 名`;
  }
  if (source === "FIXTURE_WINNER" || source === "FIXTURE_LOSER") {
    const from = side === "A" ? fixture.sideAFixture : fixture.sideBFixture;
    return `${from?.code ?? "?"} ${source === "FIXTURE_WINNER" ? "胜者" : "负者"}`;
  }
  return "待定";
}

function projectMatch(row: ReportMatchRow, edition: ReportEditionValue, policy: NamePublicationPolicy, timeZone: string): ReportMatch {
  const fact = matchFactOf(row);
  const revealed = Boolean(row.fixture?.lineupsRevealedAt);
  const playersOf = (side: "A" | "B") =>
    row.rubberKind ? (revealed ? row.players.filter((player) => player.side === side).map((player) => player.participant) : []) : undefined;
  const confirmed = fact.stage === "CONFIRMED";
  const started = fact.stage !== "NOT_STARTED";
  const showResult = edition === "OFFICIAL" ? confirmed : started;
  const won = { A: 0, B: 0 };
  for (const game of fact.games) {
    if (game.a > game.b) won.A += 1;
    else if (game.b > game.a) won.B += 1;
  }
  const local = row.scheduledAt ? utcToZonedLocal(row.scheduledAt, timeZone) : null;
  return {
    code: row.code,
    competitionCode: row.stage.competition.code,
    competitionName: row.stage.competition.name,
    stage: row.stage.name,
    group: row.group?.code ?? null,
    round: row.fixture?.label ?? null,
    fixtureCode: row.fixture?.code ?? null,
    rubber: row.rubberKind && row.rubberOrder ? `第 ${row.rubberOrder} 场 ${RUBBER_LABEL[row.rubberKind as RubberKind] ?? ""}`.trim() : null,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    date: local ? local.slice(0, 10) : null,
    time: row.scheduledAt ? formatZonedClock(row.scheduledAt, timeZone) : null,
    estimated: row.scheduleEstimated,
    court: row.court?.name ?? null,
    sideA: projectSide(row.sideAEntry, pendingLabel(row.fixture, "A"), policy, playersOf("A")),
    sideB: projectSide(row.sideBEntry, pendingLabel(row.fixture, "B"), policy, playersOf("B")),
    resultStage: fact.stage,
    statusLabel: edition === "OFFICIAL" && started && !confirmed ? `未确认（${RESULT_STAGE_LABEL[fact.stage]}）` : RESULT_STAGE_LABEL[fact.stage],
    confirmed,
    showResult,
    outcome: showResult ? fact.outcome : null,
    outcomeLabel: showResult && fact.outcome ? OUTCOME_LABEL[fact.outcome] : null,
    winner: showResult ? fact.winner : null,
    games: showResult ? fact.games : [],
    partial: showResult ? fact.partial : null,
    scoreline: showResult ? formatScoreline(fact.games, fact.partial) : "",
    gamesWon: showResult && (fact.games.length || fact.partial) ? `${won.A}:${won.B}` : null,
  };
}

function dateRange(start: Date | null, end: Date | null) {
  const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);
  const [from, to] = [day(start), day(end)];
  if (from && to) return from === to ? from : `${from} 至 ${to}`;
  return from ?? to;
}

/**
 * 在调用方给定的事务里读取一份报表快照。事务必须是可重复读（或更严格）的只读事务：
 * 事务内的每一条查询都看到同一时刻的数据，读取途中别人提交的更正不会混进来。
 */
export interface SnapshotOptions {
  /**
   * 正式版导出为 true：名次在上次发布后有变化就拒绝生成。
   * 公开页为 false：照常显示最后一次发布的榜单，并标记「更正处理中」。
   */
  strictStandings?: boolean;
}

export async function buildReportSnapshot(
  tx: Tx,
  tournamentId: string,
  edition: ReportEditionValue,
  options: SnapshotOptions = {},
): Promise<ReportSnapshot> {
  const strictStandings = options.strictStandings ?? true;
  const tournament = await tx.tournament.findUniqueOrThrow({
    where: { id: tournamentId },
    select: {
      slug: true,
      name: true,
      subtitle: true,
      organizer: true,
      venue: true,
      summary: true,
      regulations: true,
      startDate: true,
      endDate: true,
      timezone: true,
      namePolicy: true,
      defaultRuleRevision: { select: { id: true } },
    },
  });
  const timeZone = assertIanaTimeZone(tournament.timezone);
  const policy = tournament.namePolicy;

  const matchCount = await tx.match.count({ where: { ...publishedMatchWhere, stage: { competition: { tournamentId } } } });
  if (matchCount > REPORT_MAX_MATCHES) {
    throw new AppError(413, "report_too_large", `本赛事已公开 ${matchCount} 场比赛，超过单份报告 ${REPORT_MAX_MATCHES} 场的上限，请联系系统维护人员分项目导出。`);
  }

  const competitionRows = await tx.competition.findMany({
    where: { tournamentId },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      entryType: true,
      entries: { orderBy: { code: "asc" }, select: { ...entrySelect, registration: { select: { status: true } } } },
      draws: { where: { status: "PUBLISHED" }, select: { format: true, settings: true } },
      stages: {
        orderBy: { order: "asc" },
        select: {
          name: true,
          groups: {
            orderBy: { code: "asc" },
            select: {
              id: true,
              code: true,
              name: true,
              ranking: true,
              rankingConfirmedAt: true,
              fixtures: { select: { sideAEntryId: true, sideBEntryId: true } },
            },
          },
        },
      },
    },
  });

  const matchRows = await tx.match.findMany({
    where: { ...publishedMatchWhere, stage: { competition: { tournamentId } } },
    select: reportMatchSelect,
  });
  // 权威赛程顺序：计划时间 → 场地 → 编号；未排期的放在最后。
  matchRows.sort((left, right) => {
    const a = left.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const b = right.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (a !== b) return a - b;
    const courtA = left.court?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const courtB = right.court?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (courtA !== courtB) return courtA - courtB;
    return left.code.localeCompare(right.code);
  });
  const matches = matchRows.map((row) => projectMatch(row, edition, policy, timeZone));
  const publishedGroupCodes = new Set(matches.filter((match) => match.group).map((match) => `${match.competitionCode}/${match.group}`));
  const publishedFixtureCodes = new Set(matches.filter((match) => match.fixtureCode).map((match) => `${match.competitionCode}/${match.fixtureCode}`));

  const standings: Record<string, number | null> = {};
  const competitions: ReportCompetition[] = [];
  for (const competition of competitionRows) {
    const approved = competition.entries.filter((entry) => !entry.registration || entry.registration.status === "APPROVED");
    const byId = new Map(competition.entries.map((entry) => [entry.id, entry]));
    const nameOfId = (entryId: string) => {
      const entry = byId.get(entryId);
      return entry ? { code: entry.code, name: entryName(entry, policy) } : { code: "?", name: "?" };
    };
    const nameOfCode = (code: string) => {
      const entry = competition.entries.find((item) => item.code === code);
      return entry ? entryName(entry, policy) : code;
    };
    const draw = competition.draws[0] ?? null;
    const team = competition.entryType === "TEAM";

    const groups: ReportGroup[] = [];
    for (const stage of competition.stages) {
      for (const group of stage.groups) {
        if (!publishedGroupCodes.has(`${competition.code}/${group.code}`)) continue;
        const ids = new Set<string>();
        for (const fixture of group.fixtures) for (const id of [fixture.sideAEntryId, fixture.sideBEntryId]) if (id) ids.add(id);
        for (const match of matchRows) {
          if (match.stage.competition.code !== competition.code || match.group?.code !== group.code) continue;
          for (const entry of [match.sideAEntry, match.sideBEntry]) if (entry) ids.add(entry.id);
        }
        groups.push({
          competitionCode: competition.code,
          stage: stage.name,
          code: group.code,
          name: group.name,
          entries: [...ids].map(nameOfId).sort((a, b) => a.code.localeCompare(b.code)),
        });
      }
    }
    const groupRows = competition.stages.flatMap((stage) => stage.groups).filter((group) => publishedGroupCodes.has(`${competition.code}/${group.code}`));

    // --- 团体对抗 ---
    const ties: ReportTie[] = [];
    if (team && draw) {
      for (const fixture of await loadCompetitionTies(tx, competition.id)) {
        if (!publishedFixtureCodes.has(`${competition.code}/${fixture.code}`)) continue;
        const summary = summarizeTie(fixture);
        const sideOf = (side: "A" | "B") => {
          const entry = side === "A" ? fixture.sideAEntry : fixture.sideBEntry;
          if (entry) return { code: entry.code, name: entryName(entry, policy), members: [], pending: false };
          const source = side === "A" ? fixture.sideASource : fixture.sideBSource;
          const group = side === "A" ? fixture.sideAGroup : fixture.sideBGroup;
          const from = side === "A" ? fixture.sideAFixture : fixture.sideBFixture;
          const name =
            source === "GROUP_RANK"
              ? `${group?.code ?? "?"} 组第 ${side === "A" ? fixture.sideARank : fixture.sideBRank} 名`
              : source === "FIXTURE_WINNER" || source === "FIXTURE_LOSER"
                ? `${from?.code ?? "?"} ${source === "FIXTURE_WINNER" ? "胜者" : "负者"}`
                : "待定";
          return { code: null, name, members: [], pending: true };
        };
        const decided = Boolean(fixture.winnerEntryId);
        ties.push({
          code: fixture.code,
          competitionCode: competition.code,
          stage: fixture.kind === "GROUP" ? "小组赛" : "淘汰赛",
          group: fixture.group?.code ?? null,
          round: fixture.label,
          sideA: sideOf("A"),
          sideB: sideOf("B"),
          rubbersWon: `${summary.rubbers.A}:${summary.rubbers.B}`,
          winner: decided ? (fixture.winnerEntryId === fixture.sideAEntryId ? "A" : "B") : null,
          decided,
          matchCodes: fixture.matches.map((match) => match.code),
        });
      }
    }

    // --- 小组名次与最终名次 ---
    const rankings: ReportGroupRanking[] = [];
    let placements: ReportPlacement[] = [];
    let placementsNote = draw ? "" : "本项目没有已发布的抽签，不产生名次。";
    let standingsVersion: number | null = null;
    let standingsStale = false;

    if (draw && !team) {
      const loaded = await loadCompetitionResults(tx, tournamentId, competition.code);
      const results = loaded?.results ?? null;
      standingsStale = Boolean(results?.needsRepublish);
      if (edition === "OFFICIAL" && strictStandings && results?.needsRepublish) {
        throw new AppError(
          409,
          "standings_need_republish",
          `项目 ${competition.code} 的名次在上次发布后发生了变化，请先在「成绩名次」页面重新发布榜单，再生成正式版。`,
        );
      }
      if (edition === "OFFICIAL") {
        const publication = await tx.standingsPublication.findFirst({
          where: { competitionId: competition.id },
          orderBy: { version: "desc" },
          select: { version: true, snapshot: true },
        });
        standingsVersion = publication?.version ?? null;
        if (publication) {
          const published = publication.snapshot as unknown as StandingsSnapshot;
          for (const group of published.groups) {
            if (!publishedGroupCodes.has(`${competition.code}/${group.code}`)) continue;
            rankings.push({
              competitionCode: competition.code,
              group: group.code,
              status: "PUBLISHED",
              rows: group.order.map((row) => ({ position: row.position, code: row.code, name: nameOfCode(row.code), detail: null })),
              note: group.lots.length ? `含抽签决定的名次${group.reason ? `：${group.reason}` : ""}` : null,
            });
          }
          placements = published.placements.map((item) => ({
            competitionCode: competition.code,
            place: item.place,
            label: item.label,
            code: item.code,
            name: nameOfCode(item.code),
          }));
          placementsNote = `引用名次榜单第 ${publication.version} 版。`;
        } else {
          placementsNote = "名次榜单尚未发布，正式版不列名次。";
        }
      } else if (results) {
        for (const item of results.groups) {
          if (!publishedGroupCodes.has(`${competition.code}/${item.group.code}`)) continue;
          if (item.confirmed) {
            rankings.push({
              competitionCode: competition.code,
              group: item.group.code,
              status: "CONFIRMED",
              rows: item.confirmed.order.map((entryId, index) => ({ position: index + 1, ...nameOfId(entryId), detail: null })),
              note: item.confirmed.lots.length ? `含抽签决定的名次${item.confirmed.reason ? `：${item.confirmed.reason}` : ""}` : null,
            });
          } else {
            rankings.push({
              competitionCode: competition.code,
              group: item.group.code,
              status: "PROVISIONAL",
              rows: item.ranking.rows.map((row) => ({
                position: row.position,
                ...nameOfId(row.entryId),
                detail: `${row.won} 胜 ${row.lost} 负 · 局 ${row.gamesWon}:${row.gamesLost} · 分 ${row.pointsWon}:${row.pointsLost} · 依据 ${RANKING_BASIS_LABEL[row.basis]}`,
              })),
              note: item.ranking.pendingMatchCodes.length ? `尚有 ${item.ranking.pendingMatchCodes.length} 场未正式确认，不计入。` : null,
            });
          }
        }
        placements = results.placements
          .filter((item) => item.label !== "名次待定")
          .map((item) => ({ competitionCode: competition.code, place: item.place, label: item.label, ...nameOfId(item.entryId) }));
        placementsNote = results.placementsComplete ? "暂定：按当前已确认结果推导，尚未发布。" : "暂定：尚有名次未决出。";
        standingsVersion = results.publications[0]?.version ?? null;
      }
      standings[competition.code] = standingsVersion;
    }

    if (draw && team) {
      const knockout: PlacementFixtureFact[] = [];
      const confirmedGroups: { code: string; confirmedOrder: string[] | null; entryIds: string[]; excludedEntryIds: string[] }[] = [];
      for (const group of groupRows) {
        const confirmed = group.rankingConfirmedAt ? ((group.ranking as { order?: string[]; lots?: string[][]; reason?: string | null } | null) ?? null) : null;
        const entryIds = [...new Set(group.fixtures.flatMap((fixture) => [fixture.sideAEntryId, fixture.sideBEntryId]).filter((id): id is string => Boolean(id)))];
        confirmedGroups.push({ code: group.code, confirmedOrder: confirmed?.order ?? null, entryIds, excludedEntryIds: [] });
        if (confirmed?.order) {
          rankings.push({
            competitionCode: competition.code,
            group: group.code,
            status: "CONFIRMED",
            rows: confirmed.order.map((entryId, index) => ({ position: index + 1, ...nameOfId(entryId), detail: null })),
            note: confirmed.lots?.length ? `含抽签决定的名次${confirmed.reason ? `：${confirmed.reason}` : ""}` : null,
          });
        } else if (edition === "DRAFT") {
          const { standings: table } = await loadGroupStandings(tx, group.id);
          rankings.push({
            competitionCode: competition.code,
            group: group.code,
            status: "PROVISIONAL",
            rows: table.rows.map((row) => ({
              position: row.position,
              ...nameOfId(row.entryId),
              detail: `${row.won} 胜 ${row.lost} 负 · 小场 ${row.rubbersWon}:${row.rubbersLost} · 依据 ${STANDING_BASIS_LABEL[row.basis]}`,
            })),
            note: table.complete ? null : "组内尚有对抗未结束。",
          });
        }
      }
      const tieRows = await loadCompetitionTies(tx, competition.id);
      for (const fixture of tieRows) {
        if (fixture.kind === "GROUP") continue;
        knockout.push({
          code: fixture.code,
          kind: fixture.kind as "KNOCKOUT" | "THIRD_PLACE",
          round: fixture.round,
          sideA: fixture.sideAEntryId,
          sideB: fixture.sideBEntryId,
          winner: fixture.winnerEntryId,
        });
      }
      const settings = (draw.settings ?? {}) as { qualifiersPerGroup?: number };
      const computed = computePlacements({ format: draw.format, qualifiersPerGroup: settings.qualifiersPerGroup ?? 2, knockout, groups: confirmedGroups });
      placements = computed.placements
        .filter((item) => item.label !== "名次待定")
        .map((item) => ({ competitionCode: competition.code, place: item.place, label: item.label, ...nameOfId(item.entryId) }));
      placementsNote = computed.complete ? "由已确认的小组名次与已锁定的对抗胜负得出。" : "尚有名次未决出；只列出已由已确认结果决出的名次。";
    }

    competitions.push({
      code: competition.code,
      name: competition.name,
      kindLabel: KIND_LABEL[competition.kind] ?? competition.kind,
      team,
      format: draw ? DRAW_FORMAT_LABEL[draw.format] : null,
      entries: approved.map((entry) => ({ code: entry.code, name: entryName(entry, policy), team: teamOf(entry, policy), members: entry.members.map((member) => memberLabel(member.participant, policy)) })),
      groups,
      ties,
      rankings,
      placements,
      placementsNote,
      standingsVersion,
      standingsStale,
    });
  }

  // --- 规则摘要：取已公开比赛实际冻结的规则快照，没有时取赛事/项目默认 ---
  const ruleRows = await tx.ruleProfileRevision.findMany({
    where: {
      OR: [
        { matchSnapshots: { some: { match: { ...publishedMatchWhere, stage: { competition: { tournamentId } } } } } },
        { competitions: { some: { tournamentId } } },
        ...(tournament.defaultRuleRevision ? [{ id: tournament.defaultRuleRevision.id }] : []),
      ],
    },
    orderBy: [{ ruleProfile: { name: "asc" } }, { revision: "asc" }],
    select: {
      revision: true,
      sourceLabel: true,
      sourceVersion: true,
      config: true,
      configHash: true,
      ruleProfile: { select: { name: true } },
      competitions: { where: { tournamentId }, select: { code: true } },
    },
  });
  const rules: ReportRule[] = ruleRows.map((rule) => ({
    name: rule.ruleProfile.name,
    revision: rule.revision,
    source: `${rule.sourceLabel} ${rule.sourceVersion}`.trim(),
    configHash: rule.configHash.slice(0, 12),
    summary: projectRuleSummary(rule.config).text,
    usedBy: rule.competitions.map((item) => item.code),
  }));

  const specialResults = matches
    .filter((match) => match.showResult && match.outcome && match.outcome !== "NORMAL")
    .map((match) => {
      const winner = match.winner ? (match.winner === "A" ? match.sideA : match.sideB) : null;
      const parts = [`${match.code}：${match.outcomeLabel}`];
      if (winner) parts.push(`${winner.pending || !winner.code ? winner.name : winner.code} 胜`);
      if (match.partial) parts.push(`中止时本局比分 ${match.partial.a}:${match.partial.b}（保留实际比分，不补满）`);
      return { matchCode: match.code, text: parts.join("，") };
    });

  const confirmed = matches.filter((match) => match.confirmed).length;
  return {
    schema: 1,
    edition,
    tournament: {
      slug: tournament.slug,
      name: tournament.name,
      subtitle: tournament.subtitle,
      organizer: tournament.organizer,
      venue: tournament.venue,
      dates: dateRange(tournament.startDate, tournament.endDate),
      timezone: timeZone,
      summary: tournament.summary,
      regulations: tournament.regulations,
      namesPublic: policy === "DISPLAY_NAMES",
    },
    rules,
    rankingProfile: {
      name: CAMPUS_DEMO_RANKING.name,
      version: CAMPUS_DEMO_RANKING.version,
      demo: CAMPUS_DEMO_RANKING.demo,
      notice: CAMPUS_DEMO_RANKING.notice,
      rules: [...CAMPUS_DEMO_RANKING.rules],
    },
    competitions,
    matches,
    specialResults,
    counts: { matches: matches.length, confirmed, unconfirmed: matches.length - confirmed },
    standings,
  };
}

export function hashReportSnapshot(snapshot: unknown) {
  return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
}

/**
 * 在一个可重复读、只读的事务里取得快照：之后生成的 Excel、打印页和 PDF 都只用这一份数据。
 * `extra` 在同一事务里追加读取（例如内部报名名单），保证与快照同一时刻。
 */
export async function captureReportSnapshot<T = undefined>(
  tournamentId: string,
  edition: ReportEditionValue,
  extra?: (tx: Tx) => Promise<T>,
  options: SnapshotOptions = {},
): Promise<CapturedSnapshot & { extra: T }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      // 取纪元毫秒而不是 timestamptz：驱动把后者按会话时区解析时会偏移。
      const [{ ms }] = await tx.$queryRaw<{ ms: number }[]>`SELECT (extract(epoch FROM transaction_timestamp()) * 1000)::float8 AS ms`;
      const now = new Date(Number(ms));
      const snapshot = await buildReportSnapshot(tx, tournamentId, edition, options);
      const extraValue = (extra ? await extra(tx) : undefined) as T;
      return { snapshot, capturedAt: now, snapshotHash: hashReportSnapshot(snapshot), extra: extraValue };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000, maxWait: 10_000 },
  );
}

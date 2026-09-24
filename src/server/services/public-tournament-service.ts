import { prisma } from "@/db/client";
import type {
  PublicMatchPreview,
  PublicTournamentCard,
  PublicTournamentPreview,
  TournamentPhaseValue,
} from "@/features/public-results/model";
import type { ScheduleQueryOptions } from "@/features/public-results/query";
import {
  publicMatchSelect,
  publicScheduleSelect,
  publicTournamentCardSelect,
  publicTournamentSelect,
  publishedMatchWhere,
} from "@/reports/public-fields";
import { AppError } from "@/server/services/errors";
import {
  assertIanaTimeZone,
  isoDate,
  projectMatch,
  scheduleDateIn,
  scheduleDateOption,
  type MatchRow,
} from "@/server/services/public-projection";

/**
 * 公开路径段必须稳定、有长度上限，并且不与既有静态路由冲突。
 * 不合法输入一律走公开 404，不回显内部标识。
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const MATCH_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,30}$/;
const RESERVED_SLUGS = new Set(["preview", "api", "login", "board", "management", "officiating", "settings", "register"]);

export function isPublicTournamentSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && !RESERVED_SLUGS.has(value);
}

export function isPublicMatchCode(value: string): boolean {
  return MATCH_CODE_PATTERN.test(value);
}

/** 阶段 1 的公开白名单端点，保留给 `GET /api/public/tournaments/[slug]`。 */
export async function getPublicTournament(slug: string) {
  const tournament = await prisma.tournament.findFirst({
    where: { slug, status: "PUBLISHED" },
    select: publicTournamentSelect,
  });
  if (!tournament) throw new AppError(404, "tournament_not_found", "公开赛事不存在或尚未发布。");
  return tournament;
}

/**
 * 首页赛事列表。只返回已发布赛事，按生命周期分桶交给界面分组。
 * 每个赛事额外带上已发布比赛数和进行中比赛数，用于卡片上的简要信息。
 */
export async function listPublicTournaments(): Promise<PublicTournamentCard[]> {
  const tournaments = await prisma.tournament.findMany({
    where: { status: "PUBLISHED" },
    select: { ...publicTournamentCardSelect, id: true },
    orderBy: [{ startDate: "desc" }, { name: "asc" }],
  });
  if (!tournaments.length) return [];

  const ids = tournaments.map((tournament) => tournament.id);
  const [published, live] = await Promise.all([
    countMatchesByTournament(ids, {}),
    countMatchesByTournament(ids, { lifecycleStatus: "IN_PROGRESS" }),
  ]);

  return tournaments.map((tournament) => ({
    endDate: isoDate(tournament.endDate),
    liveMatchCount: live.get(tournament.id) ?? 0,
    name: tournament.name,
    organizer: tournament.organizer,
    phase: tournament.phase as TournamentPhaseValue,
    posterAlt: tournament.posterAlt,
    posterPath: tournament.posterPath,
    publishedMatchCount: published.get(tournament.id) ?? 0,
    slug: tournament.slug,
    startDate: isoDate(tournament.startDate),
    subtitle: tournament.subtitle,
    summary: tournament.summary,
    timezone: tournament.timezone,
    venue: tournament.venue,
  }));
}

async function countMatchesByTournament(
  tournamentIds: readonly string[],
  extra: { lifecycleStatus?: "IN_PROGRESS" },
) {
  const rows = await prisma.match.findMany({
    where: {
      ...publishedMatchWhere,
      ...extra,
      stage: { competition: { tournamentId: { in: [...tournamentIds] } } },
    },
    select: { stage: { select: { competition: { select: { tournamentId: true } } } } },
  });
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    const id = row.stage.competition.tournamentId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  });
  return counts;
}

export interface PublicTournamentHeader {
  name: string;
  slug: string;
  subtitle: string | null;
}

/**
 * 赛事是否存在且已发布。
 *
 * 赛事页布局用它在流式渲染开始前决定 404：赛程页有 `loading.tsx`，
 * 一旦进入该 Suspense 边界响应头就已经以 200 发出，页面内再 `notFound()`
 * 只能换掉内容、换不掉状态码。
 */
export async function getPublicTournamentHeader(slug: string): Promise<PublicTournamentHeader | null> {
  if (!isPublicTournamentSlug(slug)) return null;
  return prisma.tournament.findFirst({
    where: { slug, status: "PUBLISHED" },
    select: { name: true, slug: true, subtitle: true },
  });
}

export interface PublicScheduleResult {
  defaultDate: string;
  /** 已发布且有赛程日期的比赛，按服务端权威顺序。 */
  matches: PublicMatchPreview[];
  queryOptions: ScheduleQueryOptions;
  tournament: PublicTournamentPreview;
  /** 已发布但尚未确定日期的比赛；不硬塞进任何一天。 */
  unscheduled: PublicMatchPreview[];
}

/**
 * 赛事公开赛程。
 *
 * 顺序由服务端决定（计划时间 → 场地 → 比赛编号），界面不得自行按「进行中优先」重排。
 * 日期按赛事时区折算，绝不按访问设备时区。
 */
export async function getPublicSchedule(slug: string): Promise<PublicScheduleResult> {
  if (!isPublicTournamentSlug(slug)) {
    throw new AppError(404, "tournament_not_found", "公开赛事不存在或尚未发布。");
  }
  const tournament = await prisma.tournament.findFirst({
    where: { slug, status: "PUBLISHED" },
    select: publicScheduleSelect,
  });
  if (!tournament) throw new AppError(404, "tournament_not_found", "公开赛事不存在或尚未发布。");

  const timeZone = assertIanaTimeZone(tournament.timezone);

  interface Pending {
    competitionCode: string;
    competitionName: string;
    match: MatchRow;
    stageCode: string;
    stageName: string;
  }

  const pending: Pending[] = [];
  tournament.competitions.forEach((competition) => {
    competition.stages.forEach((stage) => {
      stage.matches.forEach((match) => {
        pending.push({
          competitionCode: competition.code,
          competitionName: competition.name,
          match: match as MatchRow,
          stageCode: stage.code,
          stageName: stage.name,
        });
      });
    });
  });

  // 权威赛程顺序：有计划时间的先按时间，再按场地编号，最后按比赛编号；
  // 没有计划时间的统一排到最后并归入「待排期」。
  pending.sort((first, second) => {
    const firstTime = first.match.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const secondTime = second.match.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (firstTime !== secondTime) return firstTime - secondTime;
    const firstCourt = first.match.court?.code ?? "￿";
    const secondCourt = second.match.court?.code ?? "￿";
    if (firstCourt !== secondCourt) return firstCourt < secondCourt ? -1 : 1;
    return first.match.code < second.match.code ? -1 : first.match.code > second.match.code ? 1 : 0;
  });

  const matches: PublicMatchPreview[] = [];
  const unscheduled: PublicMatchPreview[] = [];
  pending.forEach((item, index) => {
    const projected = projectMatch(item.match, {
      competitionCode: item.competitionCode,
      competitionName: item.competitionName,
      namePolicy: tournament.namePolicy,
      scheduleOrder: index,
      stageCode: item.stageCode,
      stageName: item.stageName,
      timeZone,
      updatedAt: tournament.updatedAt,
    });
    (projected.scheduleDate ? matches : unscheduled).push(projected);
  });

  const dates = [...new Set(matches.map((match) => match.scheduleDate))].sort();
  const dateOptions = dates.map((date) => scheduleDateOption(timeZone, date));
  const today = scheduleDateIn(timeZone, new Date());

  return {
    // 缺省日期只能从赛事已发布日期中确定；今天没有赛程时退回第一天，不静默换日到无效日期。
    defaultDate: dates.includes(today) ? today : dates[0] ?? today,
    matches,
    unscheduled,
    queryOptions: {
      competitions: [...new Set(matches.concat(unscheduled).map((match) => match.competitionCode))],
      courts: [...new Set(matches.concat(unscheduled).map((match) => match.court).filter((court): court is string => Boolean(court)))],
      dates,
      stages: [...new Set(matches.concat(unscheduled).map((match) => match.stageCode))],
    },
    tournament: {
      announcement: tournament.summary,
      dates: dateOptions,
      name: tournament.name,
      phase: tournament.phase as TournamentPhaseValue,
      slug: tournament.slug,
      subtitle: tournament.subtitle,
      timezone: timeZone,
      updatedAt: tournament.updatedAt.toISOString(),
      venue: tournament.venue,
    },
  };
}

export interface PublicMatchDetailResult {
  match: PublicMatchPreview;
  tournament: PublicTournamentPreview;
}

/**
 * 公开比赛详情。同时校验赛事、比赛归属和逐场发布边界：
 * 不存在、未发布或不属于该赛事的比赛统一返回公开 404，不泄露草稿或跨赛事信息。
 */
export async function getPublicMatchDetail(slug: string, matchCode: string): Promise<PublicMatchDetailResult> {
  if (!isPublicTournamentSlug(slug) || !isPublicMatchCode(matchCode)) {
    throw new AppError(404, "match_not_found", "比赛不存在或尚未公开。");
  }
  const tournament = await prisma.tournament.findFirst({
    where: { slug, status: "PUBLISHED" },
    select: {
      name: true,
      // 只在服务端读取，用于决定姓名与代表队是否公开。
      namePolicy: true,
      phase: true,
      slug: true,
      subtitle: true,
      summary: true,
      timezone: true,
      updatedAt: true,
      venue: true,
    },
  });
  if (!tournament) throw new AppError(404, "match_not_found", "比赛不存在或尚未公开。");

  const timeZone = assertIanaTimeZone(tournament.timezone);
  const match = await prisma.match.findFirst({
    where: {
      code: matchCode,
      ...publishedMatchWhere,
      stage: { competition: { tournament: { slug, status: "PUBLISHED" } } },
    },
    select: {
      ...publicMatchSelect,
      stage: {
        select: {
          code: true,
          name: true,
          competition: { select: { code: true, name: true } },
        },
      },
    },
  });
  if (!match) throw new AppError(404, "match_not_found", "比赛不存在或尚未公开。");

  return {
    match: projectMatch(match as MatchRow, {
      competitionCode: match.stage.competition.code,
      competitionName: match.stage.competition.name,
      namePolicy: tournament.namePolicy,
      scheduleOrder: 0,
      stageCode: match.stage.code,
      stageName: match.stage.name,
      timeZone,
      updatedAt: tournament.updatedAt,
    }),
    tournament: {
      announcement: tournament.summary,
      dates: [],
      name: tournament.name,
      phase: tournament.phase as TournamentPhaseValue,
      slug: tournament.slug,
      subtitle: tournament.subtitle,
      timezone: timeZone,
      updatedAt: tournament.updatedAt.toISOString(),
      venue: tournament.venue,
    },
  };
}

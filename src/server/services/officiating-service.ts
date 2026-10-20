import type { Prisma, RefereeMode, TournamentPhase } from "@/generated/prisma/client";
import { prisma } from "@/db/client";
import { AppError } from "@/server/services/errors";
import type { MatchScheduleStatus } from "@/domain/schedule/model";
import { loadPublishedDelays, matchStatusOf } from "@/server/services/schedule-facts";

/**
 * 「我的执裁」：先列出本账号能执裁的赛事（一个赛事一个入口），进入后再按场地/时间/项目查看比赛。
 * 列表只是导航；能否真正取得计分控制仍由 requireAssignedReferee 在服务端逐场判定。
 */

/** 本账号在这个赛事里能看到哪些比赛：共用裁判账号模式下是双方已确定的全部比赛，逐场指派模式下只有指派给本人的比赛。 */
function visibleMatchWhere(userId: string, tournamentId: string, refereeMode: RefereeMode): Prisma.MatchWhereInput {
  const inTournament = { stage: { competition: { tournamentId } } };
  if (refereeMode === "SHARED_ACCOUNT") {
    return { ...inTournament, sideAEntryId: { not: null }, sideBEntryId: { not: null }, notPlayedAt: null };
  }
  return { ...inTournament, officialAssignments: { some: { userId, active: true, role: "MAIN_REFEREE" } } };
}

async function officiatingRoles(userId: string) {
  const roles = await prisma.roleAssignment.findMany({
    where: { userId, role: { in: ["REFEREE", "CHIEF_REFEREE"] } },
    select: { tournamentId: true, role: true },
  });
  const byTournament = new Map<string, { referee: boolean; chief: boolean }>();
  for (const { tournamentId, role } of roles) {
    const entry = byTournament.get(tournamentId) ?? { referee: false, chief: false };
    if (role === "REFEREE") entry.referee = true;
    else entry.chief = true;
    byTournament.set(tournamentId, entry);
  }
  return byTournament;
}

export interface OfficiatingTournamentCard {
  slug: string;
  name: string;
  subtitle: string | null;
  venue: string | null;
  startDate: string | null;
  endDate: string | null;
  phase: TournamentPhase;
  posterPath: string | null;
  posterAlt: string | null;
  referee: boolean;
  chief: boolean;
  liveCount: number;
  upcomingCount: number;
  endedCount: number;
  reviewCount: number;
}

const dateOnly = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

export async function listOfficiatingTournaments(userId: string): Promise<OfficiatingTournamentCard[]> {
  const roles = await officiatingRoles(userId);
  if (!roles.size) return [];
  const tournaments = await prisma.tournament.findMany({
    where: { id: { in: [...roles.keys()] } },
    select: {
      id: true, slug: true, name: true, subtitle: true, venue: true, startDate: true, endDate: true,
      phase: true, posterPath: true, posterAlt: true, refereeMode: true,
    },
  });
  const cards = await Promise.all(tournaments.map(async (tournament) => {
    const role = roles.get(tournament.id)!;
    const matches = role.referee
      ? await prisma.match.findMany({
          where: visibleMatchWhere(userId, tournament.id, tournament.refereeMode),
          select: { lifecycleStatus: true, version: true, notPlayedAt: true },
        })
      : [];
    const statuses = matches.map(matchStatusOf);
    const reviewCount = role.chief
      ? await prisma.match.count({ where: { stage: { competition: { tournamentId: tournament.id } }, lifecycleStatus: "SUBMITTED" } })
      : 0;
    return {
      slug: tournament.slug,
      name: tournament.name,
      subtitle: tournament.subtitle,
      venue: tournament.venue,
      startDate: dateOnly(tournament.startDate),
      endDate: dateOnly(tournament.endDate),
      phase: tournament.phase,
      posterPath: tournament.posterPath,
      posterAlt: tournament.posterAlt,
      referee: role.referee,
      chief: role.chief,
      liveCount: statuses.filter((status) => status === "IN_PROGRESS").length,
      upcomingCount: statuses.filter((status) => status === "NOT_STARTED").length,
      endedCount: statuses.filter((status) => status === "ENDED" || status === "NOT_PLAYED").length,
      reviewCount,
    };
  }));
  // 有比赛正在进行的赛事排在最前，其次是还有待开赛比赛的，最后按开赛日期从近到远。
  const rank = (card: OfficiatingTournamentCard) => (card.liveCount ? 0 : card.upcomingCount || card.reviewCount ? 1 : 2);
  return cards.sort((left, right) =>
    rank(left) - rank(right) ||
    (right.startDate ?? "").localeCompare(left.startDate ?? "") ||
    left.name.localeCompare(right.name, "zh-CN"),
  );
}

const matchSelect = {
  id: true,
  code: true,
  lifecycleStatus: true,
  version: true,
  notPlayedAt: true,
  scheduledAt: true,
  scheduleEstimated: true,
  rubberKind: true,
  rubberOrder: true,
  sideAEntry: { select: { displayName: true } },
  sideBEntry: { select: { displayName: true } },
  court: { select: { id: true, name: true, sortOrder: true } },
  stage: { select: { competition: { select: { id: true, code: true, name: true } } } },
} as const;

export interface OfficiatingMatch {
  code: string;
  status: MatchScheduleStatus;
  /** 全新 0:0：还没有任何记分事件。 */
  fresh: boolean;
  scheduledAt: Date | null;
  scheduleEstimated: boolean;
  sideA: string;
  sideB: string;
  rubberKind: string | null;
  rubberOrder: number | null;
  court: { id: string; name: string; sortOrder: number } | null;
  competition: { id: string; code: string; name: string };
  /** 前场未完造成的预计推迟分钟数；只提示有现场事实为据的延误。 */
  delayMinutes: number | null;
}

export interface OfficiatingReviewMatch {
  code: string;
  verificationStatus: string;
  sideA: string;
  sideB: string;
  courtName: string | null;
}

export async function loadOfficiatingTournament(userId: string, slug: string, now = new Date()) {
  const tournament = await prisma.tournament.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, timezone: true, refereeMode: true },
  });
  if (!tournament) throw new AppError(404, "tournament_not_found", "赛事不存在。");
  const role = (await officiatingRoles(userId)).get(tournament.id);
  if (!role) throw new AppError(403, "forbidden", "你不是这个赛事的裁判员或裁判长。");

  const [rows, delays] = role.referee
    ? await Promise.all([
        prisma.match.findMany({ where: visibleMatchWhere(userId, tournament.id, tournament.refereeMode), select: matchSelect }),
        loadPublishedDelays(prisma, tournament.id, now),
      ])
    : [[], new Map()];
  const matches: OfficiatingMatch[] = rows.map((row) => {
    const delay = delays.get(row.id);
    return {
      code: row.code,
      status: matchStatusOf(row),
      fresh: row.lifecycleStatus === "READY" && row.version === 0,
      scheduledAt: row.scheduledAt,
      scheduleEstimated: row.scheduleEstimated,
      sideA: row.sideAEntry?.displayName ?? "待定",
      sideB: row.sideBEntry?.displayName ?? "待定",
      rubberKind: row.rubberKind,
      rubberOrder: row.rubberOrder,
      court: row.court,
      competition: row.stage.competition,
      delayMinutes: delay?.evidenced ? delay.delayMinutes : null,
    };
  });

  const reviewMatches: OfficiatingReviewMatch[] = role.chief
    ? (await prisma.match.findMany({
        where: { stage: { competition: { tournamentId: tournament.id } }, lifecycleStatus: "SUBMITTED" },
        select: {
          code: true,
          verificationStatus: true,
          sideAEntry: { select: { displayName: true } },
          sideBEntry: { select: { displayName: true } },
          court: { select: { name: true } },
        },
        orderBy: { updatedAt: "desc" },
      })).map((match) => ({
        code: match.code,
        verificationStatus: match.verificationStatus,
        sideA: match.sideAEntry?.displayName ?? "待定",
        sideB: match.sideBEntry?.displayName ?? "待定",
        courtName: match.court?.name ?? null,
      }))
    : [];

  return { tournament, role, matches, reviewMatches };
}

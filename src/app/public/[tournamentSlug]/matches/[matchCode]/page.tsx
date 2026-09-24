import { notFound } from "next/navigation";

import { MatchDetailView } from "@/features/public-results/match-detail-view";
import { preserveScheduleParams } from "@/features/public-results/query";
import { AppError } from "@/server/services/errors";
import { getPublicMatchDetail, getPublicSchedule } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

type SearchRecord = Record<string, string | string[] | undefined>;

function toSearchParams(record: SearchRecord) {
  const params = new URLSearchParams();
  Object.entries(record).forEach(([key, value]) => {
    if (typeof value === "string") params.set(key, value);
    else value?.forEach((item) => params.append(key, item));
  });
  return params;
}

export default async function PublicMatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ matchCode: string; tournamentSlug: string }>;
  searchParams: Promise<SearchRecord>;
}) {
  const { matchCode, tournamentSlug } = await params;

  let detail;
  let queryOptions;
  try {
    // 赛程的筛选选项用于把返回链接的 query 还原成合法值；
    // 不接受未经校验的任意 returnTo 外部地址。
    [detail, queryOptions] = await Promise.all([
      getPublicMatchDetail(tournamentSlug, matchCode),
      getPublicSchedule(tournamentSlug).then((schedule) => schedule.queryOptions),
    ]);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  const preservedQuery = preserveScheduleParams(toSearchParams(await searchParams), queryOptions).toString();

  return (
    <MatchDetailView
      basePath={`/public/${tournamentSlug}`}
      match={detail.match}
      mode="live"
      preservedQuery={preservedQuery}
      scenario="ready"
      tournament={detail.tournament}
    />
  );
}

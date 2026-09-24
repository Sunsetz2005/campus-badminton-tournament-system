import { notFound } from "next/navigation";

import {
  getPreviewMatch,
  PUBLIC_PREVIEW_QUERY_OPTIONS,
  PUBLIC_PREVIEW_TOURNAMENT,
} from "@/features/public-results/fixtures";
import { MatchDetailView } from "@/features/public-results/match-detail-view";
import type { PreviewScenario } from "@/features/public-results/model";
import { preserveScheduleParams } from "@/features/public-results/query";

type SearchRecord = Record<string, string | string[] | undefined>;

function toSearchParams(record: SearchRecord) {
  const params = new URLSearchParams();
  Object.entries(record).forEach(([key, value]) => {
    if (typeof value === "string") params.set(key, value);
    else value?.forEach((item) => params.append(key, item));
  });
  return params;
}

export default async function PublicMatchPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ matchCode: string; tournamentSlug: string }>;
  searchParams: Promise<SearchRecord>;
}) {
  const { matchCode } = await params;
  const match = getPreviewMatch(matchCode);
  if (!match) notFound();

  const input = toSearchParams(await searchParams);
  const rawScenario = input.get("scenario");
  const scenario: PreviewScenario = rawScenario === "loading" || rawScenario === "error" || rawScenario === "stale"
    ? rawScenario
    : "ready";
  const preservedQuery = preserveScheduleParams(input, PUBLIC_PREVIEW_QUERY_OPTIONS).toString();
  return (
    <MatchDetailView
      basePath={`/public/preview/${PUBLIC_PREVIEW_TOURNAMENT.slug}`}
      match={match}
      mode="preview"
      preservedQuery={preservedQuery}
      scenario={scenario}
      tournament={PUBLIC_PREVIEW_TOURNAMENT}
    />
  );
}

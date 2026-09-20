import { notFound } from "next/navigation";

import { getPreviewMatch, PUBLIC_PREVIEW_QUERY_OPTIONS } from "@/features/public-preview/fixtures";
import { MatchDetailPreview } from "@/features/public-preview/match-detail-preview";
import type { PreviewScenario } from "@/features/public-preview/model";
import { preserveScheduleParams } from "@/features/public-preview/query";

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
  return <MatchDetailPreview match={match} preservedQuery={preservedQuery} scenario={scenario} />;
}

import { Suspense } from "react";

import {
  PUBLIC_PREVIEW_MATCHES,
  PUBLIC_PREVIEW_QUERY_OPTIONS,
  PUBLIC_PREVIEW_TOURNAMENT,
} from "@/features/public-results/fixtures";
import { PublicScheduleSkeleton } from "@/features/public-results/resource-states";
import { PublicScheduleView } from "@/features/public-results/schedule-view";

export default function PublicSchedulePreviewPage() {
  return (
    <Suspense fallback={<PublicScheduleSkeleton />}>
      <PublicScheduleView
        defaultDate="2026-10-14"
        matchHrefBase={`/public/preview/${PUBLIC_PREVIEW_TOURNAMENT.slug}/matches`}
        matches={PUBLIC_PREVIEW_MATCHES}
        mode="preview"
        queryOptions={PUBLIC_PREVIEW_QUERY_OPTIONS}
        tournament={PUBLIC_PREVIEW_TOURNAMENT}
      />
    </Suspense>
  );
}

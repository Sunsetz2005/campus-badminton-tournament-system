import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PublicScheduleSkeleton } from "@/features/public-results/resource-states";
import { PublicScheduleView } from "@/features/public-results/schedule-view";
import { AppError } from "@/server/services/errors";
import { getPublicSchedule } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

export default async function PublicSchedulePage({
  params,
}: {
  params: Promise<{ tournamentSlug: string }>;
}) {
  const { tournamentSlug } = await params;

  // AppError 在 Server Component 中抛出会变成 500，页面层要改用 Next 的 notFound()。
  let schedule;
  try {
    schedule = await getPublicSchedule(tournamentSlug);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }

  return (
    <Suspense fallback={<PublicScheduleSkeleton />}>
      <PublicScheduleView
        defaultDate={schedule.defaultDate}
        matchHrefBase={`/public/${tournamentSlug}/matches`}
        matches={schedule.matches}
        mode="live"
        queryOptions={schedule.queryOptions}
        tournament={schedule.tournament}
        unscheduled={schedule.unscheduled}
      />
    </Suspense>
  );
}

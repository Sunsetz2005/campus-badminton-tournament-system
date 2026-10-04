import { notFound } from "next/navigation";

import { PublicResultsView } from "@/features/public-results/results-view";
import { AppError } from "@/server/services/errors";
import { getPublicResults } from "@/server/services/public-report-service";

export const dynamic = "force-dynamic";

export default async function PublicResultsPage({ params }: { params: Promise<{ tournamentSlug: string }> }) {
  const { tournamentSlug } = await params;
  let view;
  try {
    view = await getPublicResults(tournamentSlug);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
  return <PublicResultsView basePath={`/public/${tournamentSlug}`} capturedAt={view.capturedAt} snapshot={view.snapshot} />;
}

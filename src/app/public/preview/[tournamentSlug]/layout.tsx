import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { PUBLIC_PREVIEW_TOURNAMENT } from "@/features/public-preview/fixtures";

export default async function PreviewTournamentLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ tournamentSlug: string }> }>) {
  const { tournamentSlug } = await params;
  if (tournamentSlug !== PUBLIC_PREVIEW_TOURNAMENT.slug) notFound();
  return children;
}

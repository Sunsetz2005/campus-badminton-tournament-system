import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { PUBLIC_PREVIEW_TOURNAMENT } from "@/features/public-preview/fixtures";

export default async function PreviewMatchLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ matchCode: string; tournamentSlug: string }> }>) {
  const { tournamentSlug } = await params;
  if (tournamentSlug !== PUBLIC_PREVIEW_TOURNAMENT.slug) notFound();
  return children;
}

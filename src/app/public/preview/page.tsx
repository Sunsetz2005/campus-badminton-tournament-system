import { redirect } from "next/navigation";

import { PUBLIC_PREVIEW_TOURNAMENT } from "@/features/public-results/fixtures";

export default function PublicPreviewIndexPage() {
  redirect(`/public/preview/${PUBLIC_PREVIEW_TOURNAMENT.slug}/schedule`);
}

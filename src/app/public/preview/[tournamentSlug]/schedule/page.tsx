import { Suspense } from "react";

import { PublicSchedulePreview } from "@/features/public-preview/schedule-preview";
import { PublicScheduleSkeleton } from "@/features/public-preview/resource-states";

export default function PublicSchedulePreviewPage() {
  return (
    <Suspense fallback={<PublicScheduleSkeleton />}>
      <PublicSchedulePreview />
    </Suspense>
  );
}

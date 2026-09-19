import { redirect } from "next/navigation";

import { ScoringWorkbench } from "@/components/scoring-workbench";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function MatchOfficiatingPage({ params }: { params: Promise<{ matchCode: string }> }) {
  const { matchCode } = await params;
  const session = await getPageSession();
  if (!session) redirect(`/login?next=/officiating/${encodeURIComponent(matchCode)}`);
  await requireActivePageUser(session);
  return <ScoringWorkbench matchCode={matchCode} />;
}

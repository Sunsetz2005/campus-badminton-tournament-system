import type { ReactNode } from "react";

import { prisma } from "@/db/client";
import { ManagementSubnav } from "@/features/management/management-subnav";
import styles from "@/features/management/management.module.css";
import { TOURNAMENT_MANAGER_ROLES } from "@/server/auth/authorization";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { RESULTS_VIEW_ROLES } from "@/server/services/results-service";

export const dynamic = "force-dynamic";

export default async function TournamentManagementLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // 裁判长也能进入后台的「成绩名次」；其余页面各自仍只允许管理员/编排员。
  const { tournament, user } = await requireManagedTournamentPage(slug, RESULTS_VIEW_ROLES);
  const manager = await prisma.roleAssignment.findFirst({
    where: { userId: user.id, tournamentId: tournament.id, role: { in: TOURNAMENT_MANAGER_ROLES } },
    select: { id: true },
  });
  return (
    <div className={styles.page}>
      <ManagementSubnav resultsOnly={!manager} slug={tournament.slug} />
      {children}
    </div>
  );
}

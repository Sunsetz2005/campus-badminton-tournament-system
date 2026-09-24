import type { ReactNode } from "react";

import { ManagementSubnav } from "@/features/management/management-subnav";
import styles from "@/features/management/management.module.css";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";

export const dynamic = "force-dynamic";

export default async function TournamentManagementLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { tournament } = await requireManagedTournamentPage(slug);
  return (
    <div className={styles.page}>
      <ManagementSubnav slug={tournament.slug} />
      {children}
    </div>
  );
}

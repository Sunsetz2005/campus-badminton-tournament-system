import Link from "next/link";
import { forbidden, redirect } from "next/navigation";

import { prisma } from "@/db/client";
import styles from "@/features/management/management.module.css";
import { tournamentPhaseLabels } from "@/features/public-results/model";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function MyTeamsPage() {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/team");
  const user = await requireActivePageUser(session);
  const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mustChangePassword: true } });
  if (account.mustChangePassword) redirect("/account/password?next=/team");
  const bindings = await prisma.teamManager.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      team: { select: { id: true, name: true } },
      tournament: { select: { slug: true, name: true, phase: true } },
    },
  });
  if (!bindings.length) forbidden();
  const byTournament = new Map<string, { name: string; phase: keyof typeof tournamentPhaseLabels; teams: string[] }>();
  for (const { team, tournament } of bindings) {
    const current = byTournament.get(tournament.slug) ?? { name: tournament.name, phase: tournament.phase, teams: [] };
    current.teams.push(team.name);
    byTournament.set(tournament.slug, current);
  }
  return (
    <section className={styles.page}>
      <div className={styles.heading}>
        <p className="eyebrow">队伍负责人</p>
        <h1>我的队伍</h1>
        <p>只列出你负责的队伍。录入本队队员并提交团体赛名单后，由赛事管理员审核。</p>
      </div>
      <div className="card-grid">
        {[...byTournament.entries()].map(([slug, item]) => (
          <article className="card" key={slug}>
            <StatusBadge tone="info">{tournamentPhaseLabels[item.phase]}</StatusBadge>
            <h2>{item.name}</h2>
            <p>{item.teams.join("、")}</p>
            <p><Link href={`/team/${slug}`}>管理本队名单</Link></p>
          </article>
        ))}
      </div>
    </section>
  );
}

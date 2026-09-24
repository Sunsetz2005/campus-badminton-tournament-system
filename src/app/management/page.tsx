import Link from "next/link";
import { forbidden, redirect } from "next/navigation";

import { prisma } from "@/db/client";
import { tournamentPhaseLabels } from "@/features/public-results/model";
import { tournamentStatusLabel } from "@/features/management/labels";
import styles from "@/features/management/management.module.css";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function ManagementPage() {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/management");
  const user = await requireActivePageUser(session);
  const [account, assignments] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { systemRole: true } }),
    prisma.roleAssignment.findMany({
      where: { userId: user.id, role: { in: ["ADMIN", "ORGANIZER"] } },
      select: {
        role: true,
        tournament: {
          select: {
            id: true,
            slug: true,
            name: true,
            status: true,
            phase: true,
            createdAt: true,
            _count: { select: { competitions: true, registrations: { where: { status: "PENDING" } } } },
          },
        },
      },
      orderBy: { tournament: { createdAt: "desc" } },
    }),
  ]);
  const canCreate = account.systemRole === "SYSTEM_ADMIN";

  if (assignments.length === 0 && !canCreate) {
    forbidden();
  }

  return (
    <section className={styles.page}>
      <div className={styles.headingRow}>
        <div className={styles.heading}>
          <p className="eyebrow">服务端赛事范围校验</p>
          <h1>赛事管理</h1>
          <p>只列出你拥有管理员或编排员角色的赛事。报名审核、导入和邀请链接在各赛事内操作。</p>
        </div>
        {canCreate ? (
          <Link className="button" href="/management/new">新建赛事</Link>
        ) : null}
      </div>

      {assignments.length === 0 ? (
        <p className="empty-state">你还没有管理任何赛事。新建赛事后，你会自动成为该赛事的管理员。</p>
      ) : (
        <div className="card-grid">
          {assignments.map(({ role, tournament }) => (
            <article className="card" key={tournament.id}>
              <div className={styles.regMeta}>
                <StatusBadge tone={tournament.status === "PUBLISHED" ? "ok" : "warn"}>
                  {tournamentStatusLabel[tournament.status]}
                </StatusBadge>
                <StatusBadge tone="info">{tournamentPhaseLabels[tournament.phase]}</StatusBadge>
              </div>
              <h2>{tournament.name}</h2>
              <p>
                项目 {tournament._count.competitions} 个 · 待审核报名 {tournament._count.registrations} 份
              </p>
              <small>当前角色：{role === "ADMIN" ? "管理员" : "编排员"}</small>
              <p>
                <Link href={`/management/${tournament.slug}`}>进入赛事后台</Link>
              </p>
            </article>
          ))}
        </div>
      )}
      <p className="notice">
        抽签编排、赛程与裁判排班属于后续阶段，目前未实现；这里不会出现假按钮。
      </p>
    </section>
  );
}

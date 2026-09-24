import Link from "next/link";
import { forbidden, redirect } from "next/navigation";

import { prisma } from "@/db/client";
import { CreateTournamentWizard } from "@/features/management/create-tournament-wizard";
import styles from "@/features/management/management.module.css";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function NewTournamentPage() {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/management/new");
  const user = await requireActivePageUser(session);
  const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { systemRole: true } });
  // 与 API 相同的门禁：只有平台管理员能新建赛事。
  if (account.systemRole !== "SYSTEM_ADMIN") forbidden();

  return (
    <section className={styles.page}>
      <div className={styles.heading}>
        <p className="eyebrow"><Link href="/management">赛事管理</Link> / 新建</p>
        <h1>新建赛事</h1>
        <p>四步完成：基本信息、比赛项目、规则与报名、确认。创建者自动成为该赛事的管理员。</p>
      </div>
      <CreateTournamentWizard defaultTimezone="Asia/Shanghai" />
    </section>
  );
}

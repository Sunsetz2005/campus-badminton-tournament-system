import { forbidden, redirect } from "next/navigation";

import { prisma } from "@/db/client";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function ManagementPage() {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/management");
  const user = await requireActivePageUser(session);
  const assignments = await prisma.roleAssignment.findMany({
    where: { userId: user.id, role: { in: ["ADMIN", "ORGANIZER"] } },
    select: {
      role: true,
      tournament: {
        select: {
          id: true,
          name: true,
          status: true,
          _count: { select: { competitions: true, courts: true } },
        },
      },
    },
  });

  if (assignments.length === 0) {
    forbidden();
  }

  return (
    <section>
      <div className="section-heading">
        <p className="eyebrow">服务端赛事范围校验</p>
        <h1>赛事管理</h1>
        <p>这里只展示已授权赛事的数据库摘要；编辑、导入和编排功能尚未实现。</p>
      </div>
      <div className="card-grid">
        {assignments.map(({ role, tournament }) => (
          <article className="card" key={tournament.id}>
            <StatusBadge tone="warn">{tournament.status}</StatusBadge>
            <h2>{tournament.name}</h2>
            <p>项目 {tournament._count.competitions} 个 · 场地 {tournament._count.courts} 块</p>
            <small>当前角色：{role}</small>
          </article>
        ))}
      </div>
      <p className="notice">阶段 1 未提供新增、发布或删除按钮，避免让未实现操作产生假成功。</p>
    </section>
  );
}

import { redirect } from "next/navigation";

import { prisma } from "@/db/client";
import { requireActiveUser } from "@/server/auth/authorization";
import { getPageSession } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/settings");
  const user = await requireActiveUser(session);
  const roles = await prisma.roleAssignment.findMany({
    where: { userId: user.id },
    select: { role: true, tournament: { select: { name: true } } },
    orderBy: { role: "asc" },
  });

  return (
    <section className="narrow-page">
      <div className="section-heading">
        <p className="eyebrow">当前登录身份</p>
        <h1>设置</h1>
        <p>阶段 1 只提供账号与授权范围的只读检查。</p>
      </div>
      <dl className="details">
        <div><dt>姓名</dt><dd>{user.name}</dd></div>
        <div><dt>邮箱</dt><dd>{user.email}</dd></div>
        <div><dt>状态</dt><dd>{user.status}</dd></div>
        <div><dt>赛事角色</dt><dd>{roles.map((item) => `${item.tournament.name} · ${item.role}`).join("；") || "无"}</dd></div>
      </dl>
    </section>
  );
}

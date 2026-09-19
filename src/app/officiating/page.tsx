import { redirect } from "next/navigation";
import Link from "next/link";

import { prisma } from "@/db/client";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function OfficiatingPage() {
  const session = await getPageSession();
  if (!session) redirect("/login?next=/officiating");
  const user = await requireActivePageUser(session);
  const assignments = await prisma.officialAssignment.findMany({
    where: { userId: user.id, active: true },
    select: {
      role: true,
      match: {
        select: {
          code: true,
          lifecycleStatus: true,
          scheduledAt: true,
          sideAEntry: { select: { displayName: true } },
          sideBEntry: { select: { displayName: true } },
          court: { select: { name: true } },
        },
      },
    },
    orderBy: { match: { scheduledAt: "asc" } },
  });
  const chiefAssignments = await prisma.roleAssignment.findMany({
    where: { userId: user.id, role: "CHIEF_REFEREE" },
    select: { tournamentId: true },
  });
  const reviewMatches = chiefAssignments.length ? await prisma.match.findMany({
    where: {
      stage: { competition: { tournamentId: { in: chiefAssignments.map((item) => item.tournamentId) } } },
      lifecycleStatus: "SUBMITTED",
    },
    select: {
      code: true,
      verificationStatus: true,
      sideAEntry: { select: { displayName: true } },
      sideBEntry: { select: { displayName: true } },
      court: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
  }) : [];

  return (
    <section>
      <div className="section-heading">
        <p className="eyebrow">按真实指派读取</p>
        <h1>我的执裁</h1>
        <p>当前只验证身份、指派和单场控制会话基础；完整记分界面属于后续阶段。</p>
      </div>
      {assignments.length ? (
        <div className="card-grid">
          {assignments.map(({ match, role }) => (
            <article className="card" key={match.code}>
              <StatusBadge tone="ok">{match.lifecycleStatus}</StatusBadge>
              <h2>{match.code}</h2>
              <p>{match.sideAEntry?.displayName ?? "待定"} vs {match.sideBEntry?.displayName ?? "待定"}</p>
              <small>{match.court?.name ?? "场地待定"} · {role}</small>
              <Link className="button small" href={`/officiating/${match.code}`}>进入执裁</Link>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-state">当前账号没有有效裁判指派。</p>
      )}
      {chiefAssignments.length ? (
        <section className="stack" style={{ marginTop: "36px" }}>
          <div className="section-heading"><p className="eyebrow">裁判长权限</p><h2>待复核结果</h2></div>
          {reviewMatches.length ? reviewMatches.map((match) => (
            <article className="card" key={match.code}>
              <StatusBadge tone="warn">{match.verificationStatus}</StatusBadge>
              <h3>{match.code}</h3>
              <p>{match.sideAEntry?.displayName ?? "待定"} vs {match.sideBEntry?.displayName ?? "待定"}</p>
              <small>{match.court?.name ?? "场地待定"}</small>
              <Link className="button small" href={`/officiating/${match.code}`}>进入复核 / 接管</Link>
            </article>
          )) : <p className="empty-state">当前没有待复核结果。</p>}
        </section>
      ) : null}
    </section>
  );
}

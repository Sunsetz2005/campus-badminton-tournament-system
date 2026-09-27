import { redirect } from "next/navigation";
import Link from "next/link";

import { prisma } from "@/db/client";
import { RUBBER_LABEL, type RubberKind } from "@/domain/registration/team-roster";
import { formatZonedShort } from "@/domain/time/zoned-time";
import { loadPublishedDelays, matchStatusOf } from "@/server/services/schedule-facts";
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
          id: true,
          code: true,
          lifecycleStatus: true,
          version: true,
          notPlayedAt: true,
          scheduledAt: true,
          scheduleEstimated: true,
          rubberKind: true,
          rubberOrder: true,
          sideAEntry: { select: { displayName: true } },
          sideBEntry: { select: { displayName: true } },
          court: { select: { name: true } },
          stage: { select: { competition: { select: { tournament: { select: { id: true, slug: true, name: true, timezone: true } } } } } },
        },
      },
    },
    orderBy: { match: { scheduledAt: "asc" } },
  });
  assignments.sort((left, right) => {
    const leftFresh = left.match.lifecycleStatus === "READY" && left.match.version === 0;
    const rightFresh = right.match.lifecycleStatus === "READY" && right.match.version === 0;
    if (leftFresh !== rightFresh) return leftFresh ? -1 : 1;
    return (left.match.scheduledAt?.getTime() ?? 0) - (right.match.scheduledAt?.getTime() ?? 0);
  });
  // 按已发布赛程与实际开始/结束推算延误（服务器时间），只作提示。
  const now = new Date();
  const tournamentIds = [...new Set(assignments.map(({ match }) => match.stage.competition.tournament.id))];
  const delays = new Map(
    (await Promise.all(tournamentIds.map((id) => loadPublishedDelays(prisma, id, now)))).flatMap((map) => [...map.entries()]),
  );
  const liveLabel = (match: (typeof assignments)[number]["match"]) => {
    const status = matchStatusOf(match);
    if (status === "NOT_PLAYED") return { text: "未进行", tone: "neutral" as const };
    if (status === "ENDED") return { text: "已结束", tone: "ok" as const };
    if (status === "IN_PROGRESS") return { text: "进行中", tone: "info" as const };
    // 只提示有现场事实为据的延误（前面的比赛超时或晚结束），不因「过了计划时间」本身判为延误。
    const delay = delays.get(match.id);
    if (delay?.evidenced) return { text: `前场未完，预计推迟约 ${delay.delayMinutes} 分钟`, tone: "warn" as const };
    return match.lifecycleStatus === "READY" && match.version === 0 ? { text: "全新 · 0:0", tone: "ok" as const } : { text: "待开赛", tone: "neutral" as const };
  };
  const chiefAssignments = await prisma.roleAssignment.findMany({
    where: { userId: user.id, role: "CHIEF_REFEREE" },
    select: { tournamentId: true, tournament: { select: { slug: true, name: true } } },
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
        <p>按真实指派进入场地化裁判工作台：横向模拟场地、发接发标记、换位与换边、大比分与更正。所有写入都要服务器确认。</p>
      </div>
      {assignments.length ? (
        <div className="card-grid">
          {assignments.map(({ match, role }) => {
            const label = liveLabel(match);
            const timeZone = match.stage.competition.tournament.timezone;
            return (
              <article className="card" data-testid="assignment-card" key={match.code}>
                <StatusBadge tone={label.tone}>{label.text}</StatusBadge>
                <h2>{match.code}</h2>
                <p>
                  {match.sideAEntry?.displayName ?? "待定"} vs {match.sideBEntry?.displayName ?? "待定"}
                  {match.rubberKind && match.rubberOrder ? ` · 第 ${match.rubberOrder} 场${RUBBER_LABEL[match.rubberKind as RubberKind] ?? ""}` : ""}
                </p>
                <small>
                  {match.scheduledAt ? `${match.scheduleEstimated ? "约 " : ""}${formatZonedShort(match.scheduledAt, timeZone)} · ` : "时间待定 · "}
                  {match.court?.name ?? "场地待定"} · {role === "MAIN_REFEREE" ? "主裁判" : role}
                </small>
                <Link className="button small" href={`/officiating/${match.code}`}>进入执裁</Link>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="empty-state">当前账号没有有效裁判指派。</p>
      )}
      {chiefAssignments.length ? (
        <section className="stack" style={{ marginTop: "36px" }}>
          <div className="section-heading"><p className="eyebrow">裁判长权限</p><h2>现场赛程看板</h2></div>
          <div className="card-grid">
            {chiefAssignments.map((item) => (
              <article className="card" key={item.tournamentId}>
                <h3>{item.tournament.name}</h3>
                <p>按场地查看已发布赛程的现场状态与延误，临时更换裁判。</p>
                <Link className="button small" href={`/officiating/board/${item.tournament.slug}`}>打开看板</Link>
              </article>
            ))}
          </div>
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

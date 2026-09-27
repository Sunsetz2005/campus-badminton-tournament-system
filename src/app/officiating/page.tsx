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

const verificationLabel: Record<string, string> = {
  UNVERIFIED: "待复核",
  PENDING_REVIEW: "待复核",
  DISPUTED: "有争议",
  LOCKED: "已锁定",
  SUPERSEDED: "已被更正",
};

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
        <p className="eyebrow">裁判</p>
        <h1>我的执裁</h1>
        <p>这里只列出指派给你的比赛，全新 0:0 的比赛排在最前。进入后在场地化工作台记分；每一分都要服务器确认后才算数。</p>
      </div>
      {assignments.length ? (
        <div className="card-grid">
          {assignments.map(({ match, role }) => {
            const label = liveLabel(match);
            const timeZone = match.stage.competition.tournament.timezone;
            return (
              <article className="card assignment-card" data-testid="assignment-card" key={match.code}>
                <div className="assignment-head">
                  <StatusBadge tone={label.tone}>{label.text}</StatusBadge>
                  <span className="assignment-role">{role === "MAIN_REFEREE" ? "主裁判" : role}</span>
                </div>
                <h2>{match.code}</h2>
                <p className="assignment-vs">
                  <strong>{match.sideAEntry?.displayName ?? "待定"}</strong>
                  <span>vs</span>
                  <strong>{match.sideBEntry?.displayName ?? "待定"}</strong>
                </p>
                {match.rubberKind && match.rubberOrder ? (
                  <p className="assignment-rubber">第 {match.rubberOrder} 场{RUBBER_LABEL[match.rubberKind as RubberKind] ?? ""}</p>
                ) : null}
                <p className="assignment-meta">
                  <span>{match.scheduledAt ? `${match.scheduleEstimated ? "约 " : ""}${formatZonedShort(match.scheduledAt, timeZone)}` : "时间待定"}</span>
                  <span>{match.court?.name ?? "场地待定"}</span>
                </p>
                <Link className="button assignment-go" href={`/officiating/${match.code}`}>进入执裁</Link>
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
                <Link className="button secondary assignment-go" href={`/officiating/board/${item.tournament.slug}`}>打开看板</Link>
              </article>
            ))}
          </div>
          <div className="section-heading"><p className="eyebrow">裁判长权限</p><h2>待复核结果</h2></div>
          {reviewMatches.length ? (
            <div className="card-grid">
              {reviewMatches.map((match) => (
                <article className="card assignment-card" key={match.code}>
                  <div className="assignment-head">
                    <StatusBadge tone="warn">{verificationLabel[match.verificationStatus] ?? match.verificationStatus}</StatusBadge>
                  </div>
                  <h3>{match.code}</h3>
                  <p className="assignment-vs">
                    <strong>{match.sideAEntry?.displayName ?? "待定"}</strong>
                    <span>vs</span>
                    <strong>{match.sideBEntry?.displayName ?? "待定"}</strong>
                  </p>
                  <p className="assignment-meta"><span>{match.court?.name ?? "场地待定"}</span></p>
                  <Link className="button secondary assignment-go" href={`/officiating/${match.code}`}>进入复核 / 接管</Link>
                </article>
              ))}
            </div>
          ) : <p className="empty-state">当前没有待复核结果。</p>}
        </section>
      ) : null}
    </section>
  );
}

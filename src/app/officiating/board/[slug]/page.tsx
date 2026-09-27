import Link from "next/link";
import { forbidden, notFound, redirect } from "next/navigation";

import styles from "@/features/management/management.module.css";
import { ScheduleFilters, ScheduleRows } from "@/features/schedule/schedule-rows";
import local from "@/features/schedule/schedule.module.css";
import { requireManagedTournament } from "@/server/auth/authorization";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { AppError } from "@/server/services/errors";
import { loadScheduleWorkspace } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

/**
 * 裁判长现场看板：已发布赛程按时间与场地排列，显示待开赛/进行中/已结束/延误，可临时更换裁判。
 * 只认本赛事的裁判长角色；赛事管理员身份不会因此获得这里的权限，反之亦然。
 */
export default async function ChiefBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const pick = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : undefined);
  const session = await getPageSession();
  if (!session) redirect(`/login?next=/officiating/board/${encodeURIComponent(slug)}`);
  const user = await requireActivePageUser(session);
  let tournament: Awaited<ReturnType<typeof requireManagedTournament>>["tournament"];
  try {
    ({ tournament } = await requireManagedTournament(user.id, slug, ["CHIEF_REFEREE"]));
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    if (error instanceof AppError && error.status === 403) forbidden();
    throw error;
  }
  const workspace = await loadScheduleWorkspace(tournament.id, new Date(), {
    day: pick("day"),
    court: pick("court"),
    competition: pick("competition"),
    problemsOnly: pick("problems") === "1",
  });
  const basePath = `/officiating/board/${tournament.slug}`;

  return (
    <section className={styles.page}>
      <div className={styles.heading}>
        <p className="eyebrow"><Link href="/officiating">我的执裁</Link> · 裁判长</p>
        <h1>{tournament.name} · 现场看板</h1>
        <p>延误按实际开始/结束与服务器时间推算，只是提示；是否顺延、何时叫场由裁判长现场决定。时间按赛事时区 {workspace.timeZone} 显示。</p>
      </div>
      <div className={local.summary}>
        <div><strong>{workspace.publishedRows.filter((row) => row.status === "IN_PROGRESS").length}</strong><span>进行中</span></div>
        <div className={workspace.delayedCount ? local.bad : undefined}><strong>{workspace.delayedCount}</strong><span>延误</span></div>
        <div><strong>{workspace.publishedRows.filter((row) => row.status === "ENDED").length}</strong><span>已结束</span></div>
      </div>
      <section className={styles.section}>
        <ScheduleFilters
          basePath={basePath}
          competitions={workspace.competitions}
          courts={workspace.courts}
          days={workspace.publishedDays}
          params={{ day: pick("day"), court: pick("court"), competition: pick("competition"), problems: pick("problems") }}
        />
        <ScheduleRows
          canReplaceReferee
          courts={workspace.courts.map((court) => ({ id: court.id, code: court.code, name: court.name, active: court.active }))}
          mode="published"
          referees={workspace.referees}
          rows={workspace.publishedRows.filter((row) => row.published.start)}
          slug={tournament.slug}
          timeZone={workspace.timeZone}
        />
      </section>
    </section>
  );
}

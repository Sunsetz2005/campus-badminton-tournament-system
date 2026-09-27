import Link from "next/link";
import { forbidden, notFound, redirect } from "next/navigation";

import { prisma } from "@/db/client";
import type { RubberKind } from "@/domain/registration/team-roster";
import styles from "@/features/management/management.module.css";
import { LineupEditor } from "@/features/team/lineup-editor";
import { LineupProgress, RubberTable, TieHeader, TieSchedule } from "@/features/team/tie-views";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { AppError } from "@/server/services/errors";
import { loadFixtureScheduleFacts, loadScheduleConfig } from "@/server/services/schedule-facts";
import { loadManagerTies, loadRosterForLineup, projectTie } from "@/server/services/team-tie-service";

export const dynamic = "force-dynamic";

/**
 * 负责人的单场对抗页：提交本队出场名单（盲交），交齐后查看双方名单与小场结果。
 * 只列出本人负责的队伍参加的对抗；对方名单在交齐前不会下发到浏览器。
 */
export default async function TeamTiePage({ params }: { params: Promise<{ slug: string; fixtureId: string }> }) {
  const { slug, fixtureId } = await params;
  const session = await getPageSession();
  if (!session) redirect(`/login?next=/team/${encodeURIComponent(slug)}/ties/${encodeURIComponent(fixtureId)}`);
  const user = await requireActivePageUser(session);
  const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mustChangePassword: true } });
  if (account.mustChangePassword) redirect(`/account/password?next=/team/${encodeURIComponent(slug)}`);

  let data: Awaited<ReturnType<typeof loadManagerTies>>;
  try {
    data = await loadManagerTies(user.id, slug);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    if (error instanceof AppError && error.status === 403) forbidden();
    throw error;
  }
  const item = data.ties.find((tie) => tie.fixture.id === fixtureId);
  if (!item) notFound();
  const { fixture, side } = item;
  const tournamentId = data.access.tournament.id;
  const [config, scheduleFacts] = await Promise.all([
    loadScheduleConfig(prisma, tournamentId),
    loadFixtureScheduleFacts(prisma, tournamentId, fixture.id),
  ]);
  const view = projectTie(fixture, { kind: "TEAM_MANAGER", side }, config);
  const own = view.sides.find((entry) => entry.side === side);
  const phaseOpen = data.access.tournament.phase === "REGISTRATION_CLOSED" || data.access.tournament.phase === "RUNNING";
  const now = new Date();
  const deadlinePassed = scheduleFacts.deadline !== null && now >= scheduleFacts.deadline;
  const canEdit = Boolean(own?.entry) && !view.revealedAt && phaseOpen && !deadlinePassed;
  const roster = own?.entry ? await loadRosterForLineup(own.entry.id) : [];
  const initial = Object.fromEntries(
    view.rubbers.map((rubber) => [rubber.order, (rubber.players[side] ?? []).map((player) => player.participantId)]),
  );

  return (
    <section className={styles.page}>
      <div className={styles.heading}>
        <p className="eyebrow">
          <Link href={`/team/${data.access.tournament.slug}`}>我的队伍</Link> · {view.competition.code} {view.competition.name}
        </p>
        <h1>{view.label}</h1>
      </div>
      <TieHeader view={view} />
      <TieSchedule now={now} timeZone={data.access.tournament.timezone} view={view} />
      <LineupProgress view={view} />

      {canEdit ? (
        <section aria-labelledby="lineup-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="lineup-title">本队出场名单</h2>
            <p>
              双方各自提交，交齐前互相看不到对方名单；两边都交齐后同时公开并锁定，之后只有裁判长能按原因调整尚未开始的小场。
              每个位置只列出报名时报了该项的队员。
            </p>
          </div>
          <LineupEditor
            endpoint={`/api/team/${data.access.tournament.slug}/fixtures/${fixture.id}/lineup`}
            expectedVersion={own?.lineup?.version ?? null}
            initial={initial}
            roster={roster}
            rubbers={view.rubbers.map((rubber) => ({ order: rubber.order, kind: rubber.kind as RubberKind }))}
            submitLabel={own?.lineup ? "保存名单修改" : "提交出场名单"}
            limits={view.limits}
            overlappingOrders={scheduleFacts.overlappingOrders}
          />
        </section>
      ) : !own?.entry ? (
        <p className={styles.info}>本队这一侧尚未确定，前序结果产生后才能排出场名单。</p>
      ) : !view.revealedAt && deadlinePassed ? (
        <p className={styles.alert} data-testid="lineup-deadline-passed">
          已过出场名单截止时间，负责人不能再提交或修改；请尽快联系赛事管理员代交（会标记为逾期代交）。
        </p>
      ) : !view.revealedAt ? (
        <p className={styles.info}>当前赛事阶段不能提交出场名单。</p>
      ) : null}

      <section aria-labelledby="rubbers-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="rubbers-title">小场</h2>
          <p>{view.revealedAt ? "双方名单已公开。结果以裁判长复核锁定为准。" : "对方名单在双方交齐后才会显示。"}</p>
        </div>
        <RubberTable timeZone={data.access.tournament.timezone} view={view} />
      </section>
    </section>
  );
}

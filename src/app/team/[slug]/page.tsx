import Link from "next/link";
import { forbidden, notFound, redirect } from "next/navigation";

import { prisma } from "@/db/client";
import { describeRubbers, GENDER_LABEL, type RubberKind } from "@/domain/registration/team-roster";
import { formatZoned, formatZonedShort } from "@/domain/time/zoned-time";
import { registrationStatusLabel, registrationStatusTone } from "@/features/management/labels";
import styles from "@/features/management/management.module.css";
import { TeamRosterEditor, type RosterMemberDraft } from "@/features/management/team-roster-editor";
import { tournamentPhaseLabels } from "@/features/public-results/model";
import { WithdrawRosterButton } from "@/features/team/withdraw-roster-button";
import { requireTeamManagerAccess } from "@/server/auth/authorization";
import { requireActivePageUser } from "@/server/auth/page-authorization";
import { getPageSession } from "@/server/auth/session";
import { AppError } from "@/server/services/errors";
import { lockedCompetitionIds } from "@/server/services/registration-service";
import { loadScheduleConfig } from "@/server/services/schedule-facts";
import { loadManagerTies, projectTie } from "@/server/services/team-tie-service";
import { TIE_STATUS_LABEL } from "@/domain/team/tie";
import { sideName } from "@/features/team/tie-views";
import { teamFormatOf } from "@/server/services/team-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function TeamPortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getPageSession();
  if (!session) redirect(`/login?next=/team/${encodeURIComponent(slug)}`);
  const user = await requireActivePageUser(session);
  let access: Awaited<ReturnType<typeof requireTeamManagerAccess>>;
  try {
    access = await requireTeamManagerAccess(user.id, slug);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    if (error instanceof AppError && error.status === 403) forbidden();
    throw error;
  }
  const account = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mustChangePassword: true } });
  if (account.mustChangePassword) redirect(`/account/password?next=/team/${encodeURIComponent(slug)}`);

  const { tournament } = access;
  const now = new Date();
  const windowOpen =
    tournament.phase === "REGISTRATION_OPEN" &&
    (!tournament.registrationOpensAt || now >= tournament.registrationOpensAt) &&
    (!tournament.registrationClosesAt || now < tournament.registrationClosesAt);

  const competitions = await prisma.competition.findMany({
    where: { tournamentId: tournament.id, entryType: "TEAM" },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, teamRubbers: true, teamRosterMin: true, teamRosterMax: true, teamMinMale: true, teamMinFemale: true },
  });
  const locked = await prisma.$transaction((transaction) =>
    lockedCompetitionIds(transaction, tournament.phase, competitions.map((item) => item.id)),
  );
  // 只读取本人负责的队伍的报名。
  const registrations = await prisma.registration.findMany({
    where: { tournamentId: tournament.id, teamId: { in: access.teams.map((team) => team.id) } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      teamId: true,
      competitionId: true,
      status: true,
      version: true,
      referenceCode: true,
      note: true,
      reviewReason: true,
      entry: { select: { code: true, frozenAt: true } },
      members: { orderBy: { slot: "asc" }, select: { displayName: true, studentId: true, gender: true, contact: true, rubberKinds: true } },
    },
  });

  // 已发布抽签中本人队伍参加的团体对抗（名单内容按盲交规则裁剪）。
  const { ties } = await loadManagerTies(user.id, slug);
  const scheduleConfig = await loadScheduleConfig(prisma, tournament.id);
  const tieViews = ties.map(({ fixture, side }) => ({ side, view: projectTie(fixture, { kind: "TEAM_MANAGER", side }, scheduleConfig) }));

  return (
    <section className={styles.page}>
      <div className={styles.heading}>
        <p className="eyebrow"><Link href="/team">我的队伍</Link></p>
        <h1>{tournament.name}</h1>
        <div className={styles.regMeta}>
          <StatusBadge tone={windowOpen ? "ok" : "warn"}>{windowOpen ? "报名中" : tournamentPhaseLabels[tournament.phase]}</StatusBadge>
          {tournament.registrationClosesAt ? <span>报名截止：{formatZoned(tournament.registrationClosesAt, tournament.timezone)}</span> : null}
        </div>
        {!windowOpen ? <p className={styles.info}>当前不在报名时间内，名单只能查看，不能提交或修改。</p> : null}
      </div>

      {competitions.length === 0 ? <p className={styles.info}>本赛事暂未设置团体项目。</p> : null}

      {tieViews.length ? (
        <section aria-labelledby="ties-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="ties-title">团体对抗与出场名单</h2>
            <p>抽签已发布。每场对抗前提交本队出场名单；双方交齐前互相看不到。</p>
          </div>
          <ul className={styles.tieList} data-testid="manager-ties">
            {tieViews.map(({ side, view }) => {
              const own = view.sides.find((item) => item.side === side);
              const other = side === "A" ? "B" : "A";
              const started = view.summary.status !== "NOT_STARTED";
              return (
                <li key={view.id}>
                  <span className={styles.muted}>{view.competition.code} · {view.code}</span>
                  <span className={styles.tieVs}>
                    <strong>{view.label}</strong>：对阵 {sideName(view, other)}
                    <br />
                    <span className={styles.muted}>
                      {!own?.entry
                        ? "本队一侧待定"
                        : view.revealedAt
                          ? "双方名单已公开"
                          : own.lineup
                            ? `本队名单已提交（第 ${own.lineup.version} 版），等待对方`
                            : "本队尚未提交出场名单"}
                      {" · "}
                      {TIE_STATUS_LABEL[view.summary.status]}
                      {view.schedule.firstStart ? (
                        <>
                          <br />
                          {formatZonedShort(new Date(view.schedule.firstStart), tournament.timezone)} 开始
                          {view.schedule.courts.length ? ` · ${view.schedule.courts.join("、")}` : ""}
                          {view.schedule.lineupDeadline && !view.revealedAt
                            ? ` · 名单截止 ${formatZonedShort(new Date(view.schedule.lineupDeadline), tournament.timezone)}`
                            : ""}
                        </>
                      ) : null}
                    </span>
                  </span>
                  <span className={styles.actions}>
                    {started ? (
                      <span className={styles.tieScoreSmall}>
                        {side === "A" ? `${view.summary.rubbers.A}:${view.summary.rubbers.B}` : `${view.summary.rubbers.B}:${view.summary.rubbers.A}`}
                      </span>
                    ) : null}
                    <Link className="button small" href={`/team/${tournament.slug}/ties/${view.id}`}>
                      {own?.entry && !view.revealedAt ? (own.lineup ? "修改名单" : "排出场名单") : "查看"}
                    </Link>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {access.teams.map((team) => (
        <section aria-labelledby={`team-${team.id}`} className={styles.section} key={team.id}>
          <div className={styles.sectionTitle}>
            <h2 id={`team-${team.id}`}>{team.name}</h2>
            <p>队伍编号 {team.code}</p>
          </div>
          {competitions.map((competition) => {
            const history = registrations.filter((item) => item.teamId === team.id && item.competitionId === competition.id);
            const active = history.find((item) => item.status === "PENDING" || item.status === "APPROVED");
            const lastRejected = !active ? history.find((item) => item.status === "REJECTED") : undefined;
            const format = teamFormatOf(competition);
            const canEdit = windowOpen && !locked.has(competition.id) && active?.status !== "APPROVED";
            const initialMembers: RosterMemberDraft[] = (active?.members ?? []).map((member) => ({
              displayName: member.displayName,
              studentId: member.studentId ?? "",
              gender: member.gender ?? "",
              contact: member.contact ?? "",
              rubberKinds: member.rubberKinds as RubberKind[],
            }));
            return (
              <div className={styles.form} key={competition.id}>
                <div className={styles.regMeta}>
                  <strong>{competition.code} {competition.name}</strong>
                  {active ? (
                    <>
                      <StatusBadge tone={registrationStatusTone[active.status]}>{registrationStatusLabel[active.status]}</StatusBadge>
                      <span>回执 {active.referenceCode}</span>
                    </>
                  ) : (
                    <StatusBadge tone="neutral">尚未提交</StatusBadge>
                  )}
                  {locked.has(competition.id) ? <StatusBadge tone="info">已抽签，名单锁定</StatusBadge> : null}
                </div>
                {lastRejected ? (
                  <p className={styles.alert}>上一份名单（{lastRejected.referenceCode}）被退回：{lastRejected.reviewReason}</p>
                ) : null}
                {active?.status === "APPROVED" ? (
                  <>
                    <p className={styles.success}>
                      名单已审核通过{active.entry ? `，报名单位编号 ${active.entry.code}` : ""}。如需调整，请联系赛事管理员。
                    </p>
                    <ol className={styles.members}>
                      {active.members.map((member) => (
                        <li key={member.studentId}>
                          <b>{member.displayName}</b>
                          <span>{member.studentId}</span>
                          <span>{member.gender ? GENDER_LABEL[member.gender] : ""}</span>
                          <span>{describeRubbers(member.rubberKinds as RubberKind[])}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : null}
                {canEdit ? (
                  <TeamRosterEditor
                    competition={competition}
                    endpoint={`/api/team/${tournament.slug}/teams/${team.id}/roster`}
                    expectedVersion={active ? active.version : null}
                    format={format}
                    initialMembers={initialMembers}
                    initialNote={active?.note ?? ""}
                    submitLabel={active ? "保存名单修改" : "提交名单"}
                  />
                ) : active?.status === "PENDING" ? (
                  <ol className={styles.members}>
                    {active.members.map((member) => (
                      <li key={member.studentId}>
                        <b>{member.displayName}</b>
                        <span>{member.studentId}</span>
                        <span>{member.gender ? GENDER_LABEL[member.gender] : ""}</span>
                        <span>{describeRubbers(member.rubberKinds as RubberKind[])}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {active?.status === "PENDING" && windowOpen ? (
                  <WithdrawRosterButton registrationId={active.id} slug={tournament.slug} version={active.version} />
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
    </section>
  );
}

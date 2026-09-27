import { prisma } from "@/db/client";
import { describeRubbers, type RubberKind } from "@/domain/registration/team-roster";
import { registrationStatusLabel, registrationStatusTone } from "@/features/management/labels";
import styles from "@/features/management/management.module.css";
import { CreateTeamForm, TeamManagersPanel, type ManagerRow } from "@/features/management/team-admin-panels";
import { TeamRosterEditor, type RosterMemberDraft } from "@/features/management/team-roster-editor";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { lockedCompetitionIds, REGISTRATION_EDITABLE_PHASES } from "@/server/services/registration-service";
import { teamFormatOf } from "@/server/services/team-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function TeamsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tournament, role } = await requireManagedTournamentPage(slug);
  const isAdmin = role === "ADMIN";
  const editable = REGISTRATION_EDITABLE_PHASES.includes(tournament.phase);

  const [teams, competitions] = await Promise.all([
    prisma.team.findMany({
      where: { tournamentId: tournament.id },
      orderBy: { code: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        managers: {
          orderBy: { createdAt: "asc" },
          select: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                status: true,
                mustChangePassword: true,
                systemRole: true,
                provisionedForTournamentId: true,
                _count: { select: { roleAssignments: true } },
              },
            },
          },
        },
        registrations: {
          where: { status: { in: ["PENDING", "APPROVED"] } },
          select: {
            id: true,
            competitionId: true,
            status: true,
            version: true,
            referenceCode: true,
            note: true,
            entry: { select: { code: true, frozenAt: true } },
            members: {
              orderBy: { slot: "asc" },
              select: { displayName: true, studentId: true, gender: true, contact: true, rubberKinds: true },
            },
          },
        },
      },
    }),
    prisma.competition.findMany({
      where: { tournamentId: tournament.id, entryType: "TEAM" },
      orderBy: { code: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        teamRubbers: true,
        teamRosterMin: true,
        teamRosterMax: true,
        teamMinMale: true,
        teamMinFemale: true,
      },
    }),
  ]);
  const locked = await prisma.$transaction((transaction) =>
    lockedCompetitionIds(transaction, tournament.phase, competitions.map((item) => item.id)),
  );

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow">团体赛报名</p>
        <h1>队伍与负责人</h1>
        <p>
          每个学院建一支队伍，再为它开通负责人账号。负责人登录后在「我的队伍」录入本院队员并提交团体赛名单，提交后仍须在「报名审核」通过才进入抽签。
          负责人账号只能看到和提交本队名单，没有任何管理或执裁权限。
        </p>
      </div>

      {competitions.length === 0 ? (
        <p className={styles.info}>本赛事还没有团体项目。可在「赛事概览 → 新增项目或组别」里添加团体赛。</p>
      ) : (
        <ul className={styles.chips}>
          {competitions.map((competition) => (
            <li key={competition.id}>
              <strong>{competition.code} {competition.name}</strong>
              <span className={styles.muted}>
                {describeRubbers(teamFormatOf(competition).rubbers)} · 名单 {competition.teamRosterMin}—{competition.teamRosterMax} 人
              </span>
              {locked.has(competition.id) ? <StatusBadge tone="info">已抽签 · 名单锁定</StatusBadge> : null}
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <section aria-labelledby="new-team-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="new-team-title">新建队伍</h2>
            <p>名称在赛事内唯一，忽略全半角与空格差异。</p>
          </div>
          <CreateTeamForm slug={tournament.slug} />
        </section>
      ) : null}

      <section aria-labelledby="teams-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="teams-title">全部队伍（{teams.length}）</h2>
          <p>学号与联系方式只在后台可见。</p>
        </div>
        {teams.length === 0 ? (
          <p className="empty-state">还没有队伍。</p>
        ) : (
          <ul className={styles.list}>
            {teams.map((team) => {
              const managers: ManagerRow[] = team.managers.map(({ user }) => ({
                userId: user.id,
                name: user.name,
                email: user.email,
                status: user.status,
                mustChangePassword: user.mustChangePassword,
                resettable:
                  user.provisionedForTournamentId === tournament.id && user.systemRole === "USER" && user._count.roleAssignments === 0,
              }));
              return (
                <li className={styles.teamCard} data-testid="team-card" key={team.id}>
                  <div className={styles.teamHead}>
                    <h3>{team.name}</h3>
                    <span className={styles.muted}>{team.code}</span>
                  </div>
                  <TeamManagersPanel canManageAccounts={isAdmin} managers={managers} slug={tournament.slug} teamId={team.id} teamName={team.name} />
                  {competitions.map((competition) => {
                    const registration = team.registrations.find((item) => item.competitionId === competition.id);
                    const canEdit = editable && !locked.has(competition.id) && registration?.status !== "APPROVED";
                    const initialMembers: RosterMemberDraft[] = (registration?.members ?? []).map((member) => ({
                      displayName: member.displayName,
                      studentId: member.studentId ?? "",
                      gender: member.gender ?? "",
                      contact: member.contact ?? "",
                      rubberKinds: member.rubberKinds as RubberKind[],
                    }));
                    return (
                      <div className={styles.form} key={competition.id}>
                        <div className={styles.regMeta}>
                          <strong>{competition.code}</strong>
                          {registration ? (
                            <>
                              <StatusBadge tone={registrationStatusTone[registration.status]}>{registrationStatusLabel[registration.status]}</StatusBadge>
                              <span>{registration.referenceCode} · {registration.members.length} 人</span>
                              {registration.entry ? <span>报名单位 {registration.entry.code}{registration.entry.frozenAt ? "（已冻结）" : ""}</span> : null}
                            </>
                          ) : (
                            <span>尚未提交名单</span>
                          )}
                        </div>
                        {canEdit ? (
                          <details>
                            <summary>{registration ? "代为修改待审核名单" : "代为录入名单"}</summary>
                            <TeamRosterEditor
                              competition={competition}
                              endpoint={`/api/admin/tournaments/${tournament.slug}/teams/${team.id}/roster`}
                              expectedVersion={registration ? registration.version : null}
                              format={teamFormatOf(competition)}
                              initialMembers={initialMembers}
                              initialNote={registration?.note ?? ""}
                              submitLabel={registration ? "保存名单修改" : "提交名单"}
                            />
                          </details>
                        ) : null}
                      </div>
                    );
                  })}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

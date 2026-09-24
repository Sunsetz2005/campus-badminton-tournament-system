import Link from "next/link";

import type { RegistrationStatus } from "@/generated/prisma/enums";
import { prisma } from "@/db/client";
import { formatZoned } from "@/domain/time/zoned-time";
import {
  entryTypeLabel,
  registrationSourceLabel,
  registrationStatusLabel,
  registrationStatusTone,
} from "@/features/management/labels";
import styles from "@/features/management/management.module.css";
import { ImportPanel, ManualRegistrationForm, RenameParticipantForm } from "@/features/management/registration-entry";
import {
  BatchApproveButton,
  RegistrationReviewActions,
  type MemberIdentityView,
} from "@/features/management/registration-review";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import {
  lockedCompetitionIds,
  previewIdentity,
  REGISTRATION_EDITABLE_PHASES,
} from "@/server/services/registration-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

const STATUSES: RegistrationStatus[] = ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"];
const PAGE_LIMIT = 200;

export default async function RegistrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string; competition?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const { tournament } = await requireManagedTournamentPage(slug);
  const status = STATUSES.includes(query.status as RegistrationStatus) ? (query.status as RegistrationStatus) : "PENDING";

  const competitions = await prisma.competition.findMany({
    where: { tournamentId: tournament.id },
    select: { id: true, code: true, name: true, entryType: true },
    orderBy: { code: "asc" },
  });
  const competitionFilter = competitions.find((item) => item.code === query.competition) ?? null;
  const locked = await prisma.$transaction((transaction) =>
    lockedCompetitionIds(transaction, tournament.phase, competitions.map((item) => item.id)),
  );

  const [registrations, counts, participants] = await Promise.all([
    prisma.registration.findMany({
      where: { tournamentId: tournament.id, status, ...(competitionFilter ? { competitionId: competitionFilter.id } : {}) },
      select: {
        id: true,
        referenceCode: true,
        status: true,
        source: true,
        version: true,
        note: true,
        reviewReason: true,
        reviewedAt: true,
        createdAt: true,
        importRowNumber: true,
        competition: { select: { id: true, code: true, name: true, entryType: true } },
        entry: { select: { code: true } },
        invite: { select: { label: true } },
        reviewedBy: { select: { name: true } },
        members: {
          select: {
            slot: true,
            displayName: true,
            studentId: true,
            teamName: true,
            contact: true,
            participant: { select: { publicCode: true } },
          },
          orderBy: { slot: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
      take: PAGE_LIMIT,
    }),
    prisma.registration.groupBy({
      by: ["status"],
      where: { tournamentId: tournament.id, ...(competitionFilter ? { competitionId: competitionFilter.id } : {}) },
      _count: { _all: true },
    }),
    prisma.participant.findMany({
      where: { tournamentId: tournament.id },
      select: {
        publicCode: true,
        displayName: true,
        studentId: true,
        teamName: true,
        memberships: { select: { entry: { select: { code: true } } } },
      },
      orderBy: { publicCode: "asc" },
    }),
  ]);
  const countFor = (value: RegistrationStatus) => counts.find((row) => row.status === value)?._count._all ?? 0;

  // 待审核报名的身份判定在服务端预先算好；界面只展示结果，最终仍由审核请求在事务内重新判定。
  const identities = new Map<string, MemberIdentityView[]>();
  if (status === "PENDING") {
    for (const registration of registrations) {
      const views: MemberIdentityView[] = [];
      for (const member of registration.members) {
        const preview = await previewIdentity(prisma, tournament.id, member);
        views.push({
          slot: member.slot,
          displayName: member.displayName,
          kind: preview.kind,
          reason: preview.kind === "NEW" ? null : preview.reason,
          candidates:
            preview.kind === "AMBIGUOUS" ? preview.candidates : preview.kind === "NEW" ? [] : [preview.participant],
        });
      }
      identities.set(registration.id, views);
    }
  }
  const batchItems = registrations
    .filter((registration) => !locked.has(registration.competition.id))
    .filter((registration) => (identities.get(registration.id) ?? []).every((view) => view.kind === "MATCH" || view.kind === "NEW"))
    .map((registration) => ({ id: registration.id, expectedVersion: registration.version }));
  const editable = REGISTRATION_EDITABLE_PHASES.includes(tournament.phase);
  const filterHref = (next: { status?: string; competition?: string | null }) => {
    const params = new URLSearchParams();
    params.set("status", next.status ?? status);
    const competition = next.competition === undefined ? competitionFilter?.code : next.competition;
    if (competition) params.set("competition", competition);
    return `/management/${tournament.slug}/registrations?${params.toString()}`;
  };

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow">{tournament.name}</p>
        <h1>报名审核</h1>
        <p>
          报名只有审核通过才会生成报名单位。姓名不是身份：没有学号的同名报名必须人工确认是同一人还是同名不同人。
          学号与联系方式只在后台可见。
        </p>
      </div>

      <section aria-labelledby="list-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="list-title">报名列表</h2>
          <p>按提交时间排序，每页最多 {PAGE_LIMIT} 份。</p>
        </div>
        <nav aria-label="按状态筛选" className={styles.filters}>
          {STATUSES.map((value) => (
            <Link aria-current={value === status ? "page" : undefined} href={filterHref({ status: value })} key={value}>
              {registrationStatusLabel[value]} {countFor(value)}
            </Link>
          ))}
        </nav>
        <nav aria-label="按项目筛选" className={styles.filters}>
          <Link aria-current={!competitionFilter ? "page" : undefined} href={filterHref({ competition: null })}>全部项目</Link>
          {competitions.map((competition) => (
            <Link
              aria-current={competitionFilter?.id === competition.id ? "page" : undefined}
              href={filterHref({ competition: competition.code })}
              key={competition.id}
            >
              {competition.code}
            </Link>
          ))}
        </nav>

        {status === "PENDING" && registrations.length ? <BatchApproveButton items={batchItems} slug={tournament.slug} /> : null}

        {registrations.length === 0 ? (
          <p className={styles.muted}>没有{registrationStatusLabel[status]}的报名。</p>
        ) : (
          <ul className={styles.list}>
            {registrations.map((registration) => (
              <li className={styles.regCard} data-testid="registration-row" key={registration.id}>
                <div>
                  <div className={styles.regMeta}>
                    <strong>{registration.referenceCode}</strong>
                    <StatusBadge tone={registrationStatusTone[registration.status]}>
                      {registrationStatusLabel[registration.status]}
                    </StatusBadge>
                    <span>{registration.competition.code} {registration.competition.name}（{entryTypeLabel[registration.competition.entryType]}）</span>
                    <span>
                      {registrationSourceLabel[registration.source]}
                      {registration.invite ? `「${registration.invite.label}」` : ""}
                      {registration.importRowNumber ? ` 第 ${registration.importRowNumber} 行` : ""}
                    </span>
                    <span>{formatZoned(registration.createdAt, tournament.timezone)}</span>
                  </div>
                  <ul className={styles.members}>
                    {registration.members.map((member) => (
                      <li key={member.slot}>
                        <b>{member.displayName}</b>
                        {member.participant ? <span>{member.participant.publicCode}</span> : null}
                        <span>学号 {member.studentId ?? "未填"}</span>
                        {member.teamName ? <span>{member.teamName}</span> : null}
                        {member.contact ? <span>联系 {member.contact}</span> : null}
                      </li>
                    ))}
                  </ul>
                  {registration.note ? <p className={styles.regNote}>备注：{registration.note}</p> : null}
                  {registration.entry ? <p className={styles.regNote}>报名单位：{registration.entry.code}</p> : null}
                  {registration.reviewReason ? (
                    <p className={styles.regNote}>
                      原因：{registration.reviewReason}
                      {registration.reviewedBy ? `（${registration.reviewedBy.name}）` : ""}
                    </p>
                  ) : null}
                  {status === "PENDING"
                    ? (identities.get(registration.id) ?? [])
                        .filter((view) => view.kind === "MATCH")
                        .map((view) => (
                          <p className={styles.identityOk} key={view.slot}>
                            第 {view.slot} 位：{view.reason}，将沿用同一人。
                          </p>
                        ))
                    : null}
                </div>
                {registration.status === "PENDING" || registration.status === "APPROVED" ? (
                  <RegistrationReviewActions
                    canChange={!locked.has(registration.competition.id)}
                    identities={identities.get(registration.id) ?? []}
                    registrationId={registration.id}
                    slug={tournament.slug}
                    status={registration.status}
                    version={registration.version}
                  />
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editable ? (
        <>
          <section aria-labelledby="manual-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="manual-title">后台手工录入</h2>
              <p>适合零散补录；批量名单请用下方导入。</p>
            </div>
            <ManualRegistrationForm competitions={competitions} slug={tournament.slug} />
          </section>
          <section aria-labelledby="import-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="import-title">CSV 批量导入</h2>
              <p>先预览、再确认；有错误行时整份不导入。</p>
            </div>
            <ImportPanel slug={tournament.slug} />
          </section>
        </>
      ) : (
        <p className="notice">赛事已开赛或结束，报名名单已锁定，不能再录入或导入。</p>
      )}

      <section aria-labelledby="people-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="people-title">人员名单（{participants.length}）</h2>
          <p>审核通过后才会建立人员记录。更正姓名不改变身份，会留审计。</p>
        </div>
        {participants.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th>编号</th><th>姓名</th><th>学号</th><th>代表队</th><th>报名单位</th><th><span className="visually-hidden">操作</span></th></tr>
              </thead>
              <tbody>
                {participants.map((participant) => (
                  <tr key={participant.publicCode}>
                    <td>{participant.publicCode}</td>
                    <td>{participant.displayName}</td>
                    <td>{participant.studentId ?? "—"}</td>
                    <td>{participant.teamName ?? "—"}</td>
                    <td>{participant.memberships.map((membership) => membership.entry.code).join("、") || "—"}</td>
                    <td><RenameParticipantForm currentName={participant.displayName} publicCode={participant.publicCode} slug={tournament.slug} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.muted}>还没有审核通过的人员。</p>
        )}
      </section>
    </>
  );
}

import Link from "next/link";

import { prisma } from "@/db/client";
import { formatZoned, utcToZonedLocal } from "@/domain/time/zoned-time";
import { entryTypeLabel, tournamentStatusLabel } from "@/features/management/labels";
import styles from "@/features/management/management.module.css";
import {
  AddCompetitionForm,
  InvitePanel,
  PhaseControls,
  PosterUploadForm,
  PublishButton,
  RegistrationSettingsForm,
  type InviteRow,
} from "@/features/management/tournament-admin-panels";
import { tournamentPhaseLabels } from "@/features/public-results/model";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

export default async function TournamentOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tournament: access, role } = await requireManagedTournamentPage(slug);
  const isAdmin = role === "ADMIN";
  const now = new Date();

  const tournament = await prisma.tournament.findUniqueOrThrow({
    where: { id: access.id },
    select: {
      slug: true,
      name: true,
      subtitle: true,
      venue: true,
      organizer: true,
      startDate: true,
      endDate: true,
      timezone: true,
      status: true,
      phase: true,
      namePolicy: true,
      regulations: true,
      posterAlt: true,
      registrationOpensAt: true,
      registrationClosesAt: true,
      defaultRuleRevision: { select: { sourceLabel: true, ruleProfile: { select: { name: true } } } },
      competitions: {
        select: {
          id: true,
          code: true,
          name: true,
          entryType: true,
          _count: { select: { entries: true } },
        },
        orderBy: { code: "asc" },
      },
      registrationInvites: {
        select: {
          id: true,
          label: true,
          tokenHint: true,
          expiresAt: true,
          revokedAt: true,
          submissionCount: true,
          maxSubmissions: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  const statusCounts = await prisma.registration.groupBy({
    by: ["competitionId", "status"],
    where: { tournamentId: access.id },
    _count: { _all: true },
  });
  const count = (competitionId: string | null, status: string) =>
    statusCounts
      .filter((row) => (competitionId === null || row.competitionId === competitionId) && row.status === status)
      .reduce((sum, row) => sum + row._count._all, 0);

  const invites: InviteRow[] = tournament.registrationInvites.map((invite) => ({
    id: invite.id,
    label: invite.label,
    tokenHint: invite.tokenHint,
    expiresAtLabel: formatZoned(invite.expiresAt, tournament.timezone),
    submissionCount: invite.submissionCount,
    maxSubmissions: invite.maxSubmissions,
    state: invite.revokedAt
      ? "REVOKED"
      : invite.expiresAt <= now
        ? "EXPIRED"
        : invite.submissionCount >= invite.maxSubmissions
          ? "EXHAUSTED"
          : "ACTIVE",
  }));
  const editable = tournament.phase === "PREPARING" || tournament.phase === "REGISTRATION_OPEN" || tournament.phase === "REGISTRATION_CLOSED";
  const defaultExpiry = tournament.registrationClosesAt && tournament.registrationClosesAt > now
    ? utcToZonedLocal(tournament.registrationClosesAt, tournament.timezone)
    : utcToZonedLocal(new Date(now.getTime() + 14 * 86_400_000), tournament.timezone);

  return (
    <>
      <div className={styles.headingRow}>
        <div className={styles.heading}>
          <p className="eyebrow">赛事后台</p>
          <h1>{tournament.name}</h1>
          <div className={styles.regMeta}>
            <StatusBadge tone={tournament.status === "PUBLISHED" ? "ok" : "warn"}>{tournamentStatusLabel[tournament.status]}</StatusBadge>
            <StatusBadge tone="info">{tournamentPhaseLabels[tournament.phase]}</StatusBadge>
            <span>你的角色：{isAdmin ? "管理员" : "编排员"}</span>
          </div>
        </div>
        <Link className="button" href={`/management/${tournament.slug}/registrations`}>
          报名审核（待审 {count(null, "PENDING")}）
        </Link>
      </div>

      <dl className={styles.facts}>
        <div><dt>日期</dt><dd>{tournament.startDate?.toISOString().slice(0, 10) ?? "未设置"} 至 {tournament.endDate?.toISOString().slice(0, 10) ?? "未设置"}</dd></div>
        <div><dt>场馆</dt><dd>{tournament.venue ?? "未设置"}</dd></div>
        <div><dt>时区</dt><dd>{tournament.timezone}</dd></div>
        <div><dt>默认规则</dt><dd>{tournament.defaultRuleRevision?.ruleProfile.name ?? "未设置"}</dd></div>
        <div><dt>公开姓名</dt><dd>{tournament.namePolicy === "CODES_ONLY" ? "只公开编号" : "公开姓名与代表队"}</dd></div>
        <div>
          <dt>报名窗口</dt>
          <dd>
            {tournament.registrationOpensAt ? formatZoned(tournament.registrationOpensAt, tournament.timezone) : "不限开始"}
            {" — "}
            {tournament.registrationClosesAt ? formatZoned(tournament.registrationClosesAt, tournament.timezone) : "不限截止"}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="stats-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="stats-title">报名概况</h2>
          <p>只有审核通过的报名才生成报名单位（Entry），进入后续编排。</p>
        </div>
        <div className={styles.stats}>
          <div><strong>{count(null, "PENDING")}</strong><span>待审核</span></div>
          <div><strong>{count(null, "APPROVED")}</strong><span>已通过</span></div>
          <div><strong>{count(null, "REJECTED")}</strong><span>已驳回</span></div>
          <div><strong>{count(null, "WITHDRAWN")}</strong><span>已撤回</span></div>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr><th>代码</th><th>项目</th><th>类型</th><th>待审核</th><th>报名单位</th></tr>
            </thead>
            <tbody>
              {tournament.competitions.map((competition) => (
                <tr key={competition.id}>
                  <td><strong>{competition.code}</strong></td>
                  <td>{competition.name}</td>
                  <td>{entryTypeLabel[competition.entryType]}</td>
                  <td>{count(competition.id, "PENDING")}</td>
                  <td>{competition._count.entries}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="phase-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="phase-title">赛事阶段：{tournamentPhaseLabels[tournament.phase]}</h2>
          <p>阶段由管理员手动推进并留审计，不会按时间自动变化。</p>
        </div>
        {isAdmin ? <PhaseControls phase={tournament.phase} slug={tournament.slug} /> : <p className={styles.muted}>只有管理员可以推进阶段。</p>}
        {isAdmin && tournament.status === "DRAFT" ? <PublishButton slug={tournament.slug} /> : null}
      </section>

      <section aria-labelledby="invite-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="invite-title">邀请报名链接</h2>
          <p>发给学院或社团的匿名报名入口。不开放公众注册。</p>
        </div>
        <InvitePanel canCreate={editable} defaultExpiry={defaultExpiry} invites={invites} slug={tournament.slug} timezone={tournament.timezone} />
      </section>

      {isAdmin && editable ? (
        <>
          <section aria-labelledby="settings-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="settings-title">报名设置</h2>
              <p>时间按赛事时区 {tournament.timezone} 填写。</p>
            </div>
            <RegistrationSettingsForm
              initial={{
                registrationOpensAt: tournament.registrationOpensAt ? utcToZonedLocal(tournament.registrationOpensAt, tournament.timezone) : "",
                registrationClosesAt: tournament.registrationClosesAt ? utcToZonedLocal(tournament.registrationClosesAt, tournament.timezone) : "",
                regulations: tournament.regulations ?? "",
              }}
              slug={tournament.slug}
              timezone={tournament.timezone}
            />
          </section>
          <section aria-labelledby="poster-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="poster-title">赛事海报</h2>
              <p>显示在公开首页赛事卡片上；未上传时使用占位卡。</p>
            </div>
            <PosterUploadForm currentAlt={tournament.posterAlt ?? ""} slug={tournament.slug} />
          </section>
          <section aria-labelledby="competition-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="competition-title">新增项目或组别</h2>
              <p>已有项目暂不支持删除；报名开放后仍可补充组别。</p>
            </div>
            <AddCompetitionForm slug={tournament.slug} />
          </section>
        </>
      ) : null}
    </>
  );
}

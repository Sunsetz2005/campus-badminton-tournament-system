import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/db/client";
import type { RubberKind } from "@/domain/registration/team-roster";
import styles from "@/features/management/management.module.css";
import { AmendLineupPanel } from "@/features/management/tie-panels";
import { LineupEditor } from "@/features/team/lineup-editor";
import { LineupProgress, RubberTable, sideName, TieHeader, TieSchedule } from "@/features/team/tie-views";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { loadFixtureScheduleFacts, loadScheduleConfig } from "@/server/services/schedule-facts";
import { loadRosterForLineup, loadTieByCode, projectTie } from "@/server/services/team-tie-service";

export const dynamic = "force-dynamic";

/**
 * 后台单场对抗：名单进度、管理员代交（交齐前只看状态、不看内容）、公开后的双方名单、裁判长改名单与小场结果。
 */
export default async function TieFixturePage({ params }: { params: Promise<{ slug: string; code: string; fixtureCode: string }> }) {
  const { slug, code, fixtureCode } = await params;
  const { tournament, user } = await requireManagedTournamentPage(slug);
  const competition = await prisma.competition.findUnique({
    where: { tournamentId_code: { tournamentId: tournament.id, code: code.toUpperCase() } },
    select: { id: true, code: true, name: true, entryType: true },
  });
  if (!competition || competition.entryType !== "TEAM") notFound();
  const fixture = await loadTieByCode(prisma, competition.id, fixtureCode);
  if (!fixture) notFound();
  const [config, scheduleFacts] = await Promise.all([
    loadScheduleConfig(prisma, tournament.id),
    loadFixtureScheduleFacts(prisma, tournament.id, fixture.id),
  ]);
  const view = projectTie(fixture, { kind: "OFFICIAL" }, config);
  const now = new Date();
  const deadlinePassed = scheduleFacts.deadline !== null && now >= scheduleFacts.deadline;
  const chief = await prisma.roleAssignment.findFirst({
    where: { userId: user.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
    select: { id: true },
  });
  const phaseOpen = tournament.phase === "REGISTRATION_CLOSED" || tournament.phase === "RUNNING";
  const rubbers = view.rubbers.map((rubber) => ({ order: rubber.order, kind: rubber.kind as RubberKind }));
  const rosters = {
    A: fixture.sideAEntryId ? await loadRosterForLineup(fixture.sideAEntryId) : [],
    B: fixture.sideBEntryId ? await loadRosterForLineup(fixture.sideBEntryId) : [],
  };
  const amendable = view.rubbers.filter((rubber) => !rubber.started && !rubber.notPlayed && !rubber.final);

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow">
          <Link href={`/management/${tournament.slug}/ties/${competition.code}`}>{competition.code} {competition.name}</Link> · {view.code}
        </p>
        <h1>{view.label}</h1>
      </div>
      <TieHeader view={view} />
      <TieSchedule now={now} timeZone={tournament.timezone} view={view} />
      <LineupProgress view={view} />

      {!view.revealedAt && phaseOpen ? (
        <section aria-labelledby="proxy-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="proxy-title">代交出场名单</h2>
            <p>
              负责人无法提交时由管理员代交。交齐前后台也只显示提交状态、不显示内容；代交会整份覆盖该方已提交的名单。
              {deadlinePassed ? "已过出场名单截止时间：负责人不能再提交，此时代交会标记为「逾期代交」。" : ""}
            </p>
          </div>
          {view.sides.map((side) =>
            side.entry ? (
              <details key={side.side}>
                <summary>代 {side.entry.name} 提交{side.lineup ? `（已有第 ${side.lineup.version} 版，将覆盖）` : ""}</summary>
                <LineupEditor
                  endpoint={`/api/admin/tournaments/${tournament.slug}/fixtures/${fixture.id}/lineup`}
                  expectedVersion={side.lineup?.version ?? null}
                  initial={{}}
                  roster={rosters[side.side]}
                  rubbers={rubbers}
                  side={side.side}
                  submitLabel={`代 ${side.entry.name} 提交${deadlinePassed ? "（逾期）" : ""}`}
                  limits={view.limits}
                  overlappingOrders={scheduleFacts.overlappingOrders}
                />
              </details>
            ) : (
              <p className={styles.muted} key={side.side}>{sideName(view, side.side)}：待前序结果产生。</p>
            ),
          )}
        </section>
      ) : null}

      <section aria-labelledby="rubbers-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="rubbers-title">小场</h2>
          <p>{chief ? "裁判长可从小场编号进入执裁台复核。" : "结果以裁判长复核锁定为准。"}</p>
        </div>
        <RubberTable officiatingLinks={Boolean(chief)} timeZone={tournament.timezone} view={view} />
      </section>

      {view.revealedAt && chief && phaseOpen ? (
        <section aria-labelledby="amend-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="amend-title">裁判长调整上场队员</h2>
            <p>只能调整尚未开始的小场，必须写明原因（如伤病），前后名单都记入审计。</p>
          </div>
          <AmendLineupPanel
            fixtureId={fixture.id}
            rosters={rosters}
            rubbers={amendable.map((rubber) => ({ order: rubber.order, kind: rubber.kind as RubberKind }))}
            sideNames={{ A: sideName(view, "A"), B: sideName(view, "B") }}
            slug={tournament.slug}
          />
        </section>
      ) : null}
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/db/client";
import type { DrawAdjustment, DrawEntryInput, DrawResult, DrawSettings } from "@/domain/draw/draw-engine";
import { DRAW_FORMAT_LABEL, suggestFormat } from "@/domain/draw/format";
import type { RubberKind } from "@/domain/registration/team-roster";
import { formatZoned } from "@/domain/time/zoned-time";
import { entryTypeLabel } from "@/features/management/labels";
import styles from "@/features/management/management.module.css";
import {
  AdjustDrawPanel,
  DrawSettingsForm,
  PublishDrawPanel,
  RevokeDrawPanel,
  type DrawSettingsValue,
} from "@/features/management/draw-panels";
import { DrawProvenance, DrawResultView } from "@/features/management/draw-result-view";
import { tournamentPhaseLabels } from "@/features/public-results/model";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { loadDrawEntries } from "@/server/services/draw-service";
import { REGISTRATION_EDITABLE_PHASES } from "@/server/services/registration-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

const DRAW_STATUS_LABEL = { DRAFT: "草稿", PUBLISHED: "已发布", SUPERSEDED: "已被替代", REVOKED: "已撤销" } as const;

export default async function DrawWorkspacePage({ params }: { params: Promise<{ slug: string; code: string }> }) {
  const { slug, code } = await params;
  const { tournament, user } = await requireManagedTournamentPage(slug);
  const competition = await prisma.competition.findUnique({
    where: { tournamentId_code: { tournamentId: tournament.id, code: code.toUpperCase() } },
    select: { id: true, code: true, name: true, entryType: true, teamRubbers: true },
  });
  if (!competition) notFound();

  const [{ entries, inputHash }, draws, pending, foreignMatches, chief] = await Promise.all([
    loadDrawEntries(prisma, competition.id),
    prisma.draw.findMany({
      where: { competitionId: competition.id },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        status: true,
        format: true,
        algorithmVersion: true,
        randomSeed: true,
        inputHash: true,
        input: true,
        settings: true,
        adjustments: true,
        result: true,
        conflictCount: true,
        createdAt: true,
        publishedAt: true,
        revokedAt: true,
        revokeReason: true,
        createdBy: { select: { name: true } },
      },
    }),
    prisma.registration.count({ where: { competitionId: competition.id, status: "PENDING" } }),
    prisma.match.count({ where: { stage: { competitionId: competition.id }, fixtureId: null } }),
    prisma.roleAssignment.findFirst({ where: { userId: user.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" }, select: { id: true } }),
  ]);
  const draft = draws.find((draw) => draw.status === "DRAFT") ?? null;
  const published = draws.find((draw) => draw.status === "PUBLISHED") ?? null;
  const shown = published ?? draft;
  const rubbers = competition.teamRubbers as RubberKind[];
  const suggestion = suggestFormat(entries.length);
  const entryOptions = entries.map((entry) => ({ id: entry.entryId, code: entry.code, label: entry.label }));
  const editable = REGISTRATION_EDITABLE_PHASES.includes(tournament.phase);

  const initialSettings: DrawSettingsValue = draft
    ? (draft.settings as unknown as DrawSettingsValue)
    : {
        format: suggestion?.format ?? "ROUND_ROBIN",
        groupCount: null,
        qualifiersPerGroup: 2,
        thirdPlaceMatch: true,
        avoidSameUnit: true,
        seeds: [],
      };

  const blockers: string[] = [];
  if (tournament.phase !== "REGISTRATION_CLOSED") blockers.push(`赛事阶段须为「报名截止」（当前：${tournamentPhaseLabels[tournament.phase]}），请在赛事概览推进阶段。`);
  if (pending > 0) blockers.push(`本项目还有 ${pending} 份待审核报名。`);
  if (draft && draft.inputHash !== inputHash) blockers.push("草稿生成后报名名单或代表队信息有变化，请重新抽签。");
  if (foreignMatches > 0) blockers.push("该项目已有非抽签生成的比赛（演示数据），不能再抽签。");

  const publishedCounts = published
    ? await prisma.fixture.findMany({ where: { drawId: published.id }, select: { _count: { select: { matches: true } } } })
    : [];

  return (
    <>
      <div className={styles.headingRow}>
        <div className={styles.heading}>
          <p className="eyebrow"><Link href={`/management/${tournament.slug}/draw`}>抽签编排</Link></p>
          <h1>{competition.code} {competition.name}</h1>
          <div className={styles.regMeta}>
            <StatusBadge tone="info">{entryTypeLabel[competition.entryType]}</StatusBadge>
            {published ? <StatusBadge tone="ok">已发布 · 第 {published.version} 版</StatusBadge> : draft ? <StatusBadge tone="warn">草稿 · 第 {draft.version} 版</StatusBadge> : <StatusBadge>未抽签</StatusBadge>}
            <span>报名单位 {entries.length} 个 · 待审核 {pending} 份</span>
            <span>建议：{suggestion ? suggestion.reason : "报名单位不足 2 个，不编排"}</span>
          </div>
        </div>
      </div>

      {published ? (
        <section aria-labelledby="published-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="published-title">已发布的抽签</h2>
            <p>
              {published.publishedAt ? formatZoned(published.publishedAt, tournament.timezone) : ""} 发布 · 已生成 {publishedCounts.length} 场对阵、
              {publishedCounts.reduce((sum, fixture) => sum + fixture._count.matches, 0)} 场比赛，报名单位已冻结。比赛尚未对外公开，排场地与时间属于下一阶段。
            </p>
          </div>
          <DrawResultView
            entries={published.input as unknown as DrawEntryInput[]}
            result={published.result as unknown as DrawResult}
            rubbers={rubbers}
            settings={published.settings as unknown as DrawSettings}
          />
          <DrawProvenance
            adjustments={published.adjustments as unknown as DrawAdjustment[]}
            algorithmVersion={published.algorithmVersion}
            inputHash={published.inputHash}
            randomSeed={published.randomSeed}
            settings={published.settings as unknown as DrawSettings}
            version={published.version}
          />
          {chief ? (
            <RevokeDrawPanel competitionCode={competition.code} slug={tournament.slug} />
          ) : (
            <p className={styles.muted}>如发现漏报、错报或明确的算法错误，须由本赛事裁判长在任何比赛开始前撤销后重抽。</p>
          )}
        </section>
      ) : (
        <>
          {editable ? (
            <section aria-labelledby="settings-title" className={styles.section}>
              <div className={styles.sectionTitle}>
                <h2 id="settings-title">抽签设置</h2>
                <p>分组规模、种子上限与回避均为项目默认，正式赛事须由组织者采纳。</p>
              </div>
              <DrawSettingsForm
                competitionCode={competition.code}
                entries={entryOptions}
                hasDraft={Boolean(draft)}
                initial={initialSettings}
                slug={tournament.slug}
                suggestedGroupCount={suggestion?.groupCount ?? null}
              />
            </section>
          ) : (
            <p className={styles.info}>赛事已开赛或结束，不能再抽签。</p>
          )}
          {draft && shown ? (
            <section aria-labelledby="draft-title" className={styles.section}>
              <div className={styles.sectionTitle}>
                <h2 id="draft-title">草稿预览 · 第 {draft.version} 版</h2>
                <p>{DRAW_FORMAT_LABEL[draft.format]} · {draft.createdBy?.name ?? "未知"} 于 {formatZoned(draft.createdAt, tournament.timezone)} 生成</p>
              </div>
              <DrawResultView
                entries={draft.input as unknown as DrawEntryInput[]}
                result={draft.result as unknown as DrawResult}
                rubbers={rubbers}
                settings={draft.settings as unknown as DrawSettings}
              />
              <DrawProvenance
                adjustments={draft.adjustments as unknown as DrawAdjustment[]}
                algorithmVersion={draft.algorithmVersion}
                inputHash={draft.inputHash}
                randomSeed={draft.randomSeed}
                settings={draft.settings as unknown as DrawSettings}
                version={draft.version}
              />
              <details>
                <summary>手动调签</summary>
                <AdjustDrawPanel
                  competitionCode={competition.code}
                  drawId={draft.id}
                  entries={entryOptions}
                  format={draft.format}
                  groups={(draft.result as unknown as DrawResult).layout.groups.map((group) => ({ code: group.code }))}
                  slug={tournament.slug}
                />
              </details>
              <div className={styles.sectionTitle}>
                <h2>正式发布</h2>
              </div>
              <PublishDrawPanel
                blockers={blockers}
                competitionCode={competition.code}
                drawId={draft.id}
                slug={tournament.slug}
                summary={
                  rubbers.length
                    ? `发布将生成 ${(draft.result as unknown as DrawResult).fixtures.length} 场学院对抗，每场 ${rubbers.length} 个小场，共 ${(draft.result as unknown as DrawResult).fixtures.length * rubbers.length} 场比赛占位。`
                    : `发布将生成 ${(draft.result as unknown as DrawResult).fixtures.length} 场比赛；淘汰轮次的参赛者待前序结果产生。`
                }
              />
            </section>
          ) : null}
        </>
      )}

      {draws.length ? (
        <section aria-labelledby="history-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="history-title">版本记录</h2>
            <p>每次抽签和调签都保留一个版本，便于复核。</p>
          </div>
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.tableWide}`}>
              <thead><tr><th>版本</th><th>状态</th><th>赛制</th><th>调签</th><th>冲突</th><th>操作人</th><th>时间</th></tr></thead>
              <tbody>
                {draws.map((draw) => (
                  <tr key={draw.id}>
                    <td>第 {draw.version} 版</td>
                    <td>{DRAW_STATUS_LABEL[draw.status]}{draw.revokeReason ? `（${draw.revokeReason}）` : ""}</td>
                    <td>{DRAW_FORMAT_LABEL[draw.format]}</td>
                    <td>{(draw.adjustments as unknown[]).length}</td>
                    <td>{draw.conflictCount}</td>
                    <td>{draw.createdBy?.name ?? "—"}</td>
                    <td>{formatZoned(draw.createdAt, tournament.timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

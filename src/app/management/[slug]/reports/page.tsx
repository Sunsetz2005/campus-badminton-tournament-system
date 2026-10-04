import styles from "@/features/management/management.module.css";
import { ReportGenerateButton } from "@/features/reports/report-generate-button";
import { formatZoned } from "@/domain/time/zoned-time";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import {
  currentDataRevisions,
  listReportExports,
  REPORT_KIND_LABEL,
  REPORT_VIEW_ROLES,
  tournamentRoles,
  type ReportExportSummary,
} from "@/server/services/report-export-service";
import { StatusBadge } from "@/ui/status-badge";

export const dynamic = "force-dynamic";

function sizeText(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

function statusOf(item: ReportExportSummary, current: Record<"DRAFT" | "OFFICIAL", { revision: string | null }>) {
  if (item.supersededAt) return <StatusBadge tone="neutral">已被第 {item.supersededByVersion} 版替代</StatusBadge>;
  if (item.kind === "REGISTRATIONS_INTERNAL") return <StatusBadge tone="warn">内部资料</StatusBadge>;
  const now = item.edition ? current[item.edition].revision : null;
  const stale = now !== null && now !== item.dataRevision;
  if (item.edition === "OFFICIAL") {
    return stale ? <StatusBadge detail="数据已变化，可重新生成" tone="warn">当前正式版</StatusBadge> : <StatusBadge tone="ok">当前正式版</StatusBadge>;
  }
  return stale ? <StatusBadge detail="数据已变化" tone="neutral">草稿</StatusBadge> : <StatusBadge tone="info">草稿</StatusBadge>;
}

/** 成绩册与导出：生成版本化的 Excel 文件，历史文件原样保留、可随时下载备查。 */
export default async function ReportsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tournament, user } = await requireManagedTournamentPage(slug, REPORT_VIEW_ROLES);
  const roles = await tournamentRoles(user.id, tournament.id);
  const canInternal = roles.has("ADMIN") || roles.has("ORGANIZER");
  const canOfficial = roles.has("ADMIN") || roles.has("CHIEF_REFEREE");
  const [exports, current] = await Promise.all([listReportExports(tournament.id, roles), currentDataRevisions(tournament.id)]);

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow">阶段 7 · 成绩册与公开查询</p>
        <h1>成绩册与导出</h1>
        <p>
          每份文件都从同一时刻的数据快照生成，并连同数据修订号原样存档；之后结果被更正，只会生成新版本，旧文件不会被改写。
          对外版本只含已公开的比赛，姓名按赛事的姓名公开策略处理。
        </p>
      </div>

      <section aria-labelledby="reports-generate-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="reports-generate-title">赛事数据表（Excel）</h2>
          <p>工作表：说明、参赛名单、分组、对阵、赛程、逐场成绩、名次、特殊结果。</p>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>当前数据修订（草稿口径）</dt>
            <dd>{current.DRAFT.revision ?? current.DRAFT.error ?? "—"}</dd>
          </div>
          <div>
            <dt>当前数据修订（正式口径）</dt>
            <dd>{current.OFFICIAL.revision ?? "不能生成正式版"}</dd>
          </div>
        </dl>
        {current.OFFICIAL.error ? (
          <p className={styles.info} role="note">
            {current.OFFICIAL.error}
          </p>
        ) : null}
        <p className={styles.muted}>
          草稿可带暂定比分并在每一页醒目标注；正式版只引用经裁判长复核锁定的结果与已发布的名次榜单
          {canOfficial ? "。" : "，只有管理员与裁判长可以生成。"}
        </p>
        <div className={styles.actions}>
          <ReportGenerateButton edition="DRAFT" kind="DATA_WORKBOOK" label="生成草稿" slug={tournament.slug} variant="secondary" />
          {canOfficial ? <ReportGenerateButton edition="OFFICIAL" kind="DATA_WORKBOOK" label="生成正式版" slug={tournament.slug} /> : null}
        </div>
      </section>

      <section aria-labelledby="reports-booklet-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="reports-booklet-title">成绩册（A4 打印网页与 PDF）</h2>
          <p>封面与赛事信息、规程摘要、公开参赛名单、分组、对阵、赛程、逐场结果、名次与特殊结果说明。</p>
        </div>
        <p className={styles.muted}>
          打印网页按当前数据即时生成、不存档；PDF 由服务器渲染同一个模板并存档，封面与每页页脚都标明版本与数据修订号。
          成绩册不含任何印章、签字或审批标记。
        </p>
        <div className={styles.actions}>
          <a className="button secondary" href={`/management/${tournament.slug}/reports/booklet?edition=DRAFT`} rel="noopener" target="_blank">
            打开打印网页（草稿）
          </a>
          <a className="button secondary" href={`/management/${tournament.slug}/reports/booklet?edition=OFFICIAL`} rel="noopener" target="_blank">
            打开打印网页（正式口径）
          </a>
        </div>
        <div className={styles.actions}>
          <ReportGenerateButton edition="DRAFT" kind="BOOKLET_PDF" label="生成 PDF 草稿" slug={tournament.slug} variant="secondary" />
          {canOfficial ? <ReportGenerateButton edition="OFFICIAL" kind="BOOKLET_PDF" label="生成 PDF 正式版" slug={tournament.slug} /> : null}
        </div>
      </section>

      {canInternal ? (
        <section aria-labelledby="reports-internal-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="reports-internal-title">内部报名名单（Excel）</h2>
            <p>含学号、性别、联系方式与审核记录，仅限赛事管理员与编排员，不得公开或外传。</p>
          </div>
          <ReportGenerateButton edition={null} kind="REGISTRATIONS_INTERNAL" label="生成内部报名名单" slug={tournament.slug} variant="secondary" />
        </section>
      ) : null}

      <section aria-labelledby="reports-history-title" className={styles.section}>
        <div className={styles.sectionTitle}>
          <h2 id="reports-history-title">已生成的文件</h2>
          <p>共 {exports.length} 份。被替代的旧版仍可下载备查，内容与生成时逐字节一致（附 SHA-256）。</p>
        </div>
        {exports.length ? (
          <div className={styles.tableWrap}>
            <table className={`${styles.table} ${styles.tableWide}`}>
              <thead>
                <tr>
                  <th scope="col">文件</th>
                  <th scope="col">版本</th>
                  <th scope="col">数据修订</th>
                  <th scope="col">取数时间</th>
                  <th scope="col">状态</th>
                  <th scope="col">下载</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{REPORT_KIND_LABEL[item.kind]}</strong>
                      <br />
                      <span className={styles.muted}>
                        {item.edition === "OFFICIAL" ? "正式版" : item.edition === "DRAFT" ? "草稿" : "内部"} · {sizeText(item.byteSize)}
                        {item.createdBy ? ` · ${item.createdBy}` : ""}
                      </span>
                    </td>
                    <td>第 {item.version} 版</td>
                    <td>
                      <code>{item.dataRevision}</code>
                    </td>
                    <td>{formatZoned(new Date(item.capturedAt), tournament.timezone)}</td>
                    <td>{statusOf(item, current)}</td>
                    <td>
                      <a download href={`/api/admin/tournaments/${tournament.slug}/reports/${item.id}`}>
                        {item.fileName}
                      </a>
                      <br />
                      <small className={styles.muted} title={item.sha256}>
                        SHA-256 {item.sha256.slice(0, 12)}…
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">还没有生成过文件。</p>
        )}
      </section>
    </>
  );
}

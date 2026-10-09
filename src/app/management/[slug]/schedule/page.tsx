import Link from "next/link";

import { prisma } from "@/db/client";
import styles from "@/features/management/management.module.css";
import { AutoScheduleBanner, IssueList, PublishPanel, RelayoutTieForm, SuggestPanel } from "@/features/schedule/schedule-draft";
import { ScheduleFilters, ScheduleRows } from "@/features/schedule/schedule-rows";
import { CourtsPanel, DaysEditor, ScheduleConfigForm } from "@/features/schedule/schedule-settings";
import local from "@/features/schedule/schedule.module.css";
import { requireManagedTournamentPage } from "@/server/auth/page-authorization";
import { loadScheduleWorkspace } from "@/server/services/schedule-service";

export const dynamic = "force-dynamic";

type View = "draft" | "published" | "settings" | "history";
const VIEWS: [View, string][] = [
  ["draft", "草稿编排"],
  ["published", "已发布与现场"],
  ["settings", "场地与时段"],
  ["history", "发布记录"],
];

/**
 * 赛程与裁判排班（阶段 4-C）：设置 → 自动建议/手工调整草稿 → 立即复检 → 发布。
 * 发布后比赛进入「我的执裁」和公开赛程；现场按实际开始/结束推算延误。
 */
export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const pick = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : undefined);
  const view: View = (VIEWS.map(([key]) => key) as string[]).includes(pick("view") ?? "") ? (pick("view") as View) : "draft";
  const { tournament, user } = await requireManagedTournamentPage(slug);
  const chief = await prisma.roleAssignment.findFirst({
    where: { userId: user.id, tournamentId: tournament.id, role: "CHIEF_REFEREE" },
    select: { id: true },
  });
  const workspace = await loadScheduleWorkspace(tournament.id, new Date(), {
    day: pick("day"),
    court: pick("court"),
    competition: pick("competition"),
    problemsOnly: pick("problems") === "1",
  });
  const basePath = `/management/${tournament.slug}/schedule`;
  const filterParams = { view, day: pick("day"), court: pick("court"), competition: pick("competition"), problems: pick("problems") };
  const courtOptions = workspace.courts.map((court) => ({ id: court.id, code: court.code, name: court.name, active: court.active }));
  const refereeOptions = workspace.referees.map((referee) => ({ id: referee.id, name: referee.name }));
  const { draftCheck } = workspace;
  const finished = tournament.phase === "FINISHED";
  // 抽签发布后带着自动排程结果跳转过来（见抽签页）；只用于显示一次说明，不参与任何判断。
  const auto = pick("auto");
  const shortfallDate = pick("sd");
  const banner = auto ? (
    <AutoScheduleBanner
      competitionCode={pick("comp") ?? null}
      days={workspace.days}
      message={pick("msg") ?? null}
      placed={Number(pick("placed") ?? 0)}
      scope={Number(pick("scope") ?? 0)}
      shortfall={shortfallDate ? { date: shortfallDate, currentEnd: pick("se") ?? "", requiredEnd: pick("sr") || null } : null}
      slug={tournament.slug}
      status={auto}
    />
  ) : null;

  return (
    <>
      <div className={styles.heading}>
        <p className="eyebrow">阶段 4-C</p>
        <h1>赛程与裁判排班</h1>
        <p>
          先设置场地、比赛日与预计时长，再生成排程建议或逐场调整草稿；每次改动后立即复检。没有硬冲突、逐项确认警告后发布：
          比赛进入裁判的「我的执裁」与公开赛程。预计时长只用于排程与推算延误，不是保证时长；休息间隔由现场裁判掌握，系统不检查。
          时间按赛事时区 {workspace.timeZone} 显示。
        </p>
      </div>

      <nav aria-label="赛程视图" className={local.tabs}>
        {VIEWS.map(([key, label]) => (
          <Link aria-current={view === key ? "page" : undefined} href={`${basePath}?view=${key}`} key={key}>
            {label}
          </Link>
        ))}
      </nav>

      <div className={local.summary} data-testid="schedule-summary">
        <div><strong>{workspace.totalMatches}</strong><span>比赛总数</span></div>
        <div><strong>{draftCheck.scheduledCount}</strong><span>草稿已排</span></div>
        <div><strong>{draftCheck.unscheduledCount}</strong><span>草稿未排</span></div>
        <div className={draftCheck.hardCount ? local.bad : undefined}><strong>{draftCheck.hardCount}</strong><span>硬冲突</span></div>
        <div className={draftCheck.warningCount ? local.warn : undefined}><strong>{draftCheck.warningCount}</strong><span>警告</span></div>
        <div><strong>{workspace.draftChangeCount}</strong><span>草稿改动</span></div>
        <div className={workspace.delayedCount ? local.bad : undefined}><strong>{workspace.delayedCount}</strong><span>现场延误</span></div>
      </div>

      {workspace.publishedCheck.hardCount > 0 ? (
        <section className={styles.alert} data-testid="published-conflicts" role="alert">
          已发布的赛程现在有 {workspace.publishedCheck.hardCount} 个硬冲突（例如场地被关闭、晋级确定后出现同队重叠），请在草稿中调整后重新发布：
          <IssueList issues={workspace.publishedCheck.issues} />
        </section>
      ) : null}

      {banner}

      {view === "settings" ? (
        <>
          <section aria-labelledby="config-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="config-title">预计时长与名单截止</h2>
              <p>须由组织者按规程确认；当前为项目默认。</p>
            </div>
            <ScheduleConfigForm initial={workspace.config} slug={tournament.slug} />
          </section>
          <section aria-labelledby="courts-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="courts-title">场地</h2>
              <p>关闭场地不会移动已排比赛，而是让它们在检查中显示为硬冲突。</p>
            </div>
            <CourtsPanel courts={workspace.courts.map((court) => ({ code: court.code, name: court.name, active: court.active }))} slug={tournament.slug} />
          </section>
          <section aria-labelledby="days-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="days-title">比赛日与开放时段</h2>
              <p>自动建议只在这些时段内排比赛；手工排在时段外会给出警告。</p>
            </div>
            <DaysEditor initial={workspace.days} slug={tournament.slug} />
          </section>
          <section aria-labelledby="referees-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="referees-title">可指派的裁判员</h2>
              <p>本赛事持有「裁判员」角色的账号。</p>
            </div>
            {workspace.referees.length ? (
              <ul className={styles.chips}>{workspace.referees.map((referee) => <li key={referee.id}>{referee.name}</li>)}</ul>
            ) : (
              <p className={styles.info}>本赛事还没有裁判员账号，排程时不会指派主裁判。</p>
            )}
          </section>
        </>
      ) : null}

      {view === "draft" ? (
        <>
          {!finished ? (
            <section aria-labelledby="suggest-title" className={styles.section}>
              <div className={styles.sectionTitle}>
                <h2 id="suggest-title">自动排程建议</h2>
                <p>{workspace.courts.filter((court) => court.active).length} 块可用场地 · {workspace.days.length} 个比赛日 · {workspace.referees.length} 名裁判员</p>
              </div>
              {!workspace.courts.length || !workspace.days.length ? (
                <p className={styles.info}>
                  请先在 <Link href={`${basePath}?view=settings`}>场地与时段</Link> 中设置场地和比赛日，否则自动建议会全部排不下。
                </p>
              ) : null}
              <SuggestPanel competitions={workspace.competitions} days={workspace.days} slug={tournament.slug} />
            </section>
          ) : null}

          <section aria-labelledby="check-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="check-title">草稿检查与发布</h2>
              <p>硬冲突阻止发布；警告需确认。尚未确定的晋级者按候选集合保守检查并标为「暂定」。</p>
            </div>
            {draftCheck.issues.length ? (
              <div data-testid="draft-issues">
                <IssueList issues={draftCheck.issues} />
                {draftCheck.truncated ? <p className={styles.hint}>问题较多，只显示前 200 条。</p> : null}
              </div>
            ) : (
              <p className={styles.success}>草稿没有发现冲突。</p>
            )}
            {!finished ? (
              <PublishPanel
                digest={workspace.warningDigest}
                draftChangeCount={workspace.draftChangeCount}
                hardCount={draftCheck.hardCount}
                slug={tournament.slug}
                warningCount={draftCheck.warningCount}
              />
            ) : null}
          </section>

          {workspace.teamFixtures.length && !finished ? (
            <section aria-labelledby="relayout-title" className={styles.section}>
              <div className={styles.sectionTitle}>
                <h2 id="relayout-title">整场对抗重排</h2>
                <p>把一场团体对抗整体挪到新的时间和场地，比逐个小场调整更快。</p>
              </div>
              <RelayoutTieForm courts={courtOptions} fixtures={workspace.teamFixtures} slug={tournament.slug} />
            </section>
          ) : null}

          <section aria-labelledby="draft-title" className={styles.section}>
            <div className={styles.sectionTitle}>
              <h2 id="draft-title">草稿赛程</h2>
              <p>左侧蓝条表示草稿与已发布版本不同。已开始的比赛不能调整。</p>
            </div>
            <ScheduleFilters
              basePath={basePath}
              competitions={workspace.competitions}
              courts={workspace.courts}
              days={workspace.draftDays}
              params={filterParams}
            />
            <ScheduleRows
              canEdit={!finished}
              courts={courtOptions}
              mode="draft"
              referees={refereeOptions}
              rows={workspace.draftRows}
              slug={tournament.slug}
              timeZone={workspace.timeZone}
            />
          </section>
        </>
      ) : null}

      {view === "published" ? (
        <section aria-labelledby="published-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="published-title">已发布赛程与现场状态</h2>
            <p>延误按实际开始/结束与服务器时间推算，只是提示，不会自动改动计划时间。{chief ? "裁判长可临时更换裁判。" : ""}</p>
          </div>
          <ScheduleFilters
            basePath={basePath}
            competitions={workspace.competitions}
            courts={workspace.courts}
            days={workspace.publishedDays}
            params={filterParams}
          />
          <ScheduleRows
            canReplaceReferee={Boolean(chief)}
            courts={courtOptions}
            mode="published"
            referees={refereeOptions}
            rows={workspace.publishedRows}
            slug={tournament.slug}
            timeZone={workspace.timeZone}
          />
        </section>
      ) : null}

      {view === "history" ? (
        <section aria-labelledby="history-title" className={styles.section}>
          <div className={styles.sectionTitle}>
            <h2 id="history-title">发布记录</h2>
            <p>每次发布保存完整安排、与上一版的差异和发布时确认过的警告。</p>
          </div>
          {workspace.publications.length ? (
            <ul className={styles.list} data-testid="publication-list">
              {workspace.publications.map((item) => {
                const changes = item.changes as { added?: string[]; moved?: unknown[]; removed?: string[]; referee?: unknown[]; madePublic?: number };
                return (
                  <li key={item.version}>
                    <strong>第 {item.version} 版</strong> · {new Date(item.publishedAt).toLocaleString("zh-CN", { timeZone: workspace.timeZone, hour12: false })}
                    {item.publishedBy ? ` · ${item.publishedBy}` : ""}
                    <p className={styles.hint}>
                      共 {item.matchCount} 场已排 · 新增 {changes.added?.length ?? 0} · 调整 {changes.moved?.length ?? 0} · 撤下 {changes.removed?.length ?? 0} ·
                      换裁判 {changes.referee?.length ?? 0} · 新公开 {changes.madePublic ?? 0} · 确认警告 {item.warnings.length}
                      {item.note ? ` · 说明：${item.note}` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="empty-state">还没有发布过赛程。</p>
          )}
        </section>
      ) : null}
    </>
  );
}

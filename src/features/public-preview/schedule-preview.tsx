"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { PUBLIC_PREVIEW_MATCHES, PUBLIC_PREVIEW_QUERY_OPTIONS, PUBLIC_PREVIEW_TOURNAMENT } from "./fixtures";
import { formatPreviewSyncTime } from "./format";
import {
  lifecycleLabels,
  outcomeLabels,
  previewScenarioLabels,
  verificationLabels,
  type PreviewScenario,
} from "./model";
import { PublicResultsShell, ScheduleMatch } from "./public-components";
import styles from "./public-preview.module.css";
import { PublicEmptyState, PublicErrorState, PublicInvalidDateState, PublicScheduleSkeleton } from "./resource-states";
import { filterPreviewMatches, parseScheduleQuery, preserveScheduleParams, withScheduleQuery } from "./query";

const competitionOptions = [...new Map(PUBLIC_PREVIEW_MATCHES.map((match) => [match.competitionCode, match.competitionName])).entries()];
const stageOptions = [...new Map(PUBLIC_PREVIEW_MATCHES.map((match) => [match.stageCode, match.stageName])).entries()];
const courtOptions = [...new Set(PUBLIC_PREVIEW_MATCHES.map((match) => match.court).filter((court): court is string => Boolean(court)))];
const defaultDate = "2026-10-14";
const queryOptions = PUBLIC_PREVIEW_QUERY_OPTIONS;

function first<T>(items: readonly T[]) {
  return items[0] ?? "";
}

export function PublicSchedulePreview() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const parsed = useMemo(
    () => parseScheduleQuery(new URLSearchParams(searchParams.toString()), queryOptions, defaultDate),
    [searchParams],
  );
  const query = parsed.value;
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [isPending, startTransition] = useTransition();
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const currentParams = useMemo(
    () => preserveScheduleParams(new URLSearchParams(searchParams.toString()), queryOptions),
    [searchParams],
  );
  const optimisticParamsRef = useRef(currentParams);
  const expectedParamsRef = useRef(currentParams.toString());

  useEffect(() => {
    const actual = currentParams.toString();
    if (!isPending || actual === expectedParamsRef.current) {
      optimisticParamsRef.current = currentParams;
      expectedParamsRef.current = actual;
    }
  }, [currentParams, isPending]);

  useEffect(() => {
    if (!filtersExpanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFiltersExpanded(false);
      queueMicrotask(() => moreButtonRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filtersExpanded]);

  function replaceQuery(updates: Record<string, string | null>) {
    const href = withScheduleQuery(pathname, optimisticParamsRef.current, updates, queryOptions);
    const queryString = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    const next = preserveScheduleParams(new URLSearchParams(queryString), queryOptions);
    optimisticParamsRef.current = next;
    expectedParamsRef.current = next.toString();
    startTransition(() => router.replace(href, { scroll: false }));
  }

  function clearHref() {
    const next = new URLSearchParams();
    next.set("date", query.date);
    if (query.scenario !== "ready") next.set("scenario", query.scenario);
    return `${pathname}?${next}`;
  }

  const invalidDate = parsed.issues.some((issue) => issue.key === "date" && issue.reason === "INVALID_DATE");
  const forcedEmpty = query.scenario === "empty";
  const dayMatches = invalidDate || forcedEmpty
    ? []
    : PUBLIC_PREVIEW_MATCHES.filter((match) => match.scheduleDate === query.date);
  const matching = invalidDate || forcedEmpty ? [] : filterPreviewMatches(PUBLIC_PREVIEW_MATCHES, query);
  const hasFilters = Boolean(
    query.competition || query.court || query.stage || query.lifecycle.length ||
    query.verification.length || query.outcome.length || query.q,
  );
  const filteredEmpty = dayMatches.length > 0 && matching.length === 0;
  const showResolvedData = !invalidDate && query.scenario !== "loading" && query.scenario !== "error";

  const activeStateFilters = [
    ...query.lifecycle.map((value) => ({ key: "lifecycle", label: `比赛状态：${lifecycleLabels[value]}`, value })),
    ...query.verification.map((value) => ({ key: "verification", label: `结果确认：${verificationLabels[value]}`, value })),
    ...query.outcome.map((value) => ({ key: "outcome", label: `特殊结果：${outcomeLabels[value]}`, value })),
  ];

  function removeStateFilter(key: "lifecycle" | "verification" | "outcome", value: string) {
    const values = query[key].filter((item) => item !== value);
    return withScheduleQuery(pathname, currentParams, { [key]: values.length ? values.join(",") : null }, queryOptions);
  }

  return (
    <PublicResultsShell activeSection="schedule" tournament={PUBLIC_PREVIEW_TOURNAMENT}>
      <nav aria-label="选择赛程日期" className={styles.dateRail}>
        <span className={styles.scrollHint}>日期可横向滚动</span>
        <div>
          {PUBLIC_PREVIEW_TOURNAMENT.dates.map((date) => (
            <Link
              aria-current={date.date === query.date ? "date" : undefined}
              className={date.date === query.date ? styles.activeDate : ""}
              href={withScheduleQuery(pathname, currentParams, { date: date.date }, queryOptions)}
              key={date.date}
            >
              <strong>{date.dayLabel}</strong><span>{date.weekdayLabel}</span>
            </Link>
          ))}
        </div>
      </nav>

      <section aria-label="赛程筛选" className={styles.filters}>
        <div className={styles.filterToolbar}>
          <div className={styles.primaryFilters}>
            <label>项目
              <select value={query.competition ?? ""} onChange={(event) => replaceQuery({ competition: event.target.value || null })}>
                <option value="">全部项目</option>
                {competitionOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>比赛状态
              <select value={first(query.lifecycle)} onChange={(event) => replaceQuery({ lifecycle: event.target.value || null })}>
                <option value="">全部状态</option>
                {Object.entries(lifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>场地
              <select value={query.court ?? ""} onChange={(event) => replaceQuery({ court: event.target.value || null })}>
                <option value="">全部场地</option>
                {courtOptions.map((court) => <option key={court} value={court}>{court}</option>)}
              </select>
            </label>
            <label>阶段
              <select value={query.stage ?? ""} onChange={(event) => replaceQuery({ stage: event.target.value || null })}>
                <option value="">全部阶段</option>
                {stageOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>

          <form
            className={styles.searchForm}
            onSubmit={(event) => {
              event.preventDefault();
              const formData = new FormData(event.currentTarget);
              const value = String(formData.get("q") ?? "").trim();
              replaceQuery({ q: value || null });
            }}
            role="search"
          >
            <label htmlFor="public-match-search">搜索允许公开的姓名、编号或代表队</label>
            <div>
              <input
                autoComplete="off"
                defaultValue={query.q}
                id="public-match-search"
                key={query.q}
                maxLength={60}
                name="q"
                placeholder="姓名、比赛编号或代表队"
                type="search"
              />
              <button disabled={isPending} type="submit">{isPending ? "应用中…" : "搜索"}</button>
            </div>
          </form>

          <button
            aria-controls="more-schedule-filters"
            aria-expanded={filtersExpanded}
            aria-label={`更多筛选${hasFilters ? "（已选）" : ""}`}
            className={styles.moreFiltersButton}
            onClick={() => setFiltersExpanded((current) => !current)}
            ref={moreButtonRef}
            type="button"
          >
            更多{hasFilters ? "（已选）" : ""}
          </button>
        </div>

        <div
          className={`${styles.moreFilters} ${filtersExpanded ? styles.moreFiltersOpen : ""}`}
          id="more-schedule-filters"
        >
          <label>结果确认
            <select value={first(query.verification)} onChange={(event) => replaceQuery({ verification: event.target.value || null })}>
              <option value="">全部确认状态</option>
              {Object.entries(verificationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>特殊结果
            <select value={first(query.outcome)} onChange={(event) => replaceQuery({ outcome: event.target.value || null })}>
              <option value="">全部结果类型</option>
              {Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>预览状态
            <select value={query.scenario} onChange={(event) => replaceQuery({ scenario: event.target.value as PreviewScenario })}>
              {Object.entries(previewScenarioLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>

        {parsed.issues.length ? (
          <p className={styles.queryNotice} role="status">链接中有 {parsed.issues.length} 个无效值；无效日期会要求重新选择，其他无效筛选已忽略。</p>
        ) : null}

        {activeStateFilters.length ? (
          <div aria-label="当前已选状态筛选" className={styles.activeFilters}>
            {activeStateFilters.map((filter) => (
              <Link
                aria-label={`移除筛选：${filter.label}`}
                className={styles.filterChip}
                href={removeStateFilter(filter.key as "lifecycle" | "verification" | "outcome", filter.value)}
                key={`${filter.key}-${filter.value}`}
              >
                {filter.label}<span aria-hidden="true">×</span>
              </Link>
            ))}
          </div>
        ) : null}
      </section>

      {showResolvedData && !forcedEmpty ? (
        <div className={styles.resultsToolbar}>
          <p aria-live="polite"><strong>共 {matching.length} 场比赛</strong><span>按权威赛程顺序显示</span></p>
          <div>
            {query.scenario === "stale" ? <span className={styles.staleNotice} role="status">连接中断 · 数据可能过期</span> : null}
            {hasFilters ? <Link className={styles.clearLink} href={clearHref()}>清除筛选</Link> : null}
          </div>
        </div>
      ) : null}

      {query.scenario === "stale" ? (
        <p className={styles.syncNotice} role="status">保留最后一次成功数据；最后同步 {formatPreviewSyncTime(PUBLIC_PREVIEW_TOURNAMENT.updatedAt)}，不会清空或伪造比分。</p>
      ) : null}

      {query.scenario === "loading" ? <PublicScheduleSkeleton /> : null}
      {!invalidDate && query.scenario === "error" ? <PublicErrorState retryHref={withScheduleQuery(pathname, currentParams, { scenario: null }, queryOptions)} /> : null}
      {invalidDate ? (
        <PublicInvalidDateState resetHref={withScheduleQuery(pathname, currentParams, { date: defaultDate, scenario: null }, queryOptions)} />
      ) : null}
      {showResolvedData && matching.length === 0 ? (
        <PublicEmptyState
          clearHref={filteredEmpty ? clearHref() : withScheduleQuery(pathname, currentParams, { date: defaultDate, scenario: null }, queryOptions)}
          filtered={filteredEmpty}
        />
      ) : null}

      {showResolvedData && matching.length ? (
        <>
          <div className={styles.scheduleTableWrap}>
            <table className={styles.scheduleTable}>
              <caption>每日赛程；比赛进度、结果确认和特殊结果分别展示</caption>
              <colgroup>
                <col className={styles.timeColumn} />
                <col className={styles.courtColumn} />
                <col className={styles.matchColumn} />
                <col className={styles.entriesColumn} />
                <col className={styles.scoreColumn} />
                <col className={styles.statusColumn} />
                <col className={styles.actionColumn} />
              </colgroup>
              <thead><tr><th scope="col">时间</th><th scope="col">场地</th><th scope="col">比赛</th><th scope="col">对阵双方</th><th scope="col">比分</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
              <tbody>{matching.map((match) => (
                <ScheduleMatch
                  detailHref={`/public/preview/${PUBLIC_PREVIEW_TOURNAMENT.slug}/matches/${match.code}?${currentParams}`}
                  key={match.code}
                  match={match}
                  presentation="table-row"
                />
              ))}</tbody>
            </table>
          </div>
          <div className={styles.scheduleCards}>
            {matching.map((match) => (
              <ScheduleMatch
                detailHref={`/public/preview/${PUBLIC_PREVIEW_TOURNAMENT.slug}/matches/${match.code}?${currentParams}`}
                key={match.code}
                match={match}
                presentation="card"
              />
            ))}
          </div>
        </>
      ) : null}
    </PublicResultsShell>
  );
}

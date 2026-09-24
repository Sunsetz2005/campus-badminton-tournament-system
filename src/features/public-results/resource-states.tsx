import Link from "next/link";

import { ResourceState } from "@/components/ui/resource-state";

import styles from "./public-results.module.css";

export function PublicScheduleSkeleton() {
  return (
    <section aria-busy="true" aria-label="正在加载赛程" className={styles.skeletonWrap} role="status">
      <span className={styles.srOnly}>正在加载赛程，请稍候。</span>
      <div className={styles.skeletonDates} />
      <div className={styles.skeletonFilters} />
      {Array.from({ length: 4 }, (_, index) => <div className={styles.skeletonRow} key={index} />)}
    </section>
  );
}

export function PublicMatchSkeleton() {
  return (
    <section aria-busy="true" aria-label="正在加载比赛详情" className={styles.skeletonWrap} role="status">
      <span className={styles.srOnly}>正在加载比赛详情，请稍候。</span>
      <div className={styles.skeletonTitle} />
      <div className={styles.skeletonDetailGrid}><div /><div /></div>
    </section>
  );
}

export function PublicErrorState({ retryHref }: { retryHref: string }) {
  return (
    <ResourceState
      action={<Link className={styles.primaryLink} href={retryHref}>重新读取模拟数据</Link>}
      description="这不是空赛程。当前没有取得可显示的数据，页面提供明确的重试入口，也不会伪造比分。"
      eyebrow="连接中断"
      title="暂时无法读取赛程"
      tone="error"
    />
  );
}

export function PublicInvalidDateState({ resetHref }: { resetHref: string }) {
  return (
    <ResourceState
      action={<Link className={styles.secondaryLink} href={resetHref}>选择赛事默认日期</Link>}
      description="链接中的日期不属于本赛事配置。系统没有悄悄切换到另一日，请明确选择可用日期。"
      eyebrow="无效日期"
      title="该日期不在赛事日程中"
      tone="not-found"
    />
  );
}

export function PublicEmptyState({ clearHref, filtered }: { clearHref: string; filtered: boolean }) {
  return (
    <ResourceState
      action={<Link className={styles.secondaryLink} href={clearHref}>{filtered ? "清除筛选" : "查看其他日期"}</Link>}
      description={filtered ? "当前筛选组合没有匹配比赛，已有条件不会被系统静默清除。" : "该日期没有已发布的模拟赛程，请选择其他日期。"}
      eyebrow={filtered ? "无筛选结果" : "当日无赛程"}
      title={filtered ? "没有符合条件的比赛" : "这一天暂未安排比赛"}
      tone="empty"
    />
  );
}

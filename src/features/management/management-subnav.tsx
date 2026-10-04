"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "@/features/management/management.module.css";

export function ManagementSubnav({ slug, resultsOnly = false }: { slug: string; resultsOnly?: boolean }) {
  const pathname = usePathname();
  const base = `/management/${slug}`;
  const all = [
    [base, "赛事概览"],
    [`${base}/registrations`, "报名审核"],
    [`${base}/teams`, "队伍与负责人"],
    [`${base}/draw`, "抽签编排"],
    [`${base}/ties`, "团体对抗"],
    [`${base}/schedule`, "赛程排班"],
    [`${base}/results`, "成绩名次"],
    [`${base}/reports`, "成绩册与导出"],
  ] as const;
  // 只有裁判长角色的账号只看得到「成绩名次」与「成绩册与导出」（其他后台页面服务端同样拒绝）。
  const links = resultsOnly ? all.filter(([href]) => href === `${base}/results` || href === `${base}/reports`) : all;
  return (
    <nav aria-label="赛事后台导航" className={styles.subnav}>
      <Link href="/management">← 全部赛事</Link>
      {links.map(([href, label]) => (
        <Link
          aria-current={pathname === href || (href !== base && pathname.startsWith(`${href}/`)) ? "page" : undefined}
          href={href}
          key={href}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

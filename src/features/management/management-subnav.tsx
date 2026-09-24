"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "@/features/management/management.module.css";

export function ManagementSubnav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/management/${slug}`;
  const links = [
    [base, "赛事概览"],
    [`${base}/registrations`, "报名审核"],
  ] as const;
  return (
    <nav aria-label="赛事后台导航" className={styles.subnav}>
      <Link href="/management">← 全部赛事</Link>
      {links.map(([href, label]) => (
        <Link aria-current={pathname === href ? "page" : undefined} href={href} key={href}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

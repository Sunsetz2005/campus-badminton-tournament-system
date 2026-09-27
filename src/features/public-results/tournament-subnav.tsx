"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface TournamentSubnavSection {
  key: string;
  label: string;
  available: boolean;
}

/** 赛事公开导航。当前页用 aria-current 标出，读屏和样式共用同一个事实。 */
export function TournamentSubnav({
  sections,
  tournamentName,
  tournamentSlug,
}: {
  sections: readonly TournamentSubnavSection[];
  tournamentName: string;
  tournamentSlug: string;
}) {
  const pathname = usePathname();
  const hrefFor = (key: string) => `/public/${tournamentSlug}/${key}`;
  const current = (key: string) => (pathname === hrefFor(key) || pathname.startsWith(`${hrefFor(key)}/`) ? "page" : undefined);

  return (
    <nav aria-label="赛事公开导航" className="tournament-subnav">
      <Link className="tournament-subnav-home" href="/">← 全部赛事</Link>
      <strong className="tournament-subnav-name">{tournamentName}</strong>
      <ul>
        {sections.map((section) => (
          <li key={section.key}>
            {section.available ? (
              <Link aria-current={current(section.key)} href={hrefFor(section.key)}>{section.label}</Link>
            ) : (
              <span aria-disabled="true">{section.label} · 暂未开放</span>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

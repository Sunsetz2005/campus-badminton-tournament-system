import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { getPublicTournamentHeader } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tournamentSlug: string }>;
}): Promise<Metadata> {
  const { tournamentSlug } = await params;
  const tournament = await getPublicTournamentHeader(tournamentSlug);
  return { title: tournament ? `${tournament.name}｜羽赛台` : "赛事不存在｜羽赛台" };
}

/**
 * 五个公开入口。对阵与晋级、小组排名、最终名次和成绩册依赖尚未实现的权威服务，
 * 因此显示为「暂未开放」而不是可点击的假页面、假排名或假下载。
 */
const sections = [
  { key: "schedule", label: "每日赛程", available: true },
  { key: "bracket", label: "对阵与晋级", available: false },
  { key: "standings", label: "小组排名", available: false },
  { key: "rankings", label: "最终名次", available: false },
  { key: "results-book", label: "成绩册", available: false },
] as const;

export default async function PublicTournamentLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ tournamentSlug: string }> }>) {
  const { tournamentSlug } = await params;
  // 在任何子页面的流式边界之前判定；不存在或未发布一律公开 404。
  const tournament = await getPublicTournamentHeader(tournamentSlug);
  if (!tournament) notFound();

  return (
    <>
      <nav aria-label="赛事公开导航" className="tournament-subnav">
        <Link className="tournament-subnav-home" href="/">← 全部赛事</Link>
        <strong className="tournament-subnav-name">{tournament.name}</strong>
        <ul>
          {sections.map((section) => (
            <li key={section.key}>
              {section.available ? (
                <Link href={`/public/${tournamentSlug}/${section.key}`}>{section.label}</Link>
              ) : (
                <span aria-disabled="true">{section.label} · 暂未开放</span>
              )}
            </li>
          ))}
          <li><Link href={`/public/${tournamentSlug}/board`}>现场看板</Link></li>
        </ul>
      </nav>
      {children}
    </>
  );
}

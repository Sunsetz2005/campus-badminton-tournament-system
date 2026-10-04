import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { TournamentSubnav } from "@/features/public-results/tournament-subnav";
import { getPublicTournamentHeader } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tournamentSlug: string }>;
}): Promise<Metadata> {
  const { tournamentSlug } = await params;
  const tournament = await getPublicTournamentHeader(tournamentSlug);
  return { title: tournament ? `${tournament.name}｜赛事台` : "赛事不存在｜赛事台" };
}

/**
 * 公开入口（阶段 7 起全部可用）：「对阵与名次」只列已确认结果、已确认的小组名次与已发布的名次榜单；
 * 「成绩册」只提供组织方生成的当前正式版文件。
 */
const sections = [
  { key: "schedule", label: "每日赛程", available: true },
  { key: "board", label: "现场看板", available: true },
  { key: "results", label: "对阵与名次", available: true },
  { key: "downloads", label: "成绩册", available: true },
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
      <TournamentSubnav sections={sections} tournamentName={tournament.name} tournamentSlug={tournamentSlug} />
      {children}
    </>
  );
}

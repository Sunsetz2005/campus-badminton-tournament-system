import { redirect } from "next/navigation";

import { listPublicTournaments } from "@/server/services/public-tournament-service";

export const dynamic = "force-dynamic";

/**
 * `/board` 原本固定读取单一演示赛事。现场看板已经按赛事拆分到
 * `/public/[tournamentSlug]/board`，这里只保留旧链接的重定向。
 */
export default async function LegacyBoardRedirect() {
  const tournaments = await listPublicTournaments();
  const running = tournaments.find((tournament) => tournament.phase === "RUNNING") ?? tournaments[0];
  redirect(running ? `/public/${running.slug}/board` : "/");
}

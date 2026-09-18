import { prisma } from "@/db/client";
import { publicTournamentSelect } from "@/reports/public-fields";
import { AppError } from "@/server/services/errors";

export async function getPublicTournament(slug: string) {
  const tournament = await prisma.tournament.findFirst({
    where: { slug, status: "PUBLISHED" },
    select: publicTournamentSelect,
  });
  if (!tournament) throw new AppError(404, "tournament_not_found", "公开赛事不存在或尚未发布。");
  return tournament;
}

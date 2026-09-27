-- CreateEnum
CREATE TYPE "MatchSide" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "LineupSource" AS ENUM ('TEAM_MANAGER', 'ADMIN');

-- AlterTable
ALTER TABLE "competition_groups" ADD COLUMN     "ranking" JSONB,
ADD COLUMN     "rankingConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "rankingConfirmedByUserId" UUID;

-- AlterTable
ALTER TABLE "entry_members" ADD COLUMN     "rubberKinds" "CompetitionKind"[] DEFAULT ARRAY[]::"CompetitionKind"[];

-- AlterTable
ALTER TABLE "fixtures" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "lineupsRevealedAt" TIMESTAMP(3),
ADD COLUMN     "winnerEntryId" UUID;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "notPlayedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "registration_members" ADD COLUMN     "rubberKinds" "CompetitionKind"[] DEFAULT ARRAY[]::"CompetitionKind"[];

-- CreateTable
CREATE TABLE "fixture_lineups" (
    "id" UUID NOT NULL,
    "fixtureId" UUID NOT NULL,
    "side" "MatchSide" NOT NULL,
    "entryId" UUID NOT NULL,
    "source" "LineupSource" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "submittedByUserId" UUID,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixture_lineups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_players" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "side" "MatchSide" NOT NULL,
    "slot" INTEGER NOT NULL,
    "entryId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_players_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fixture_lineups_fixtureId_side_key" ON "fixture_lineups"("fixtureId", "side");

-- CreateIndex
CREATE INDEX "match_players_participantId_idx" ON "match_players"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "match_players_matchId_side_slot_key" ON "match_players"("matchId", "side", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "match_players_matchId_participantId_key" ON "match_players"("matchId", "participantId");

-- AddForeignKey
ALTER TABLE "competition_groups" ADD CONSTRAINT "competition_groups_rankingConfirmedByUserId_fkey" FOREIGN KEY ("rankingConfirmedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_winnerEntryId_fkey" FOREIGN KEY ("winnerEntryId") REFERENCES "entries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixture_lineups" ADD CONSTRAINT "fixture_lineups_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "fixtures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixture_lineups" ADD CONSTRAINT "fixture_lineups_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixture_lineups" ADD CONSTRAINT "fixture_lineups_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "participants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

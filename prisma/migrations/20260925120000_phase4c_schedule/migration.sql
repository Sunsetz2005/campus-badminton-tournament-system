-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "teamMaxRubbersFemale" INTEGER,
ADD COLUMN     "teamMaxRubbersMale" INTEGER;

-- AlterTable
ALTER TABLE "courts" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "fixture_lineups" ADD COLUMN     "submittedLate" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "scheduleEstimated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scheduledEndAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "schedule_configs" (
    "tournamentId" UUID NOT NULL,
    "matchMinutes" INTEGER NOT NULL DEFAULT 30,
    "rubberMinutes" INTEGER NOT NULL DEFAULT 25,
    "changeoverMinutes" INTEGER NOT NULL DEFAULT 5,
    "knockoutTieCourts" INTEGER NOT NULL DEFAULT 2,
    "lineupDeadlineMinutes" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_configs_pkey" PRIMARY KEY ("tournamentId")
);

-- CreateTable
CREATE TABLE "schedule_days" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_slots" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "courtId" UUID,
    "startsAt" TIMESTAMP(3),
    "durationMinutes" INTEGER NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "refereeUserId" UUID,
    "updatedByUserId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_publications" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByUserId" UUID,
    "matchCount" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "note" TEXT,

    CONSTRAINT "schedule_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schedule_days_tournamentId_day_key" ON "schedule_days"("tournamentId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_slots_matchId_key" ON "schedule_slots"("matchId");

-- CreateIndex
CREATE INDEX "schedule_slots_tournamentId_idx" ON "schedule_slots"("tournamentId");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_publications_tournamentId_version_key" ON "schedule_publications"("tournamentId", "version");

-- AddForeignKey
ALTER TABLE "schedule_configs" ADD CONSTRAINT "schedule_configs_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_days" ADD CONSTRAINT "schedule_days_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "courts"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_refereeUserId_fkey" FOREIGN KEY ("refereeUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_publications" ADD CONSTRAINT "schedule_publications_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_publications" ADD CONSTRAINT "schedule_publications_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

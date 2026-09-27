-- 阶段 4-B：团体项目、队伍与负责人账号、团体名单性别、抽签与对阵、团体小场。约束与触发器见下一迁移。

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "DrawStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DrawFormat" AS ENUM ('ROUND_ROBIN', 'GROUPS_KNOCKOUT', 'KNOCKOUT');

-- CreateEnum
CREATE TYPE "FixtureKind" AS ENUM ('GROUP', 'KNOCKOUT', 'THIRD_PLACE');

-- CreateEnum
CREATE TYPE "FixtureSourceType" AS ENUM ('ENTRY', 'GROUP_RANK', 'FIXTURE_WINNER', 'FIXTURE_LOSER');

-- AlterEnum
ALTER TYPE "CompetitionKind" ADD VALUE 'TEAM';

-- AlterEnum
ALTER TYPE "EntryType" ADD VALUE 'TEAM';

-- AlterEnum
ALTER TYPE "RegistrationSource" ADD VALUE 'TEAM_MANAGER';

-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "teamMinFemale" INTEGER,
ADD COLUMN     "teamMinMale" INTEGER,
ADD COLUMN     "teamRosterMax" INTEGER,
ADD COLUMN     "teamRosterMin" INTEGER,
ADD COLUMN     "teamRubbers" "CompetitionKind"[] DEFAULT ARRAY[]::"CompetitionKind"[];

-- AlterTable
ALTER TABLE "entries" ADD COLUMN     "teamId" UUID;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "fixtureId" UUID,
ADD COLUMN     "rubberKind" "CompetitionKind",
ADD COLUMN     "rubberOrder" INTEGER;

-- AlterTable
ALTER TABLE "participants" ADD COLUMN     "gender" "Gender";

-- AlterTable
ALTER TABLE "registration_members" ADD COLUMN     "gender" "Gender";

-- AlterTable
ALTER TABLE "registrations" ADD COLUMN     "teamId" UUID;

-- AlterTable
ALTER TABLE "stages" ADD COLUMN     "drawId" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "provisionedForTournamentId" UUID;

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_managers" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_managers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draws" (
    "id" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DrawStatus" NOT NULL DEFAULT 'DRAFT',
    "format" "DrawFormat" NOT NULL,
    "algorithmVersion" TEXT NOT NULL,
    "randomSeed" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "settings" JSONB NOT NULL,
    "adjustments" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "conflictCount" INTEGER NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByUserId" UUID,
    "publishedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "draws_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixtures" (
    "id" UUID NOT NULL,
    "drawId" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "groupId" UUID,
    "code" TEXT NOT NULL,
    "kind" "FixtureKind" NOT NULL,
    "round" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "sideASource" "FixtureSourceType" NOT NULL,
    "sideAEntryId" UUID,
    "sideAGroupId" UUID,
    "sideARank" INTEGER,
    "sideAFixtureId" UUID,
    "sideBSource" "FixtureSourceType" NOT NULL,
    "sideBEntryId" UUID,
    "sideBGroupId" UUID,
    "sideBRank" INTEGER,
    "sideBFixtureId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_tournamentId_code_key" ON "teams"("tournamentId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "teams_tournamentId_name_key" ON "teams"("tournamentId", "name");

-- CreateIndex
CREATE INDEX "team_managers_userId_tournamentId_idx" ON "team_managers"("userId", "tournamentId");

-- CreateIndex
CREATE UNIQUE INDEX "team_managers_teamId_userId_key" ON "team_managers"("teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "draws_competitionId_version_key" ON "draws"("competitionId", "version");

-- CreateIndex
CREATE INDEX "fixtures_drawId_idx" ON "fixtures"("drawId");

-- CreateIndex
CREATE INDEX "fixtures_stageId_idx" ON "fixtures"("stageId");

-- CreateIndex
CREATE UNIQUE INDEX "fixtures_competitionId_code_key" ON "fixtures"("competitionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "entries_competitionId_teamId_key" ON "entries"("competitionId", "teamId");

-- CreateIndex
CREATE INDEX "matches_fixtureId_idx" ON "matches"("fixtureId");

-- CreateIndex
CREATE UNIQUE INDEX "matches_fixtureId_rubberOrder_key" ON "matches"("fixtureId", "rubberOrder");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_provisionedForTournamentId_fkey" FOREIGN KEY ("provisionedForTournamentId") REFERENCES "tournaments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stages" ADD CONSTRAINT "stages_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "draws"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "fixtures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draws" ADD CONSTRAINT "draws_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draws" ADD CONSTRAINT "draws_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draws" ADD CONSTRAINT "draws_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draws" ADD CONSTRAINT "draws_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_drawId_fkey" FOREIGN KEY ("drawId") REFERENCES "draws"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "competition_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_sideAEntryId_fkey" FOREIGN KEY ("sideAEntryId") REFERENCES "entries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_sideBEntryId_fkey" FOREIGN KEY ("sideBEntryId") REFERENCES "entries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_sideAGroupId_fkey" FOREIGN KEY ("sideAGroupId") REFERENCES "competition_groups"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_sideBGroupId_fkey" FOREIGN KEY ("sideBGroupId") REFERENCES "competition_groups"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_sideAFixtureId_fkey" FOREIGN KEY ("sideAFixtureId") REFERENCES "fixtures"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_sideBFixtureId_fkey" FOREIGN KEY ("sideBFixtureId") REFERENCES "fixtures"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

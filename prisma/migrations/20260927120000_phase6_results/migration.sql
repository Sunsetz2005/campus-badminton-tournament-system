-- CreateEnum
CREATE TYPE "ResultSource" AS ENUM ('LIVE', 'RESULT_ONLY');

-- CreateEnum
CREATE TYPE "ResultDispositionDecision" AS ENUM ('MAINTAIN', 'OFFLINE_RULING');

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "resultSource" "ResultSource" NOT NULL DEFAULT 'LIVE';

-- AlterTable
ALTER TABLE "result_revisions" ADD COLUMN     "source" "ResultSource" NOT NULL DEFAULT 'LIVE';

-- CreateTable
CREATE TABLE "ranking_exclusions" (
    "id" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranking_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standings_publications" (
    "id" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "note" TEXT,
    "publishedByUserId" UUID,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standings_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_dispositions" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "decision" "ResultDispositionDecision" NOT NULL,
    "reason" TEXT NOT NULL,
    "blockedBy" JSONB NOT NULL,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ranking_exclusions_groupId_entryId_key" ON "ranking_exclusions"("groupId", "entryId");

-- CreateIndex
CREATE UNIQUE INDEX "standings_publications_competitionId_version_key" ON "standings_publications"("competitionId", "version");

-- CreateIndex
CREATE INDEX "result_dispositions_matchId_idx" ON "result_dispositions"("matchId");

-- AddForeignKey
ALTER TABLE "ranking_exclusions" ADD CONSTRAINT "ranking_exclusions_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "competition_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_exclusions" ADD CONSTRAINT "ranking_exclusions_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranking_exclusions" ADD CONSTRAINT "ranking_exclusions_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standings_publications" ADD CONSTRAINT "standings_publications_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standings_publications" ADD CONSTRAINT "standings_publications_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_dispositions" ADD CONSTRAINT "result_dispositions_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_dispositions" ADD CONSTRAINT "result_dispositions_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 阶段 6 的数据库级不变量：仅结果记录不能混入逐分记分事件；原因不能为空。
-- ---------------------------------------------------------------------------

-- 团体小场只能在裁判台逐分记分，不接受仅结果补录。
ALTER TABLE "matches"
  ADD CONSTRAINT "matches_result_only_not_rubber_check" CHECK ("resultSource" = 'LIVE' OR "rubberKind" IS NULL);

-- 仅结果记录的比赛不能再写入逐分记分事件（反之，已有记分事件的比赛也不能改成仅结果记录）。
CREATE OR REPLACE FUNCTION "reject_events_on_result_only_match"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "matches" WHERE "id" = NEW."matchId" AND "resultSource" = 'RESULT_ONLY') THEN
    RAISE EXCEPTION 'match % is a result-only record and cannot accept scoring events', NEW."matchId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "match_events_reject_result_only"
  BEFORE INSERT ON "match_events"
  FOR EACH ROW EXECUTE FUNCTION "reject_events_on_result_only_match"();

CREATE OR REPLACE FUNCTION "reject_result_only_with_events"() RETURNS trigger AS $$
BEGIN
  IF NEW."resultSource" = 'RESULT_ONLY' AND OLD."resultSource" = 'LIVE'
     AND EXISTS (SELECT 1 FROM "match_events" WHERE "matchId" = NEW."id") THEN
    RAISE EXCEPTION 'match % already has scoring events and cannot become a result-only record', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "matches_reject_result_only_with_events"
  BEFORE UPDATE OF "resultSource" ON "matches"
  FOR EACH ROW EXECUTE FUNCTION "reject_result_only_with_events"();

ALTER TABLE "ranking_exclusions"
  ADD CONSTRAINT "ranking_exclusions_reason_check" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "result_dispositions"
  ADD CONSTRAINT "result_dispositions_reason_check" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "standings_publications"
  ADD CONSTRAINT "standings_publications_version_check" CHECK ("version" > 0);

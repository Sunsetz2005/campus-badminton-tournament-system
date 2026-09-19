ALTER TYPE "ResultRevisionStatus" ADD VALUE IF NOT EXISTS 'RETURNED';

ALTER TABLE "matches"
  ADD COLUMN "controlGeneration" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "match_events"
  ADD COLUMN "domainEventId" TEXT,
  ADD COLUMN "expectedVersion" INTEGER,
  ADD COLUMN "commandFingerprint" TEXT,
  ADD COLUMN "stateBefore" JSONB,
  ADD COLUMN "stateAfter" JSONB,
  ADD COLUMN "stateBeforeHash" TEXT,
  ADD COLUMN "stateAfterHash" TEXT,
  ADD COLUMN "metadata" JSONB,
  ADD COLUMN "response" JSONB,
  ADD COLUMN "engineVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "actorRole" "TournamentRole",
  ADD COLUMN "scoringSessionId" UUID;

ALTER TABLE "scoring_sessions"
  ADD COLUMN "actingRole" "TournamentRole" NOT NULL DEFAULT 'REFEREE',
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revokedReason" TEXT;

ALTER TABLE "result_revisions"
  ADD COLUMN "submittedRole" "TournamentRole",
  ADD COLUMN "reviewedByUserId" UUID,
  ADD COLUMN "reviewedRole" "TournamentRole",
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "returnedAt" TIMESTAMP(3);

CREATE TABLE "match_snapshots" (
  "id" UUID NOT NULL,
  "matchId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "engineVersion" INTEGER NOT NULL DEFAULT 1,
  "initialState" JSONB NOT NULL,
  "initialStateHash" TEXT NOT NULL,
  "state" JSONB NOT NULL,
  "stateHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "match_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "match_snapshots_matchId_key" ON "match_snapshots"("matchId");
CREATE INDEX "match_events_scoringSessionId_idx" ON "match_events"("scoringSessionId");
CREATE INDEX "result_revisions_reviewedByUserId_idx" ON "result_revisions"("reviewedByUserId");

ALTER TABLE "match_snapshots"
  ADD CONSTRAINT "match_snapshots_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "match_events"
  ADD CONSTRAINT "match_events_scoringSessionId_fkey" FOREIGN KEY ("scoringSessionId") REFERENCES "scoring_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "result_revisions"
  ADD CONSTRAINT "result_revisions_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_control_generation_positive" CHECK ("controlGeneration" > 0);
ALTER TABLE "match_snapshots" ADD CONSTRAINT "match_snapshots_version_nonnegative" CHECK ("version" >= 0);
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_expected_version_nonnegative" CHECK ("expectedVersion" IS NULL OR "expectedVersion" >= 0);

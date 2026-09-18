-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CompetitionKind" AS ENUM ('MS', 'WS', 'MD', 'WD', 'XD', 'CUSTOM');

-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('SINGLES', 'DOUBLES');

-- CreateEnum
CREATE TYPE "StageType" AS ENUM ('ROUND_ROBIN', 'KNOCKOUT');

-- CreateEnum
CREATE TYPE "TournamentRole" AS ENUM ('ADMIN', 'ORGANIZER', 'REFEREE', 'CHIEF_REFEREE');

-- CreateEnum
CREATE TYPE "OfficialRole" AS ENUM ('MAIN_REFEREE');

-- CreateEnum
CREATE TYPE "MatchLifecycleStatus" AS ENUM ('SCHEDULED', 'READY', 'IN_PROGRESS', 'SUSPENDED', 'ENDED_PENDING_SUBMISSION', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "MatchOutcomeType" AS ENUM ('NORMAL', 'WO', 'RET', 'DSQ', 'ABANDONED', 'BYE');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING_REVIEW', 'LOCKED', 'DISPUTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ScoringSessionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ResultRevisionStatus" AS ENUM ('PENDING', 'LOCKED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournaments" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "status" "TournamentStatus" NOT NULL DEFAULT 'DRAFT',
    "defaultRuleRevisionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitions" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "CompetitionKind" NOT NULL,
    "entryType" "EntryType" NOT NULL,
    "ruleProfileRevisionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "id" UUID NOT NULL,
    "publicCode" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "teamName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entries" (
    "id" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "entryType" "EntryType" NOT NULL,
    "frozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entry_members" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "entry_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stages" (
    "id" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StageType" NOT NULL,
    "order" INTEGER NOT NULL,
    "ruleProfileRevisionId" UUID,
    "frozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_groups" (
    "id" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competition_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courts" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_profiles" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rule_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_profile_revisions" (
    "id" UUID NOT NULL,
    "ruleProfileId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "adoptedAt" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_profile_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "stageId" UUID NOT NULL,
    "groupId" UUID,
    "courtId" UUID,
    "sideAEntryId" UUID,
    "sideBEntryId" UUID,
    "lifecycleStatus" "MatchLifecycleStatus" NOT NULL DEFAULT 'SCHEDULED',
    "outcomeType" "MatchOutcomeType",
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_rule_snapshots" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "ruleProfileRevisionId" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "sourceChain" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_rule_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "scoreA" INTEGER NOT NULL DEFAULT 0,
    "scoreB" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_events" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "commandId" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actorUserId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring_sessions" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceSessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "takeoverGeneration" INTEGER NOT NULL DEFAULT 1,
    "status" "ScoringSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scoring_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_revisions" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "ResultRevisionStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB NOT NULL,
    "reason" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "role" "TournamentRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "official_assignments" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OfficialRole" NOT NULL DEFAULT 'MAIN_REFEREE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "official_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tournamentId" UUID,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "tournaments_slug_key" ON "tournaments"("slug");

-- CreateIndex
CREATE INDEX "competitions_tournamentId_idx" ON "competitions"("tournamentId");

-- CreateIndex
CREATE UNIQUE INDEX "competitions_tournamentId_code_key" ON "competitions"("tournamentId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "participants_publicCode_key" ON "participants"("publicCode");

-- CreateIndex
CREATE INDEX "entries_competitionId_idx" ON "entries"("competitionId");

-- CreateIndex
CREATE UNIQUE INDEX "entries_competitionId_code_key" ON "entries"("competitionId", "code");

-- CreateIndex
CREATE INDEX "entry_members_participantId_idx" ON "entry_members"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "entry_members_entryId_participantId_key" ON "entry_members"("entryId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "entry_members_entryId_slot_key" ON "entry_members"("entryId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "stages_competitionId_code_key" ON "stages"("competitionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "competition_groups_stageId_code_key" ON "competition_groups"("stageId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "courts_tournamentId_code_key" ON "courts"("tournamentId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "rule_profiles_tournamentId_key_key" ON "rule_profiles"("tournamentId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "rule_profile_revisions_ruleProfileId_revision_key" ON "rule_profile_revisions"("ruleProfileId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "matches_code_key" ON "matches"("code");

-- CreateIndex
CREATE INDEX "matches_stageId_idx" ON "matches"("stageId");

-- CreateIndex
CREATE INDEX "matches_courtId_scheduledAt_idx" ON "matches"("courtId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "match_rule_snapshots_matchId_key" ON "match_rule_snapshots"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "games_matchId_number_key" ON "games"("matchId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "match_events_commandId_key" ON "match_events"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "match_events_matchId_version_key" ON "match_events"("matchId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "scoring_sessions_tokenHash_key" ON "scoring_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "scoring_sessions_matchId_status_idx" ON "scoring_sessions"("matchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "result_revisions_matchId_revision_key" ON "result_revisions"("matchId", "revision");

-- CreateIndex
CREATE INDEX "role_assignments_tournamentId_role_idx" ON "role_assignments"("tournamentId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_userId_tournamentId_role_key" ON "role_assignments"("userId", "tournamentId", "role");

-- CreateIndex
CREATE INDEX "official_assignments_userId_active_idx" ON "official_assignments"("userId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "official_assignments_matchId_userId_role_key" ON "official_assignments"("matchId", "userId", "role");

-- CreateIndex
CREATE INDEX "audit_logs_tournamentId_occurredAt_idx" ON "audit_logs"("tournamentId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_occurredAt_idx" ON "audit_logs"("actorUserId", "occurredAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_defaultRuleRevisionId_fkey" FOREIGN KEY ("defaultRuleRevisionId") REFERENCES "rule_profile_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_ruleProfileRevisionId_fkey" FOREIGN KEY ("ruleProfileRevisionId") REFERENCES "rule_profile_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_members" ADD CONSTRAINT "entry_members_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_members" ADD CONSTRAINT "entry_members_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stages" ADD CONSTRAINT "stages_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stages" ADD CONSTRAINT "stages_ruleProfileRevisionId_fkey" FOREIGN KEY ("ruleProfileRevisionId") REFERENCES "rule_profile_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_groups" ADD CONSTRAINT "competition_groups_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courts" ADD CONSTRAINT "courts_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_profiles" ADD CONSTRAINT "rule_profiles_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_profile_revisions" ADD CONSTRAINT "rule_profile_revisions_ruleProfileId_fkey" FOREIGN KEY ("ruleProfileId") REFERENCES "rule_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "competition_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_courtId_fkey" FOREIGN KEY ("courtId") REFERENCES "courts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_sideAEntryId_fkey" FOREIGN KEY ("sideAEntryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_sideBEntryId_fkey" FOREIGN KEY ("sideBEntryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_rule_snapshots" ADD CONSTRAINT "match_rule_snapshots_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_rule_snapshots" ADD CONSTRAINT "match_rule_snapshots_ruleProfileRevisionId_fkey" FOREIGN KEY ("ruleProfileRevisionId") REFERENCES "rule_profile_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring_sessions" ADD CONSTRAINT "scoring_sessions_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring_sessions" ADD CONSTRAINT "scoring_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_revisions" ADD CONSTRAINT "result_revisions_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_revisions" ADD CONSTRAINT "result_revisions_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "official_assignments" ADD CONSTRAINT "official_assignments_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "official_assignments" ADD CONSTRAINT "official_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

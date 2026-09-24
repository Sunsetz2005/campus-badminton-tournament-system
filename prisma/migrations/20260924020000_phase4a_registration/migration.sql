-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('USER', 'SYSTEM_ADMIN');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RegistrationSource" AS ENUM ('MANUAL', 'IMPORT', 'INVITE');

-- DropForeignKey
ALTER TABLE "entry_members" DROP CONSTRAINT "entry_members_participantId_fkey";

-- DropIndex
DROP INDEX "participants_publicCode_key";

-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "nextEntrySeq" INTEGER NOT NULL DEFAULT 1;

-- AlterTable（先以可空列加入，回填后再收紧为 NOT NULL）
ALTER TABLE "entry_members" ADD COLUMN     "competitionId" UUID;

-- AlterTable
ALTER TABLE "participants" ADD COLUMN     "contact" TEXT,
ADD COLUMN     "studentId" TEXT,
ADD COLUMN     "tournamentId" UUID;

-- 回填：entry_members.competitionId 取自所属 entries。
-- 成员数触发器是 DEFERRABLE 的；先改为立即检查，否则挂起的触发器事件会阻止同一事务内的 ALTER TABLE。
SET CONSTRAINTS "entry_members_exact_count" IMMEDIATE;
UPDATE "entry_members" AS em
SET "competitionId" = e."competitionId"
FROM "entries" AS e
WHERE em."entryId" = e."id";

-- 回填：参赛人员归属到其报名所在的唯一赛事。
-- 无法唯一判定（未参加任何报名，或跨多个赛事）的记录不做猜测，直接中止迁移，交由人工处理。
DO $$
DECLARE
  ambiguous_count integer;
BEGIN
  SELECT count(*) INTO ambiguous_count
  FROM "participants" AS p
  WHERE (
    SELECT count(DISTINCT c."tournamentId")
    FROM "entry_members" AS em
      JOIN "competitions" AS c ON c."id" = em."competitionId"
    WHERE em."participantId" = p."id"
  ) <> 1;
  IF ambiguous_count > 0 THEN
    RAISE EXCEPTION '% participant(s) cannot be attributed to exactly one tournament; migration stopped without guessing', ambiguous_count;
  END IF;
END;
$$;

UPDATE "participants" AS p
SET "tournamentId" = sub."tournamentId"
FROM (
  SELECT DISTINCT em."participantId", c."tournamentId"
  FROM "entry_members" AS em
    JOIN "competitions" AS c ON c."id" = em."competitionId"
) AS sub
WHERE sub."participantId" = p."id";

ALTER TABLE "entry_members" ALTER COLUMN "competitionId" SET NOT NULL;
ALTER TABLE "participants" ALTER COLUMN "tournamentId" SET NOT NULL;

-- AlterTable
ALTER TABLE "tournaments" ADD COLUMN     "nextParticipantSeq" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "registrationClosesAt" TIMESTAMP(3),
ADD COLUMN     "registrationOpensAt" TIMESTAMP(3),
ADD COLUMN     "regulations" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "systemRole" "SystemRole" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "registrations" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "competitionId" UUID NOT NULL,
    "referenceCode" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "RegistrationSource" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "dedupeKey" TEXT,
    "note" TEXT,
    "reviewReason" TEXT,
    "entryId" UUID,
    "inviteId" UUID,
    "importBatchId" UUID,
    "importRowNumber" INTEGER,
    "submittedByUserId" UUID,
    "submitterFingerprint" TEXT,
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_members" (
    "id" UUID NOT NULL,
    "registrationId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "studentId" TEXT,
    "teamName" TEXT,
    "contact" TEXT,
    "participantId" UUID,

    CONSTRAINT "registration_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_invites" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxSubmissions" INTEGER NOT NULL,
    "submissionCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registration_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_import_batches" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "contentHash" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "createdCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "registrations_referenceCode_key" ON "registrations"("referenceCode");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_entryId_key" ON "registrations"("entryId");

-- CreateIndex
CREATE INDEX "registrations_tournamentId_status_createdAt_idx" ON "registrations"("tournamentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "registrations_competitionId_status_idx" ON "registrations"("competitionId", "status");

-- CreateIndex
CREATE INDEX "registrations_inviteId_createdAt_idx" ON "registrations"("inviteId", "createdAt");

-- CreateIndex
CREATE INDEX "registration_members_participantId_idx" ON "registration_members"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "registration_members_registrationId_slot_key" ON "registration_members"("registrationId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "registration_invites_tokenHash_key" ON "registration_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "registration_invites_tournamentId_idx" ON "registration_invites"("tournamentId");

-- CreateIndex
CREATE UNIQUE INDEX "registration_import_batches_tournamentId_contentHash_key" ON "registration_import_batches"("tournamentId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "entry_members_competitionId_participantId_key" ON "entry_members"("competitionId", "participantId");

-- CreateIndex
CREATE INDEX "participants_tournamentId_displayName_idx" ON "participants"("tournamentId", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "participants_tournamentId_publicCode_key" ON "participants"("tournamentId", "publicCode");

-- CreateIndex
CREATE UNIQUE INDEX "participants_tournamentId_studentId_key" ON "participants"("tournamentId", "studentId");

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_members" ADD CONSTRAINT "entry_members_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "participants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entry_members" ADD CONSTRAINT "entry_members_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "registration_invites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "registration_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_members" ADD CONSTRAINT "registration_members_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_members" ADD CONSTRAINT "registration_members_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_import_batches" ADD CONSTRAINT "registration_import_batches_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_import_batches" ADD CONSTRAINT "registration_import_batches_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 阶段 4-A 的数据库级不变量与回填。表单校验之外，数据库兜底。
-- ---------------------------------------------------------------------------

-- 回填：编号序列从既有记录之后继续，避免与种子编号冲突。
UPDATE "tournaments" AS t
SET "nextParticipantSeq" = (SELECT count(*) + 1 FROM "participants" AS p WHERE p."tournamentId" = t."id");

UPDATE "competitions" AS c
SET "nextEntrySeq" = (SELECT count(*) + 1 FROM "entries" AS e WHERE e."competitionId" = c."id");

ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_registration_window_check"
  CHECK ("registrationOpensAt" IS NULL OR "registrationClosesAt" IS NULL OR "registrationOpensAt" < "registrationClosesAt"),
  ADD CONSTRAINT "tournaments_next_participant_seq_check" CHECK ("nextParticipantSeq" > 0);

ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_next_entry_seq_check" CHECK ("nextEntrySeq" > 0);

ALTER TABLE "participants"
  ADD CONSTRAINT "participants_display_name_check" CHECK (length(btrim("displayName")) > 0),
  ADD CONSTRAINT "participants_student_id_check" CHECK ("studentId" IS NULL OR length(btrim("studentId")) > 0);

-- 同一报名单位的成员必须来自同一项目、同一赛事；competitionId 是冗余列，不允许与 entries 漂移。
CREATE FUNCTION "validate_entry_member_scope"() RETURNS trigger AS $$
DECLARE
  entry_competition uuid;
  competition_tournament uuid;
  participant_tournament uuid;
BEGIN
  SELECT "competitionId" INTO entry_competition FROM "entries" WHERE "id" = NEW."entryId";
  IF entry_competition IS DISTINCT FROM NEW."competitionId" THEN
    RAISE EXCEPTION 'entry_members.competitionId must equal entries.competitionId';
  END IF;
  SELECT "tournamentId" INTO competition_tournament FROM "competitions" WHERE "id" = NEW."competitionId";
  SELECT "tournamentId" INTO participant_tournament FROM "participants" WHERE "id" = NEW."participantId";
  IF competition_tournament IS DISTINCT FROM participant_tournament THEN
    RAISE EXCEPTION 'participant belongs to a different tournament than the entry';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entry_members_scope"
  BEFORE INSERT OR UPDATE ON "entry_members"
  FOR EACH ROW EXECUTE FUNCTION "validate_entry_member_scope"();

-- 报名状态与 Entry 的对应关系：只有已通过的报名挂着 Entry；驳回必须写原因。
ALTER TABLE "registrations"
  ADD CONSTRAINT "registrations_entry_requires_approved_check" CHECK ("entryId" IS NULL OR "status" = 'APPROVED'),
  ADD CONSTRAINT "registrations_approved_requires_entry_check" CHECK ("status" <> 'APPROVED' OR "entryId" IS NOT NULL),
  ADD CONSTRAINT "registrations_rejected_requires_reason_check"
    CHECK ("status" <> 'REJECTED' OR length(btrim(coalesce("reviewReason", ''))) > 0),
  ADD CONSTRAINT "registrations_nonnegative_version_check" CHECK ("version" >= 0),
  ADD CONSTRAINT "registrations_import_row_check" CHECK ("importRowNumber" IS NULL OR "importRowNumber" > 0);

-- 学号齐全时的去重键：同一项目内进行中/已通过的报名不能重复（A+B 与 B+A 生成同一个键）。
CREATE UNIQUE INDEX "registrations_active_dedupe_key"
  ON "registrations" ("competitionId", "dedupeKey")
  WHERE "dedupeKey" IS NOT NULL AND "status" IN ('PENDING', 'APPROVED');

ALTER TABLE "registration_members"
  ADD CONSTRAINT "registration_members_slot_check" CHECK ("slot" IN (1, 2)),
  ADD CONSTRAINT "registration_members_display_name_check" CHECK (length(btrim("displayName")) > 0);

-- 报名所属赛事必须与项目所属赛事一致。
CREATE FUNCTION "validate_registration_scope"() RETURNS trigger AS $$
DECLARE
  competition_tournament uuid;
BEGIN
  SELECT "tournamentId" INTO competition_tournament FROM "competitions" WHERE "id" = NEW."competitionId";
  IF competition_tournament IS DISTINCT FROM NEW."tournamentId" THEN
    RAISE EXCEPTION 'registration tournament must match competition tournament';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "registrations_scope"
  BEFORE INSERT OR UPDATE ON "registrations"
  FOR EACH ROW EXECUTE FUNCTION "validate_registration_scope"();

-- 单打报名恰好 1 人、双打恰好 2 人，提交时校验（与 entries 的约束触发器同一做法）。
CREATE FUNCTION "validate_registration_member_count"() RETURNS trigger AS $$
DECLARE
  target_id uuid;
  expected_count integer;
  actual_count integer;
BEGIN
  IF TG_TABLE_NAME = 'registrations' THEN
    target_id := NEW."id";
  ELSE
    target_id := COALESCE(NEW."registrationId", OLD."registrationId");
  END IF;

  SELECT CASE c."entryType" WHEN 'SINGLES' THEN 1 WHEN 'DOUBLES' THEN 2 END
  INTO expected_count
  FROM "registrations" AS r
    JOIN "competitions" AS c ON c."id" = r."competitionId"
  WHERE r."id" = target_id;

  IF expected_count IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO actual_count FROM "registration_members" WHERE "registrationId" = target_id;
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'registration % requires % member(s), found %', target_id, expected_count, actual_count;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "registration_members_exact_count"
  AFTER INSERT OR UPDATE OR DELETE ON "registration_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_registration_member_count"();

CREATE CONSTRAINT TRIGGER "registrations_exact_member_count"
  AFTER INSERT OR UPDATE ON "registrations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_registration_member_count"();

ALTER TABLE "registration_invites"
  ADD CONSTRAINT "registration_invites_max_submissions_check" CHECK ("maxSubmissions" > 0),
  ADD CONSTRAINT "registration_invites_submission_count_check"
    CHECK ("submissionCount" >= 0 AND "submissionCount" <= "maxSubmissions");

ALTER TABLE "registration_import_batches"
  ADD CONSTRAINT "registration_import_batches_counts_check"
    CHECK ("rowCount" >= 0 AND "createdCount" >= 0 AND "skippedCount" >= 0 AND "createdCount" + "skippedCount" <= "rowCount");

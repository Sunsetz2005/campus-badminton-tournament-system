-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('REGISTRATIONS_INTERNAL', 'DATA_WORKBOOK', 'BOOKLET_PDF');

-- CreateEnum
CREATE TYPE "ReportEdition" AS ENUM ('DRAFT', 'OFFICIAL');

-- CreateTable
CREATE TABLE "report_exports" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "edition" "ReportEdition",
    "version" INTEGER NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "sources" JSONB NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "supersededByExportId" UUID,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_exports_tournamentId_createdAt_idx" ON "report_exports"("tournamentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "report_exports_tournamentId_kind_version_key" ON "report_exports"("tournamentId", "kind", "version");

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 被哪一份导出替代（同赛事同种文件）。延迟到提交时检查：同一事务里先把旧版标记为已被替代
-- （腾出「当前正式版」唯一索引），再写入新版。NO ACTION：整赛事删除时新旧版本一并删除；
-- 单独删除较新版本会在提交时被拒绝，历史替代链不会断。
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_supersededByExportId_fkey" FOREIGN KEY ("supersededByExportId") REFERENCES "report_exports"("id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- 内部报名名单没有草稿/正式之分；其余两种必须标明。
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_edition_by_kind"
  CHECK (("kind" = 'REGISTRATIONS_INTERNAL') = ("edition" IS NULL));

ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_version_positive" CHECK ("version" >= 1);

-- 文件大小与内容一致，且不超过 16 MiB。
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_byte_size"
  CHECK ("byteSize" = octet_length("content") AND "byteSize" > 0 AND "byteSize" <= 16777216);

ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_hash_format"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND "snapshotHash" ~ '^[0-9a-f]{64}$');

-- 文件名由服务端生成，只允许 ASCII 安全字符（中文名另经 RFC 5987 编码下发）。
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_file_name_safe"
  CHECK ("fileName" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$');

-- 只有正式版会被替代；替代时间与替代者成对出现。
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_superseded_pair"
  CHECK (("supersededAt" IS NULL) = ("supersededByExportId" IS NULL)
     AND ("supersededAt" IS NULL OR "edition" = 'OFFICIAL'));

-- 同一赛事同一种文件，同时最多只有一份「当前」正式版。
CREATE UNIQUE INDEX "report_exports_one_current_official"
  ON "report_exports"("tournamentId", "kind")
  WHERE "edition" = 'OFFICIAL' AND "supersededAt" IS NULL;

-- 已生成的文件不可改写：只允许把「当前」正式版一次性标记为已被替代。
CREATE FUNCTION "report_exports_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tournamentId" IS DISTINCT FROM OLD."tournamentId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."edition" IS DISTINCT FROM OLD."edition"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."snapshotHash" IS DISTINCT FROM OLD."snapshotHash"
     OR NEW."capturedAt" IS DISTINCT FROM OLD."capturedAt"
     OR NEW."sources" IS DISTINCT FROM OLD."sources"
     OR NEW."fileName" IS DISTINCT FROM OLD."fileName"
     OR NEW."contentType" IS DISTINCT FROM OLD."contentType"
     OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
     OR NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'report export % is immutable', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."supersededAt" IS NOT NULL
     AND (NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt"
          OR NEW."supersededByExportId" IS DISTINCT FROM OLD."supersededByExportId") THEN
    RAISE EXCEPTION 'report export % is already superseded', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "report_exports_immutable"
  BEFORE UPDATE ON "report_exports"
  FOR EACH ROW EXECUTE FUNCTION "report_exports_immutable"();

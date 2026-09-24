-- CreateEnum
CREATE TYPE "TournamentPhase" AS ENUM ('PREPARING', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'RUNNING', 'FINISHED');

-- CreateEnum
CREATE TYPE "NamePublicationPolicy" AS ENUM ('CODES_ONLY', 'DISPLAY_NAMES');

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tournaments" ADD COLUMN     "endDate" DATE,
ADD COLUMN     "namePolicy" "NamePublicationPolicy" NOT NULL DEFAULT 'CODES_ONLY',
ADD COLUMN     "organizer" TEXT,
ADD COLUMN     "phase" "TournamentPhase" NOT NULL DEFAULT 'PREPARING',
ADD COLUMN     "posterAlt" TEXT,
ADD COLUMN     "posterPath" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "startDate" DATE,
ADD COLUMN     "subtitle" TEXT,
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "venue" TEXT;

-- CreateIndex
CREATE INDEX "matches_publishedAt_scheduledAt_idx" ON "matches"("publishedAt", "scheduledAt");

-- 阶段 4-0 的数据库级不变量与回填。
-- 与阶段 1 一样：能由数据库兜底的业务不变量就写在迁移里，不只写在表单里。

-- 回填：已发布赛事补发布时间，并保留其当前的公开姓名行为。
-- 现有演示赛事的选手名本身就是虚构匿名名，因此显式标为 DISPLAY_NAMES，
-- 而不是让新默认值 CODES_ONLY 悄悄改变既有公开页的展示。
UPDATE "tournaments"
SET "publishedAt" = COALESCE("publishedAt", "createdAt"),
    "namePolicy" = 'DISPLAY_NAMES',
    "phase" = 'RUNNING'
WHERE "status" = 'PUBLISHED';

-- 回填：逐场公开发布边界。既有比赛全部属于已发布的演示赛事，视为已公开。
UPDATE "matches" AS m
SET "publishedAt" = m."createdAt"
FROM "stages" AS s
  JOIN "competitions" AS c ON c."id" = s."competitionId"
  JOIN "tournaments" AS t ON t."id" = c."tournamentId"
WHERE m."stageId" = s."id"
  AND t."status" = 'PUBLISHED'
  AND m."publishedAt" IS NULL;

-- 日期区间必须自洽。
ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_date_range_check"
  CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate");

-- 海报只允许安全的扁平文件名，挡住路径穿越与任意扩展名。
ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_poster_path_check"
  CHECK ("posterPath" IS NULL OR "posterPath" ~ '^[a-z0-9][a-z0-9-]{0,62}\.(webp|jpg|png)$');

-- slug 直接出现在公开 URL 中，必须是稳定且有长度上限的安全路径段。
ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_slug_format_check"
  CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$');

-- 已发布赛事必须有发布时间，公开投影才有可信的发布边界。
ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_published_requires_timestamp_check"
  CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);

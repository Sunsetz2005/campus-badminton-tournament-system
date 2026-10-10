-- 裁判执裁方式：共用裁判员账号（任意场次）或逐场指派。既有赛事保持逐场指派，避免改变已发布赛程的权限含义。
CREATE TYPE "RefereeMode" AS ENUM ('SHARED_ACCOUNT', 'PER_MATCH');
ALTER TABLE "tournaments" ADD COLUMN "refereeMode" "RefereeMode" NOT NULL DEFAULT 'PER_MATCH';

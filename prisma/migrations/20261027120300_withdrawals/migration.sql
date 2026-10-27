-- 赛务口径 W-2 / W-4 / W-7（2026-10-27）：选手退出或被取消资格、团体报名单位整体退出。
-- 由裁判长登记；未开始的比赛以 WO 判给对手，后续签位记为空位，团体小场按认输计（BWF GCR 13.6、16.3.7；ITTO 3.6.2.2）。
CREATE TYPE "WithdrawalKind" AS ENUM ('WITHDRAWN', 'DISQUALIFIED');

ALTER TABLE "participants"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawalKind" "WithdrawalKind",
  ADD COLUMN "withdrawalReason" TEXT;
ALTER TABLE "participants"
  ADD CONSTRAINT "participants_withdrawal_check" CHECK (
    ("withdrawnAt" IS NULL AND "withdrawalKind" IS NULL AND "withdrawalReason" IS NULL)
    OR ("withdrawnAt" IS NOT NULL AND "withdrawalKind" IS NOT NULL AND length(btrim("withdrawalReason")) > 0)
  );

ALTER TABLE "entries"
  ADD COLUMN "withdrawnAt" TIMESTAMP(3),
  ADD COLUMN "withdrawalReason" TEXT;
ALTER TABLE "entries"
  ADD CONSTRAINT "entries_withdrawal_check" CHECK (
    ("withdrawnAt" IS NULL AND "withdrawalReason" IS NULL)
    OR ("withdrawnAt" IS NOT NULL AND length(btrim("withdrawalReason")) > 0)
  );

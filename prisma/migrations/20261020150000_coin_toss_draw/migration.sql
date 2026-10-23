-- 系统抛币：服务端随机决定胜方，按抽签时的比赛版本保存，刷新或换设备都不会重抽。
ALTER TABLE "matches" ADD COLUMN "coinTossDrawSide" "MatchSide";
ALTER TABLE "matches" ADD COLUMN "coinTossDrawVersion" INTEGER;
ALTER TABLE "matches" ADD COLUMN "coinTossDrawnAt" TIMESTAMP(3);
ALTER TABLE "matches" ADD CONSTRAINT "matches_coin_toss_draw_complete" CHECK (
  ("coinTossDrawSide" IS NULL AND "coinTossDrawVersion" IS NULL AND "coinTossDrawnAt" IS NULL)
  OR ("coinTossDrawSide" IS NOT NULL AND "coinTossDrawVersion" >= 0 AND "coinTossDrawnAt" IS NOT NULL)
);

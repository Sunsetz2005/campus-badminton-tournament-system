-- 赛务口径 O-2（2026-10-27，用户决定）：共用裁判账号模式下，裁判在工作台取得控制前填写本人姓名，
-- 记在控制会话上，用来追溯每场比赛实际由谁执裁（并发仿真 §13.9：共用账号原先无从区分执裁人）。
ALTER TABLE "scoring_sessions" ADD COLUMN "officiatingName" TEXT;
ALTER TABLE "scoring_sessions"
  ADD CONSTRAINT "scoring_sessions_officiating_name_check" CHECK (
    "officiatingName" IS NULL OR (length(btrim("officiatingName")) BETWEEN 1 AND 40)
  );

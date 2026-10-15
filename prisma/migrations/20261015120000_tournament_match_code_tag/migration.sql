-- AUD-008：比赛编号前缀改为持久化、唯一的赛事标签。
-- 4 位摘要标签只有 31^4 种取值，不同赛事可能撞上同一前缀；由数据库唯一约束兜底，分配时避开冲突。
-- 既有赛事保持为空，首次需要时按原摘要算法优先沿用，已发布的比赛编号不受影响。
ALTER TABLE "tournaments" ADD COLUMN "matchCodeTag" TEXT;
CREATE UNIQUE INDEX "tournaments_matchCodeTag_key" ON "tournaments"("matchCodeTag");

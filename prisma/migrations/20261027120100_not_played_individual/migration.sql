-- 因对手空缺直接决出的个人项目淘汰比赛同样记为「未进行」；原约束只允许团体小场。
ALTER TABLE "matches" DROP CONSTRAINT "matches_not_played_check";
ALTER TABLE "matches"
  ADD CONSTRAINT "matches_not_played_check" CHECK (
    "notPlayedAt" IS NULL
    OR ("fixtureId" IS NOT NULL AND "version" = 0 AND "lifecycleStatus" IN ('SCHEDULED', 'READY'))
  );

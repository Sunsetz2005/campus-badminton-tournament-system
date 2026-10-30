-- 赛务口径 S-9（2026-10-30，用户选定方案 A2「暂停离场待续」）：场地全满时，裁判长可让一场暂停中的比赛
-- 离开场地，比分与发接发不变，场地改为「待分配」，原场地立即腾出；恢复前必须先转到一块空场地（S-5）。
-- awaitingCourtSince 非空 = 离场待续中；离场待续时一定没有场地。
ALTER TABLE "matches" ADD COLUMN "awaitingCourtSince" TIMESTAMP(3);
ALTER TABLE "matches" ADD CONSTRAINT "matches_awaiting_court_has_no_court"
  CHECK ("awaitingCourtSince" IS NULL OR "courtId" IS NULL);

-- 已开始比赛的计划时间与场地仍然冻结。例外只有两种，都要求暂停中、计划时间不变、且本事务显式声明：
--   转场 badminton.court_transfer = 'on'：改到一块场地；
--   离场 badminton.court_release  = 'on'：场地改为空。
CREATE OR REPLACE FUNCTION "protect_started_match_schedule"() RETURNS trigger AS $$
BEGIN
  IF (OLD."version" > 0 OR OLD."lifecycleStatus" NOT IN ('SCHEDULED', 'READY'))
     AND (NEW."scheduledAt" IS DISTINCT FROM OLD."scheduledAt"
          OR NEW."scheduledEndAt" IS DISTINCT FROM OLD."scheduledEndAt"
          OR NEW."courtId" IS DISTINCT FROM OLD."courtId") THEN
    IF OLD."lifecycleStatus" = 'SUSPENDED'
       AND NEW."scheduledAt" IS NOT DISTINCT FROM OLD."scheduledAt"
       AND NEW."scheduledEndAt" IS NOT DISTINCT FROM OLD."scheduledEndAt"
       AND ((NEW."courtId" IS NOT NULL AND current_setting('badminton.court_transfer', true) = 'on')
            OR (NEW."courtId" IS NULL AND current_setting('badminton.court_release', true) = 'on')) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'schedule of a started match % cannot change', OLD."code";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

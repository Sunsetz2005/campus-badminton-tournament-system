-- 赛务口径 S-5（2026-10-27，P-05）：裁判长可以把暂停中的比赛转到另一块场地，比分与发接发不变，
-- 从暂停处继续（BWF Laws 16.3.3；GCR 17.1.1 裁判长总负责）。
-- 已开始比赛的计划时间与场地仍然冻结；唯一例外是「暂停中、只改场地、且本事务显式声明是转场」。
-- 声明用事务级设置 badminton.court_transfer = 'on'（set_config(..., true)），只有转场命令会设置。
CREATE OR REPLACE FUNCTION "protect_started_match_schedule"() RETURNS trigger AS $$
BEGIN
  IF (OLD."version" > 0 OR OLD."lifecycleStatus" NOT IN ('SCHEDULED', 'READY'))
     AND (NEW."scheduledAt" IS DISTINCT FROM OLD."scheduledAt"
          OR NEW."scheduledEndAt" IS DISTINCT FROM OLD."scheduledEndAt"
          OR NEW."courtId" IS DISTINCT FROM OLD."courtId") THEN
    IF OLD."lifecycleStatus" = 'SUSPENDED'
       AND NEW."scheduledAt" IS NOT DISTINCT FROM OLD."scheduledAt"
       AND NEW."scheduledEndAt" IS NOT DISTINCT FROM OLD."scheduledEndAt"
       AND NEW."courtId" IS NOT NULL
       AND current_setting('badminton.court_transfer', true) = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'schedule of a started match % cannot change', OLD."code";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

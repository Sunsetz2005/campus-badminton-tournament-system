-- 独立复判 2026-11-09 RV-01 / RV-02 的数据库兜底。

-- RV-01：S-8「一块场地同时只进行一场」此前只在应用事务里检查。转场（读已提交）与开局（可串行化）并发时，
-- 两边都读到「场地空闲」后各自提交，一块场地上出现两场。
-- 这里在比赛「新进入占用」时（变为进行中/暂停中，或换到另一块场地）先改写一次场地行：
--   * 读已提交的事务在场地行上排队，拿到行锁后用新快照检查，看得到对方已提交的比赛；
--   * 可串行化的事务改写一行已被并发事务改写过的行，会以 40001 失败、由 runTransaction 整体重试，
--     重试后应用层检查给出带比赛编号的提示。
-- 只检查「新进入」，不追溯既有数据：S-8 上线前留下的同场多场比赛照常可以续打、结束。
CREATE OR REPLACE FUNCTION "guard_court_single_occupancy"() RETURNS trigger AS $$
DECLARE
  busy_code text;
BEGIN
  IF NEW."courtId" IS NOT NULL
     AND NEW."lifecycleStatus" IN ('IN_PROGRESS', 'SUSPENDED')
     AND (TG_OP = 'INSERT'
          OR OLD."courtId" IS DISTINCT FROM NEW."courtId"
          OR OLD."lifecycleStatus" NOT IN ('IN_PROGRESS', 'SUSPENDED')) THEN
    UPDATE "courts" SET "sortOrder" = "sortOrder" WHERE "id" = NEW."courtId";
    SELECT "code" INTO busy_code FROM "matches"
      WHERE "courtId" = NEW."courtId" AND "id" <> NEW."id" AND "lifecycleStatus" IN ('IN_PROGRESS', 'SUSPENDED')
      ORDER BY "code" LIMIT 1;
    IF busy_code IS NOT NULL THEN
      RAISE EXCEPTION 'court_occupied: court of match % is occupied by %', NEW."code", busy_code;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "matches_court_single_occupancy"
  BEFORE INSERT OR UPDATE OF "courtId", "lifecycleStatus" ON "matches"
  FOR EACH ROW EXECUTE FUNCTION "guard_court_single_occupancy"();

-- RV-02：离场待续的比赛只能是暂停中。此前离场后作废计分（S-7）会让比赛回到抛币前、仍然没有场地，
-- 之后既转不了场（只接受暂停中）也排不了场地（已开始比赛的场地冻结），却能直接重新开打。
ALTER TABLE "matches" ADD CONSTRAINT "matches_awaiting_court_only_suspended"
  CHECK ("awaitingCourtSince" IS NULL OR "lifecycleStatus" = 'SUSPENDED');

-- 复判 RV-02 附带的小缺口：离场声明下把场地改为空时，必须同时记下离场待续。
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
            OR (NEW."courtId" IS NULL AND NEW."awaitingCourtSince" IS NOT NULL
                AND current_setting('badminton.court_release', true) = 'on')) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'schedule of a started match % cannot change', OLD."code";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

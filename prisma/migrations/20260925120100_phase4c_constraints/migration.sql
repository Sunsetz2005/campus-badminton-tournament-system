-- ---------------------------------------------------------------------------
-- 阶段 4-C 的数据库级不变量：赛程设置、比赛日、草稿赛程、发布版本、计划时间、
-- 已开始比赛不得被移动、逾期代交、团体对抗每人兼项上限。
-- 休息间隔按 2026-09-25 用户决定不在系统内检查（由线下裁判控场），这里也不建模。
-- ---------------------------------------------------------------------------

-- 团体对抗每人兼项上限：只属于团体项目，取值 1—9；为空表示不设上限。
ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_team_max_rubbers_check" CHECK (
    ("teamMaxRubbersMale" IS NULL OR "teamMaxRubbersMale" BETWEEN 1 AND 9)
    AND ("teamMaxRubbersFemale" IS NULL OR "teamMaxRubbersFemale" BETWEEN 1 AND 9)
    AND ("entryType" = 'TEAM' OR ("teamMaxRubbersMale" IS NULL AND "teamMaxRubbersFemale" IS NULL))
  );

-- 计划结束时间只能跟在计划开始之后；预计时间的标记必须有计划时间。
-- 既有比赛只有 scheduledAt，结束时间留空（排程按赛事设置的预计时长推算）。
ALTER TABLE "matches"
  ADD CONSTRAINT "matches_scheduled_end_check" CHECK (
    "scheduledEndAt" IS NULL OR ("scheduledAt" IS NOT NULL AND "scheduledEndAt" > "scheduledAt")
  ),
  ADD CONSTRAINT "matches_schedule_estimated_check" CHECK (NOT "scheduleEstimated" OR "scheduledAt" IS NOT NULL);

-- 比赛的场地必须属于同一赛事。
CREATE FUNCTION "validate_match_court"() RETURNS trigger AS $$
DECLARE
  match_tournament uuid;
  court_tournament uuid;
BEGIN
  IF NEW."courtId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT c."tournamentId" INTO match_tournament
  FROM "stages" AS s JOIN "competitions" AS c ON c."id" = s."competitionId"
  WHERE s."id" = NEW."stageId";
  SELECT "tournamentId" INTO court_tournament FROM "courts" WHERE "id" = NEW."courtId";
  IF court_tournament IS DISTINCT FROM match_tournament THEN
    RAISE EXCEPTION 'match court must belong to the same tournament';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "matches_court_scope"
  BEFORE INSERT OR UPDATE OF "courtId", "stageId" ON "matches"
  FOR EACH ROW EXECUTE FUNCTION "validate_match_court"();

-- 已经开始（有计分版本或离开待开赛状态）的比赛，计划时间与场地不得再被后台改动。
CREATE FUNCTION "protect_started_match_schedule"() RETURNS trigger AS $$
BEGIN
  IF (OLD."version" > 0 OR OLD."lifecycleStatus" NOT IN ('SCHEDULED', 'READY'))
     AND (NEW."scheduledAt" IS DISTINCT FROM OLD."scheduledAt"
          OR NEW."scheduledEndAt" IS DISTINCT FROM OLD."scheduledEndAt"
          OR NEW."courtId" IS DISTINCT FROM OLD."courtId") THEN
    RAISE EXCEPTION 'schedule of a started match % cannot change', OLD."code";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "matches_started_schedule_frozen"
  BEFORE UPDATE OF "scheduledAt", "scheduledEndAt", "courtId" ON "matches"
  FOR EACH ROW EXECUTE FUNCTION "protect_started_match_schedule"();

-- 赛程设置取值范围。
ALTER TABLE "schedule_configs"
  ADD CONSTRAINT "schedule_configs_range_check" CHECK (
    "matchMinutes" BETWEEN 5 AND 300
    AND "rubberMinutes" BETWEEN 5 AND 300
    AND "changeoverMinutes" BETWEEN 0 AND 60
    AND "knockoutTieCourts" BETWEEN 1 AND 9
    AND "lineupDeadlineMinutes" BETWEEN 0 AND 1440
  );

-- 比赛日开放时段：当天第几分钟，开始早于结束。
ALTER TABLE "schedule_days"
  ADD CONSTRAINT "schedule_days_window_check" CHECK (
    "startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute"
  );

-- 草稿赛程：场地与开始时间成对出现（都空表示草稿里撤下时间）；时长 5—300 分钟；预计标记必须有时间。
ALTER TABLE "schedule_slots"
  ADD CONSTRAINT "schedule_slots_pair_check" CHECK (("courtId" IS NULL) = ("startsAt" IS NULL)),
  ADD CONSTRAINT "schedule_slots_duration_check" CHECK ("durationMinutes" BETWEEN 5 AND 300),
  ADD CONSTRAINT "schedule_slots_estimated_check" CHECK (NOT "estimated" OR "startsAt" IS NOT NULL);

-- 草稿行的比赛与场地都必须属于同一赛事。
CREATE FUNCTION "validate_schedule_slot"() RETURNS trigger AS $$
DECLARE
  match_tournament uuid;
  court_tournament uuid;
BEGIN
  SELECT c."tournamentId" INTO match_tournament
  FROM "matches" AS m
    JOIN "stages" AS s ON s."id" = m."stageId"
    JOIN "competitions" AS c ON c."id" = s."competitionId"
  WHERE m."id" = NEW."matchId";
  IF match_tournament IS DISTINCT FROM NEW."tournamentId" THEN
    RAISE EXCEPTION 'schedule slot match must belong to the same tournament';
  END IF;
  IF NEW."courtId" IS NOT NULL THEN
    SELECT "tournamentId" INTO court_tournament FROM "courts" WHERE "id" = NEW."courtId";
    IF court_tournament IS DISTINCT FROM NEW."tournamentId" THEN
      RAISE EXCEPTION 'schedule slot court must belong to the same tournament';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "schedule_slots_scope"
  BEFORE INSERT OR UPDATE ON "schedule_slots"
  FOR EACH ROW EXECUTE FUNCTION "validate_schedule_slot"();

ALTER TABLE "schedule_publications"
  ADD CONSTRAINT "schedule_publications_version_check" CHECK ("version" >= 1 AND "matchCount" >= 0),
  ADD CONSTRAINT "schedule_publications_json_check" CHECK (
    jsonb_typeof("snapshot") = 'array' AND jsonb_typeof("changes") = 'object' AND jsonb_typeof("warnings") = 'array'
  );

-- 逾期提交只能是管理员代交。
ALTER TABLE "fixture_lineups"
  ADD CONSTRAINT "fixture_lineups_late_check" CHECK (NOT "submittedLate" OR "source" = 'ADMIN');

-- 团体对抗每人兼项上限：同一队员在同一场对抗（同一对阵）里出场的小场数不超过本项目按性别的上限。提交时校验。
CREATE FUNCTION "validate_match_player_tie_limit"() RETURNS trigger AS $$
DECLARE
  target_fixture uuid;
  player_gender "Gender";
  limit_male integer;
  limit_female integer;
  appearances integer;
  allowed integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  SELECT m."fixtureId", c."teamMaxRubbersMale", c."teamMaxRubbersFemale"
  INTO target_fixture, limit_male, limit_female
  FROM "matches" AS m
    JOIN "stages" AS s ON s."id" = m."stageId"
    JOIN "competitions" AS c ON c."id" = s."competitionId"
  WHERE m."id" = NEW."matchId";
  IF target_fixture IS NULL OR (limit_male IS NULL AND limit_female IS NULL) THEN
    RETURN NULL;
  END IF;
  SELECT "gender" INTO player_gender FROM "participants" WHERE "id" = NEW."participantId";
  allowed := CASE player_gender WHEN 'MALE' THEN limit_male WHEN 'FEMALE' THEN limit_female ELSE NULL END;
  IF allowed IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO appearances
  FROM "match_players" AS mp JOIN "matches" AS m ON m."id" = mp."matchId"
  WHERE m."fixtureId" = target_fixture AND mp."participantId" = NEW."participantId";
  IF appearances > allowed THEN
    RAISE EXCEPTION 'player % appears in % rubbers of one tie, limit is %', NEW."participantId", appearances, allowed;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "match_players_tie_limit"
  AFTER INSERT OR UPDATE ON "match_players"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_match_player_tie_limit"();

-- ---------------------------------------------------------------------------
-- 阶段 4-B 的数据库级不变量：团体项目配置、团体名单、队伍与负责人范围、抽签、对阵来源无环、团体小场。
-- 与上一迁移分开：PostgreSQL 不允许在添加枚举值的同一事务里使用新值（'TEAM'、'TEAM_MANAGER'）。
-- ---------------------------------------------------------------------------

-- 团体项目的配置必须自洽；非团体项目不得带团体配置。
UPDATE "competitions" SET "teamRubbers" = ARRAY[]::"CompetitionKind"[] WHERE "teamRubbers" IS NULL;
ALTER TABLE "competitions" ALTER COLUMN "teamRubbers" SET NOT NULL;

ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_team_kind_check" CHECK (("kind" = 'TEAM') = ("entryType" = 'TEAM')),
  ADD CONSTRAINT "competitions_team_format_check" CHECK (
    CASE WHEN "kind" = 'TEAM' THEN
      cardinality("teamRubbers") BETWEEN 1 AND 9
      AND NOT ('TEAM' = ANY ("teamRubbers"))
      AND NOT ('CUSTOM' = ANY ("teamRubbers"))
      AND "teamRosterMin" IS NOT NULL AND "teamRosterMax" IS NOT NULL
      AND "teamMinMale" IS NOT NULL AND "teamMinFemale" IS NOT NULL
      AND "teamRosterMin" >= 1 AND "teamRosterMax" <= 30 AND "teamRosterMin" <= "teamRosterMax"
      AND "teamMinMale" >= 0 AND "teamMinFemale" >= 0
      AND "teamMinMale" + "teamMinFemale" <= "teamRosterMax"
    ELSE
      cardinality("teamRubbers") = 0
      AND "teamRosterMin" IS NULL AND "teamRosterMax" IS NULL
      AND "teamMinMale" IS NULL AND "teamMinFemale" IS NULL
    END
  );

-- 成员位上限从 2 放宽到 30（团体名单）；单打/双打的精确人数仍由下面的触发器保证。
ALTER TABLE "entry_members" DROP CONSTRAINT "entry_members_slot_check";
ALTER TABLE "entry_members" ADD CONSTRAINT "entry_members_slot_check" CHECK ("slot" BETWEEN 1 AND 30);
ALTER TABLE "registration_members" DROP CONSTRAINT "registration_members_slot_check";
ALTER TABLE "registration_members" ADD CONSTRAINT "registration_members_slot_check" CHECK ("slot" BETWEEN 1 AND 30);

-- 报名单位人数：单打恰好 1 人、双打恰好 2 人（成员位不超过人数）；
-- 团体在项目设置的人数范围内，每名队员都有学号与性别，且男女人数达到下限。提交时校验。
CREATE OR REPLACE FUNCTION "validate_entry_member_count"() RETURNS trigger AS $$
DECLARE
  target_entry_id uuid;
  entry_kind "EntryType";
  roster_min integer;
  roster_max integer;
  min_male integer;
  min_female integer;
  expected_count integer;
  actual_count integer;
  max_slot integer;
  male_count integer;
  female_count integer;
  incomplete_count integer;
BEGIN
  IF TG_TABLE_NAME = 'entries' THEN
    target_entry_id := NEW."id";
  ELSE
    target_entry_id := COALESCE(NEW."entryId", OLD."entryId");
  END IF;

  SELECT e."entryType", c."teamRosterMin", c."teamRosterMax", c."teamMinMale", c."teamMinFemale"
  INTO entry_kind, roster_min, roster_max, min_male, min_female
  FROM "entries" AS e
    JOIN "competitions" AS c ON c."id" = e."competitionId"
  WHERE e."id" = target_entry_id;

  IF entry_kind IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*),
         coalesce(max(em."slot"), 0),
         count(*) FILTER (WHERE p."gender" = 'MALE'),
         count(*) FILTER (WHERE p."gender" = 'FEMALE'),
         count(*) FILTER (WHERE p."gender" IS NULL OR p."studentId" IS NULL)
  INTO actual_count, max_slot, male_count, female_count, incomplete_count
  FROM "entry_members" AS em
    JOIN "participants" AS p ON p."id" = em."participantId"
  WHERE em."entryId" = target_entry_id;

  IF entry_kind = 'TEAM' THEN
    IF actual_count < roster_min OR actual_count > roster_max THEN
      RAISE EXCEPTION 'team entry % requires % to % member(s), found %', target_entry_id, roster_min, roster_max, actual_count;
    END IF;
    IF incomplete_count > 0 THEN
      RAISE EXCEPTION 'team entry % has % member(s) without student id or gender', target_entry_id, incomplete_count;
    END IF;
    IF male_count < min_male OR female_count < min_female THEN
      RAISE EXCEPTION 'team entry % requires at least % male and % female member(s)', target_entry_id, min_male, min_female;
    END IF;
  ELSE
    expected_count := CASE entry_kind WHEN 'SINGLES' THEN 1 ELSE 2 END;
    IF actual_count <> expected_count OR max_slot > expected_count THEN
      RAISE EXCEPTION 'entry % requires % distinct member(s), found %', target_entry_id, expected_count, actual_count;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validate_registration_member_count"() RETURNS trigger AS $$
DECLARE
  target_id uuid;
  entry_kind "EntryType";
  roster_min integer;
  roster_max integer;
  min_male integer;
  min_female integer;
  expected_count integer;
  actual_count integer;
  max_slot integer;
  male_count integer;
  female_count integer;
  incomplete_count integer;
BEGIN
  IF TG_TABLE_NAME = 'registrations' THEN
    target_id := NEW."id";
  ELSE
    target_id := COALESCE(NEW."registrationId", OLD."registrationId");
  END IF;

  SELECT c."entryType", c."teamRosterMin", c."teamRosterMax", c."teamMinMale", c."teamMinFemale"
  INTO entry_kind, roster_min, roster_max, min_male, min_female
  FROM "registrations" AS r
    JOIN "competitions" AS c ON c."id" = r."competitionId"
  WHERE r."id" = target_id;

  IF entry_kind IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*),
         coalesce(max("slot"), 0),
         count(*) FILTER (WHERE "gender" = 'MALE'),
         count(*) FILTER (WHERE "gender" = 'FEMALE'),
         count(*) FILTER (WHERE "gender" IS NULL OR "studentId" IS NULL)
  INTO actual_count, max_slot, male_count, female_count, incomplete_count
  FROM "registration_members"
  WHERE "registrationId" = target_id;

  IF entry_kind = 'TEAM' THEN
    IF actual_count < roster_min OR actual_count > roster_max THEN
      RAISE EXCEPTION 'team registration % requires % to % member(s), found %', target_id, roster_min, roster_max, actual_count;
    END IF;
    IF incomplete_count > 0 THEN
      RAISE EXCEPTION 'team registration % has % member(s) without student id or gender', target_id, incomplete_count;
    END IF;
    IF male_count < min_male OR female_count < min_female THEN
      RAISE EXCEPTION 'team registration % requires at least % male and % female member(s)', target_id, min_male, min_female;
    END IF;
  ELSE
    expected_count := CASE entry_kind WHEN 'SINGLES' THEN 1 ELSE 2 END;
    IF actual_count <> expected_count OR max_slot > expected_count THEN
      RAISE EXCEPTION 'registration % requires % member(s), found %', target_id, expected_count, actual_count;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 报名所属赛事必须与项目一致；团体项目的报名必须挂在本赛事的一支队伍上，个人项目不得挂队伍。
CREATE OR REPLACE FUNCTION "validate_registration_scope"() RETURNS trigger AS $$
DECLARE
  competition_tournament uuid;
  competition_type "EntryType";
  team_tournament uuid;
BEGIN
  SELECT "tournamentId", "entryType" INTO competition_tournament, competition_type
  FROM "competitions" WHERE "id" = NEW."competitionId";
  IF competition_tournament IS DISTINCT FROM NEW."tournamentId" THEN
    RAISE EXCEPTION 'registration tournament must match competition tournament';
  END IF;
  IF (competition_type = 'TEAM') <> (NEW."teamId" IS NOT NULL) THEN
    RAISE EXCEPTION 'team registrations must reference a team and individual registrations must not';
  END IF;
  IF NEW."teamId" IS NOT NULL THEN
    SELECT "tournamentId" INTO team_tournament FROM "teams" WHERE "id" = NEW."teamId";
    IF team_tournament IS DISTINCT FROM NEW."tournamentId" THEN
      RAISE EXCEPTION 'registration team belongs to a different tournament';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 同一队伍在同一团体项目里只能有一份进行中/已通过的报名。
CREATE UNIQUE INDEX "registrations_active_team_key"
  ON "registrations" ("competitionId", "teamId")
  WHERE "teamId" IS NOT NULL AND "status" IN ('PENDING', 'APPROVED');

-- 报名单位类型必须与项目一致；团体报名单位必须挂在同一赛事的队伍上。
ALTER TABLE "entries"
  ADD CONSTRAINT "entries_team_check" CHECK (("entryType" = 'TEAM') = ("teamId" IS NOT NULL));

CREATE FUNCTION "validate_entry_scope"() RETURNS trigger AS $$
DECLARE
  competition_type "EntryType";
  competition_tournament uuid;
  team_tournament uuid;
BEGIN
  SELECT "entryType", "tournamentId" INTO competition_type, competition_tournament
  FROM "competitions" WHERE "id" = NEW."competitionId";
  IF competition_type IS DISTINCT FROM NEW."entryType" THEN
    RAISE EXCEPTION 'entry type must match competition entry type';
  END IF;
  IF NEW."teamId" IS NOT NULL THEN
    SELECT "tournamentId" INTO team_tournament FROM "teams" WHERE "id" = NEW."teamId";
    IF team_tournament IS DISTINCT FROM competition_tournament THEN
      RAISE EXCEPTION 'entry team belongs to a different tournament';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "entries_scope"
  BEFORE INSERT OR UPDATE ON "entries"
  FOR EACH ROW EXECUTE FUNCTION "validate_entry_scope"();

-- 队伍与负责人。
ALTER TABLE "teams"
  ADD CONSTRAINT "teams_name_check" CHECK (length(btrim("name")) > 0 AND length("name") <= 60),
  ADD CONSTRAINT "teams_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9-]{0,15}$');

CREATE FUNCTION "validate_team_manager_scope"() RETURNS trigger AS $$
DECLARE
  team_tournament uuid;
BEGIN
  SELECT "tournamentId" INTO team_tournament FROM "teams" WHERE "id" = NEW."teamId";
  IF team_tournament IS DISTINCT FROM NEW."tournamentId" THEN
    RAISE EXCEPTION 'team_managers.tournamentId must equal teams.tournamentId';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "team_managers_scope"
  BEFORE INSERT OR UPDATE ON "team_managers"
  FOR EACH ROW EXECUTE FUNCTION "validate_team_manager_scope"();

-- 抽签：版本为正；每个项目最多一个草稿、一个已发布版本；发布与撤销必须留下时间与原因。
ALTER TABLE "draws"
  ADD CONSTRAINT "draws_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "draws_conflict_count_check" CHECK ("conflictCount" >= 0),
  ADD CONSTRAINT "draws_random_seed_check" CHECK (length("randomSeed") >= 16),
  ADD CONSTRAINT "draws_adjustments_array_check" CHECK (jsonb_typeof("adjustments") = 'array'),
  ADD CONSTRAINT "draws_published_check" CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL),
  ADD CONSTRAINT "draws_revoked_check" CHECK (
    "status" <> 'REVOKED'
    OR ("publishedAt" IS NOT NULL AND "revokedAt" IS NOT NULL AND length(btrim(coalesce("revokeReason", ''))) > 0)
  );

CREATE UNIQUE INDEX "draws_one_draft_per_competition" ON "draws" ("competitionId") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "draws_one_published_per_competition" ON "draws" ("competitionId") WHERE "status" = 'PUBLISHED';

-- 抽签生成的阶段必须属于同一项目的抽签。
CREATE FUNCTION "validate_stage_draw_scope"() RETURNS trigger AS $$
DECLARE
  draw_competition uuid;
BEGIN
  IF NEW."drawId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "competitionId" INTO draw_competition FROM "draws" WHERE "id" = NEW."drawId";
  IF draw_competition IS DISTINCT FROM NEW."competitionId" THEN
    RAISE EXCEPTION 'stage draw belongs to a different competition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stages_draw_scope"
  BEFORE INSERT OR UPDATE ON "stages"
  FOR EACH ROW EXECUTE FUNCTION "validate_stage_draw_scope"();

-- 对阵两侧来源自洽：确定报名单位 / 某组第几名 / 某场胜者或负者，三选一。
-- 未决来源日后回填的报名单位放在同一 EntryId 列，不改变来源类型。
ALTER TABLE "fixtures"
  ADD CONSTRAINT "fixtures_round_check" CHECK ("round" >= 1 AND "sequence" >= 1),
  ADD CONSTRAINT "fixtures_side_a_source_check" CHECK (
    ("sideASource" = 'ENTRY' AND "sideAEntryId" IS NOT NULL AND "sideAGroupId" IS NULL AND "sideARank" IS NULL AND "sideAFixtureId" IS NULL)
    OR ("sideASource" = 'GROUP_RANK' AND "sideAGroupId" IS NOT NULL AND "sideARank" >= 1 AND "sideAFixtureId" IS NULL)
    OR ("sideASource" IN ('FIXTURE_WINNER', 'FIXTURE_LOSER') AND "sideAFixtureId" IS NOT NULL AND "sideAGroupId" IS NULL AND "sideARank" IS NULL)
  ),
  ADD CONSTRAINT "fixtures_side_b_source_check" CHECK (
    ("sideBSource" = 'ENTRY' AND "sideBEntryId" IS NOT NULL AND "sideBGroupId" IS NULL AND "sideBRank" IS NULL AND "sideBFixtureId" IS NULL)
    OR ("sideBSource" = 'GROUP_RANK' AND "sideBGroupId" IS NOT NULL AND "sideBRank" >= 1 AND "sideBFixtureId" IS NULL)
    OR ("sideBSource" IN ('FIXTURE_WINNER', 'FIXTURE_LOSER') AND "sideBFixtureId" IS NOT NULL AND "sideBGroupId" IS NULL AND "sideBRank" IS NULL)
  ),
  ADD CONSTRAINT "fixtures_distinct_entries_check" CHECK (
    "sideAEntryId" IS NULL OR "sideBEntryId" IS NULL OR "sideAEntryId" <> "sideBEntryId"
  ),
  ADD CONSTRAINT "fixtures_group_kind_check" CHECK (("kind" = 'GROUP') = ("groupId" IS NOT NULL)),
  ADD CONSTRAINT "fixtures_group_sources_check" CHECK ("kind" <> 'GROUP' OR ("sideASource" = 'ENTRY' AND "sideBSource" = 'ENTRY'));

-- 对阵的范围与无环：所属抽签/阶段/小组同一项目；报名单位来源属于本项目；
-- 「某组第几名」只能引用同一抽签更早阶段的小组；「胜者/负者」只能引用同一抽签更早（阶段, 轮次）的对阵。
CREATE FUNCTION "validate_fixture_scope"() RETURNS trigger AS $$
DECLARE
  draw_competition uuid;
  stage_competition uuid;
  stage_draw uuid;
  this_stage_order integer;
  group_stage uuid;
  side text;
  side_entry uuid;
  side_group uuid;
  side_fixture uuid;
  source_competition uuid;
  source_draw uuid;
  source_stage_order integer;
  source_round integer;
BEGIN
  SELECT "competitionId" INTO draw_competition FROM "draws" WHERE "id" = NEW."drawId";
  IF draw_competition IS DISTINCT FROM NEW."competitionId" THEN
    RAISE EXCEPTION 'fixture draw belongs to a different competition';
  END IF;
  SELECT "competitionId", "drawId", "order" INTO stage_competition, stage_draw, this_stage_order
  FROM "stages" WHERE "id" = NEW."stageId";
  IF stage_competition IS DISTINCT FROM NEW."competitionId" OR stage_draw IS DISTINCT FROM NEW."drawId" THEN
    RAISE EXCEPTION 'fixture stage belongs to a different draw';
  END IF;
  IF NEW."groupId" IS NOT NULL THEN
    SELECT "stageId" INTO group_stage FROM "competition_groups" WHERE "id" = NEW."groupId";
    IF group_stage IS DISTINCT FROM NEW."stageId" THEN
      RAISE EXCEPTION 'fixture group belongs to a different stage';
    END IF;
  END IF;

  FOREACH side IN ARRAY ARRAY['A', 'B'] LOOP
    IF side = 'A' THEN
      side_entry := NEW."sideAEntryId";
      side_group := NEW."sideAGroupId";
      side_fixture := NEW."sideAFixtureId";
    ELSE
      side_entry := NEW."sideBEntryId";
      side_group := NEW."sideBGroupId";
      side_fixture := NEW."sideBFixtureId";
    END IF;

    IF side_entry IS NOT NULL THEN
      SELECT "competitionId" INTO source_competition FROM "entries" WHERE "id" = side_entry;
      IF source_competition IS DISTINCT FROM NEW."competitionId" THEN
        RAISE EXCEPTION 'fixture side % entry belongs to a different competition', side;
      END IF;
    END IF;

    IF side_group IS NOT NULL THEN
      source_draw := NULL;
      source_stage_order := NULL;
      SELECT s."drawId", s."order" INTO source_draw, source_stage_order
      FROM "competition_groups" AS g JOIN "stages" AS s ON s."id" = g."stageId"
      WHERE g."id" = side_group;
      IF source_draw IS DISTINCT FROM NEW."drawId" OR source_stage_order IS NULL OR source_stage_order >= this_stage_order THEN
        RAISE EXCEPTION 'fixture side % group source must be an earlier stage of the same draw', side;
      END IF;
    END IF;

    IF side_fixture IS NOT NULL THEN
      source_draw := NULL;
      source_stage_order := NULL;
      source_round := NULL;
      SELECT f."drawId", s."order", f."round" INTO source_draw, source_stage_order, source_round
      FROM "fixtures" AS f JOIN "stages" AS s ON s."id" = f."stageId"
      WHERE f."id" = side_fixture;
      IF source_draw IS DISTINCT FROM NEW."drawId"
         OR source_stage_order IS NULL
         OR (source_stage_order, source_round) >= (this_stage_order, NEW."round") THEN
        RAISE EXCEPTION 'fixture side % source must be an earlier round of the same draw (acyclic)', side;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "fixtures_scope"
  BEFORE INSERT OR UPDATE ON "fixtures"
  FOR EACH ROW EXECUTE FUNCTION "validate_fixture_scope"();

-- 团体小场：小场类型与顺序成对出现，只能是五个单项；个人对阵恰好一场比赛。
ALTER TABLE "matches"
  ADD CONSTRAINT "matches_rubber_pair_check" CHECK (("rubberKind" IS NULL) = ("rubberOrder" IS NULL)),
  ADD CONSTRAINT "matches_rubber_kind_check" CHECK ("rubberKind" IS NULL OR "rubberKind" IN ('MS', 'WS', 'MD', 'WD', 'XD')),
  ADD CONSTRAINT "matches_rubber_order_check" CHECK ("rubberOrder" IS NULL OR "rubberOrder" BETWEEN 1 AND 9),
  ADD CONSTRAINT "matches_rubber_requires_fixture_check" CHECK ("rubberOrder" IS NULL OR "fixtureId" IS NOT NULL);

CREATE UNIQUE INDEX "matches_one_individual_match_per_fixture"
  ON "matches" ("fixtureId")
  WHERE "fixtureId" IS NOT NULL AND "rubberOrder" IS NULL;

-- 比赛与对阵一致：同一阶段；团体项目的比赛必须是小场，个人项目不得是小场；
-- 个人对阵的比赛两侧必须与对阵已确定的两侧一致（未决一侧同为空）。
CREATE FUNCTION "validate_match_fixture"() RETURNS trigger AS $$
DECLARE
  fixture_stage uuid;
  fixture_side_a uuid;
  fixture_side_b uuid;
  competition_type "EntryType";
BEGIN
  IF NEW."fixtureId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT f."stageId", f."sideAEntryId", f."sideBEntryId", c."entryType"
  INTO fixture_stage, fixture_side_a, fixture_side_b, competition_type
  FROM "fixtures" AS f JOIN "competitions" AS c ON c."id" = f."competitionId"
  WHERE f."id" = NEW."fixtureId";
  IF fixture_stage IS DISTINCT FROM NEW."stageId" THEN
    RAISE EXCEPTION 'match stage must equal fixture stage';
  END IF;
  IF (competition_type = 'TEAM') <> (NEW."rubberKind" IS NOT NULL) THEN
    RAISE EXCEPTION 'team fixtures are played as rubbers; individual fixtures must not have rubbers';
  END IF;
  IF competition_type <> 'TEAM'
     AND (NEW."sideAEntryId" IS DISTINCT FROM fixture_side_a OR NEW."sideBEntryId" IS DISTINCT FROM fixture_side_b) THEN
    RAISE EXCEPTION 'match sides must equal the fixture sides';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "matches_fixture_consistency"
  BEFORE INSERT OR UPDATE ON "matches"
  FOR EACH ROW EXECUTE FUNCTION "validate_match_fixture"();

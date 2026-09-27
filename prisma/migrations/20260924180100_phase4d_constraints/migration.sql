-- ---------------------------------------------------------------------------
-- 阶段 4-D 的数据库级不变量：团体名单报项、出场名单（盲交与锁定）、对抗胜负、小组名次确认、未进行的小场。
-- 与上一迁移分开：PostgreSQL 不允许在添加枚举类型的同一事务里使用新值（'A'/'B'、'TEAM_MANAGER'）。
-- ---------------------------------------------------------------------------

-- 报项列与 teamRubbers 一样不允许 NULL。
UPDATE "registration_members" SET "rubberKinds" = ARRAY[]::"CompetitionKind"[] WHERE "rubberKinds" IS NULL;
ALTER TABLE "registration_members" ALTER COLUMN "rubberKinds" SET NOT NULL;
UPDATE "entry_members" SET "rubberKinds" = ARRAY[]::"CompetitionKind"[] WHERE "rubberKinds" IS NULL;
ALTER TABLE "entry_members" ALTER COLUMN "rubberKinds" SET NOT NULL;

-- 既有团体名单（4-B 时没有报项）：按性别默认报本项目全部可报的小场。
-- 这是迁移默认值，不代表负责人本人的选择；负责人或管理员可以在报名期内修改待审核名单。
UPDATE "registration_members" AS rm
SET "rubberKinds" = ARRAY(
  SELECT DISTINCT kind FROM unnest(c."teamRubbers") AS kind
  WHERE (rm."gender" = 'MALE' AND kind IN ('MS', 'MD', 'XD'))
     OR (rm."gender" = 'FEMALE' AND kind IN ('WS', 'WD', 'XD'))
  ORDER BY kind
)
FROM "registrations" AS r
  JOIN "competitions" AS c ON c."id" = r."competitionId"
WHERE r."id" = rm."registrationId"
  AND c."entryType" = 'TEAM'
  AND rm."gender" IS NOT NULL
  AND cardinality(rm."rubberKinds") = 0;

UPDATE "entry_members" AS em
SET "rubberKinds" = ARRAY(
  SELECT DISTINCT kind FROM unnest(c."teamRubbers") AS kind
  WHERE (p."gender" = 'MALE' AND kind IN ('MS', 'MD', 'XD'))
     OR (p."gender" = 'FEMALE' AND kind IN ('WS', 'WD', 'XD'))
  ORDER BY kind
)
FROM "entries" AS e
  JOIN "competitions" AS c ON c."id" = e."competitionId",
  "participants" AS p
WHERE e."id" = em."entryId"
  AND p."id" = em."participantId"
  AND c."entryType" = 'TEAM'
  AND p."gender" IS NOT NULL
  AND cardinality(em."rubberKinds") = 0;

-- 报项只能是五个单项；男队员不能报女单/女双，女队员不能报男单/男双；没有性别就不能报项。
ALTER TABLE "registration_members"
  ADD CONSTRAINT "registration_members_rubber_kinds_check" CHECK (
    "rubberKinds" <@ ARRAY['MS', 'WS', 'MD', 'WD', 'XD']::"CompetitionKind"[]
    AND NOT ("gender" = 'FEMALE' AND "rubberKinds" && ARRAY['MS', 'MD']::"CompetitionKind"[])
    AND NOT ("gender" = 'MALE' AND "rubberKinds" && ARRAY['WS', 'WD']::"CompetitionKind"[])
    AND ("gender" IS NOT NULL OR cardinality("rubberKinds") = 0)
  );
ALTER TABLE "entry_members"
  ADD CONSTRAINT "entry_members_rubber_kinds_check" CHECK (
    "rubberKinds" <@ ARRAY['MS', 'WS', 'MD', 'WD', 'XD']::"CompetitionKind"[]
  );

-- 报名单位人数（在 4-B 基础上增加报项）：
-- 团体名单每名队员至少报 1 项、报项与性别相符，且本项目每种小场都有足够的报项队员（单打 1 人、双打 2 人、混双 1 男 1 女）；
-- 个人项目的成员不得带报项。提交时校验。
CREATE OR REPLACE FUNCTION "validate_entry_member_count"() RETURNS trigger AS $$
DECLARE
  target_entry_id uuid;
  entry_kind "EntryType";
  rubbers "CompetitionKind"[];
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
  unentered_count integer;
  mismatched_count integer;
  kinds_count integer;
  kind "CompetitionKind";
  eligible_male integer;
  eligible_female integer;
BEGIN
  IF TG_TABLE_NAME = 'entries' THEN
    target_entry_id := NEW."id";
  ELSE
    target_entry_id := COALESCE(NEW."entryId", OLD."entryId");
  END IF;

  SELECT e."entryType", c."teamRubbers", c."teamRosterMin", c."teamRosterMax", c."teamMinMale", c."teamMinFemale"
  INTO entry_kind, rubbers, roster_min, roster_max, min_male, min_female
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
         count(*) FILTER (WHERE p."gender" IS NULL OR p."studentId" IS NULL),
         count(*) FILTER (WHERE cardinality(em."rubberKinds") = 0),
         count(*) FILTER (
           WHERE (p."gender" = 'FEMALE' AND em."rubberKinds" && ARRAY['MS', 'MD']::"CompetitionKind"[])
              OR (p."gender" = 'MALE' AND em."rubberKinds" && ARRAY['WS', 'WD']::"CompetitionKind"[])
              OR NOT (em."rubberKinds" <@ rubbers)
         ),
         count(*) FILTER (WHERE cardinality(em."rubberKinds") > 0)
  INTO actual_count, max_slot, male_count, female_count, incomplete_count, unentered_count, mismatched_count, kinds_count
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
    IF unentered_count > 0 THEN
      RAISE EXCEPTION 'team entry % has % member(s) without any rubber event', target_entry_id, unentered_count;
    END IF;
    IF mismatched_count > 0 THEN
      RAISE EXCEPTION 'team entry % has % member(s) with events that do not match gender or competition', target_entry_id, mismatched_count;
    END IF;
    FOREACH kind IN ARRAY rubbers LOOP
      SELECT count(*) FILTER (WHERE p."gender" = 'MALE'),
             count(*) FILTER (WHERE p."gender" = 'FEMALE')
      INTO eligible_male, eligible_female
      FROM "entry_members" AS em
        JOIN "participants" AS p ON p."id" = em."participantId"
      WHERE em."entryId" = target_entry_id AND kind = ANY (em."rubberKinds");
      IF (kind = 'MS' AND eligible_male < 1)
         OR (kind = 'WS' AND eligible_female < 1)
         OR (kind = 'MD' AND eligible_male < 2)
         OR (kind = 'WD' AND eligible_female < 2)
         OR (kind = 'XD' AND (eligible_male < 1 OR eligible_female < 1)) THEN
        RAISE EXCEPTION 'team entry % does not have enough members entered for rubber %', target_entry_id, kind;
      END IF;
    END LOOP;
  ELSE
    expected_count := CASE entry_kind WHEN 'SINGLES' THEN 1 ELSE 2 END;
    IF actual_count <> expected_count OR max_slot > expected_count THEN
      RAISE EXCEPTION 'entry % requires % distinct member(s), found %', target_entry_id, expected_count, actual_count;
    END IF;
    IF kinds_count > 0 THEN
      RAISE EXCEPTION 'individual entry % members must not carry rubber events', target_entry_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validate_registration_member_count"() RETURNS trigger AS $$
DECLARE
  target_id uuid;
  entry_kind "EntryType";
  rubbers "CompetitionKind"[];
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
  unentered_count integer;
  foreign_count integer;
  kinds_count integer;
  kind "CompetitionKind";
  eligible_male integer;
  eligible_female integer;
BEGIN
  IF TG_TABLE_NAME = 'registrations' THEN
    target_id := NEW."id";
  ELSE
    target_id := COALESCE(NEW."registrationId", OLD."registrationId");
  END IF;

  SELECT c."entryType", c."teamRubbers", c."teamRosterMin", c."teamRosterMax", c."teamMinMale", c."teamMinFemale"
  INTO entry_kind, rubbers, roster_min, roster_max, min_male, min_female
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
         count(*) FILTER (WHERE "gender" IS NULL OR "studentId" IS NULL),
         count(*) FILTER (WHERE cardinality("rubberKinds") = 0),
         count(*) FILTER (WHERE NOT ("rubberKinds" <@ rubbers)),
         count(*) FILTER (WHERE cardinality("rubberKinds") > 0)
  INTO actual_count, max_slot, male_count, female_count, incomplete_count, unentered_count, foreign_count, kinds_count
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
    IF unentered_count > 0 THEN
      RAISE EXCEPTION 'team registration % has % member(s) without any rubber event', target_id, unentered_count;
    END IF;
    IF foreign_count > 0 THEN
      RAISE EXCEPTION 'team registration % has % member(s) entered for rubbers this competition does not play', target_id, foreign_count;
    END IF;
    FOREACH kind IN ARRAY rubbers LOOP
      SELECT count(*) FILTER (WHERE "gender" = 'MALE'),
             count(*) FILTER (WHERE "gender" = 'FEMALE')
      INTO eligible_male, eligible_female
      FROM "registration_members"
      WHERE "registrationId" = target_id AND kind = ANY ("rubberKinds");
      IF (kind = 'MS' AND eligible_male < 1)
         OR (kind = 'WS' AND eligible_female < 1)
         OR (kind = 'MD' AND eligible_male < 2)
         OR (kind = 'WD' AND eligible_female < 2)
         OR (kind = 'XD' AND (eligible_male < 1 OR eligible_female < 1)) THEN
        RAISE EXCEPTION 'team registration % does not have enough members entered for rubber %', target_id, kind;
      END IF;
    END LOOP;
  ELSE
    expected_count := CASE entry_kind WHEN 'SINGLES' THEN 1 ELSE 2 END;
    IF actual_count <> expected_count OR max_slot > expected_count THEN
      RAISE EXCEPTION 'registration % requires % member(s), found %', target_id, expected_count, actual_count;
    END IF;
    IF kinds_count > 0 THEN
      RAISE EXCEPTION 'individual registration % members must not carry rubber events', target_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 团体小场的两侧与对阵两侧一致（4-B 时团体小场两侧留空）：先回填既有小场，再收紧触发器。
UPDATE "matches" AS m
SET "sideAEntryId" = f."sideAEntryId", "sideBEntryId" = f."sideBEntryId"
FROM "fixtures" AS f
WHERE f."id" = m."fixtureId"
  AND m."rubberOrder" IS NOT NULL
  AND (m."sideAEntryId" IS DISTINCT FROM f."sideAEntryId" OR m."sideBEntryId" IS DISTINCT FROM f."sideBEntryId");

CREATE OR REPLACE FUNCTION "validate_match_fixture"() RETURNS trigger AS $$
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
  IF NEW."sideAEntryId" IS DISTINCT FROM fixture_side_a OR NEW."sideBEntryId" IS DISTINCT FROM fixture_side_b THEN
    RAISE EXCEPTION 'match sides must equal the fixture sides';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 未进行的小场：只能是团体小场，且从未开始（没有版本、没有进入计分）。
ALTER TABLE "matches"
  ADD CONSTRAINT "matches_not_played_check" CHECK (
    "notPlayedAt" IS NULL
    OR ("rubberOrder" IS NOT NULL AND "version" = 0 AND "lifecycleStatus" IN ('SCHEDULED', 'READY'))
  );

-- 对抗胜负只能是两侧之一；名单公开的前提是两侧都已确定。
ALTER TABLE "fixtures"
  ADD CONSTRAINT "fixtures_winner_side_check" CHECK (
    "winnerEntryId" IS NULL OR "winnerEntryId" = "sideAEntryId" OR "winnerEntryId" = "sideBEntryId"
  ),
  ADD CONSTRAINT "fixtures_decided_pair_check" CHECK (("winnerEntryId" IS NULL) = ("decidedAt" IS NULL)),
  ADD CONSTRAINT "fixtures_lineups_revealed_check" CHECK (
    "lineupsRevealedAt" IS NULL OR ("sideAEntryId" IS NOT NULL AND "sideBEntryId" IS NOT NULL)
  );

-- 小组名次确认：名次与确认时刻成对出现，名次是报名单位 ID 的有序数组。
ALTER TABLE "competition_groups"
  ADD CONSTRAINT "competition_groups_ranking_pair_check" CHECK (("ranking" IS NULL) = ("rankingConfirmedAt" IS NULL)),
  ADD CONSTRAINT "competition_groups_ranking_shape_check" CHECK ("ranking" IS NULL OR jsonb_typeof("ranking") = 'object');

-- 出场名单表头：只属于团体对抗，报名单位必须是对阵这一侧已确定的队伍。
ALTER TABLE "fixture_lineups" ADD CONSTRAINT "fixture_lineups_version_check" CHECK ("version" >= 1);

CREATE FUNCTION "validate_fixture_lineup"() RETURNS trigger AS $$
DECLARE
  side_entry uuid;
  competition_type "EntryType";
BEGIN
  SELECT CASE NEW."side" WHEN 'A' THEN f."sideAEntryId" ELSE f."sideBEntryId" END, c."entryType"
  INTO side_entry, competition_type
  FROM "fixtures" AS f JOIN "competitions" AS c ON c."id" = f."competitionId"
  WHERE f."id" = NEW."fixtureId";
  IF competition_type IS DISTINCT FROM 'TEAM' THEN
    RAISE EXCEPTION 'lineups are only submitted for team fixtures';
  END IF;
  IF side_entry IS NULL OR side_entry <> NEW."entryId" THEN
    RAISE EXCEPTION 'lineup entry must equal the fixture side entry';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "fixture_lineups_scope"
  BEFORE INSERT OR UPDATE ON "fixture_lineups"
  FOR EACH ROW EXECUTE FUNCTION "validate_fixture_lineup"();

-- 小场上场队员：只属于团体小场；报名单位等于该侧队伍；必须在队伍名单里、报了该项、性别相符；
-- 单打 1 个成员位、双打 2 个；小场一旦开始就不能再改。
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_slot_check" CHECK ("slot" IN (1, 2));

CREATE FUNCTION "validate_match_player"() RETURNS trigger AS $$
DECLARE
  rubber "CompetitionKind";
  side_entry uuid;
  match_version integer;
  player_gender "Gender";
  entered "CompetitionKind"[];
  found boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "version" INTO match_version FROM "matches" WHERE "id" = OLD."matchId";
    IF match_version IS NOT NULL AND match_version > 0 THEN
      RAISE EXCEPTION 'players of a started rubber cannot change';
    END IF;
    RETURN OLD;
  END IF;

  SELECT m."rubberKind", CASE NEW."side" WHEN 'A' THEN m."sideAEntryId" ELSE m."sideBEntryId" END, m."version"
  INTO rubber, side_entry, match_version
  FROM "matches" AS m WHERE m."id" = NEW."matchId";
  IF rubber IS NULL THEN
    RAISE EXCEPTION 'match players are only recorded for team rubbers';
  END IF;
  IF match_version > 0 THEN
    RAISE EXCEPTION 'players of a started rubber cannot change';
  END IF;
  IF side_entry IS NULL OR side_entry <> NEW."entryId" THEN
    RAISE EXCEPTION 'match player entry must equal the match side entry';
  END IF;
  IF NEW."slot" > (CASE WHEN rubber IN ('MS', 'WS') THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'rubber % has no slot %', rubber, NEW."slot";
  END IF;

  SELECT true, p."gender", em."rubberKinds"
  INTO found, player_gender, entered
  FROM "entry_members" AS em JOIN "participants" AS p ON p."id" = em."participantId"
  WHERE em."entryId" = NEW."entryId" AND em."participantId" = NEW."participantId";
  IF found IS NULL THEN
    RAISE EXCEPTION 'match player must be on the team roster';
  END IF;
  IF NOT (rubber = ANY (entered)) THEN
    RAISE EXCEPTION 'player did not enter rubber event %', rubber;
  END IF;
  IF (rubber IN ('MS', 'MD') AND player_gender IS DISTINCT FROM 'MALE')
     OR (rubber IN ('WS', 'WD') AND player_gender IS DISTINCT FROM 'FEMALE') THEN
    RAISE EXCEPTION 'player gender does not match rubber %', rubber;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "match_players_scope"
  BEFORE INSERT OR UPDATE OR DELETE ON "match_players"
  FOR EACH ROW EXECUTE FUNCTION "validate_match_player"();

-- 每个小场每一侧：要么还没有人（对方尚未提交），要么恰好是单打 1 人 / 双打 2 人，混双必须一男一女。提交时校验。
CREATE FUNCTION "validate_match_player_count"() RETURNS trigger AS $$
DECLARE
  target_match uuid;
  target_side "MatchSide";
  rubber "CompetitionKind";
  actual_count integer;
  male_count integer;
  expected_count integer;
BEGIN
  target_match := COALESCE(NEW."matchId", OLD."matchId");
  target_side := COALESCE(NEW."side", OLD."side");
  SELECT "rubberKind" INTO rubber FROM "matches" WHERE "id" = target_match;
  IF rubber IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE p."gender" = 'MALE')
  INTO actual_count, male_count
  FROM "match_players" AS mp JOIN "participants" AS p ON p."id" = mp."participantId"
  WHERE mp."matchId" = target_match AND mp."side" = target_side;
  expected_count := CASE WHEN rubber IN ('MS', 'WS') THEN 1 ELSE 2 END;
  IF actual_count <> 0 AND actual_count <> expected_count THEN
    RAISE EXCEPTION 'rubber % side % requires % player(s), found %', rubber, target_side, expected_count, actual_count;
  END IF;
  IF rubber = 'XD' AND actual_count = 2 AND male_count <> 1 THEN
    RAISE EXCEPTION 'mixed doubles side % requires one male and one female player', target_side;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "match_players_exact_count"
  AFTER INSERT OR UPDATE OR DELETE ON "match_players"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_match_player_count"();

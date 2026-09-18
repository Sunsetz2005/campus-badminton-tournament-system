-- 阶段 1 的数据库级不变量。复杂业务规则仍由后续纯规则引擎处理。
ALTER TABLE "entry_members"
  ADD CONSTRAINT "entry_members_slot_check" CHECK ("slot" IN (1, 2));

ALTER TABLE "games"
  ADD CONSTRAINT "games_nonnegative_scores_check" CHECK ("scoreA" >= 0 AND "scoreB" >= 0);

ALTER TABLE "matches"
  ADD CONSTRAINT "matches_nonnegative_version_check" CHECK ("version" >= 0),
  ADD CONSTRAINT "matches_distinct_sides_check" CHECK (
    "sideAEntryId" IS NULL OR "sideBEntryId" IS NULL OR "sideAEntryId" <> "sideBEntryId"
  );

ALTER TABLE "rule_profile_revisions"
  ADD CONSTRAINT "rule_profile_revisions_positive_revision_check" CHECK ("revision" > 0);

CREATE UNIQUE INDEX "scoring_sessions_one_active_per_match"
  ON "scoring_sessions" ("matchId")
  WHERE "status" = 'ACTIVE';

CREATE FUNCTION "validate_entry_member_count"() RETURNS trigger AS $$
DECLARE
  target_entry_id uuid;
  expected_count integer;
  actual_count integer;
BEGIN
  IF TG_TABLE_NAME = 'entries' THEN
    target_entry_id := NEW."id";
  ELSE
    target_entry_id := COALESCE(NEW."entryId", OLD."entryId");
  END IF;

  SELECT CASE "entryType"
    WHEN 'SINGLES' THEN 1
    WHEN 'DOUBLES' THEN 2
  END
  INTO expected_count
  FROM "entries"
  WHERE "id" = target_entry_id;

  IF expected_count IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO actual_count
  FROM "entry_members"
  WHERE "entryId" = target_entry_id;

  IF actual_count <> expected_count THEN
    RAISE EXCEPTION 'entry % requires % distinct member(s), found %', target_entry_id, expected_count, actual_count;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "entry_members_exact_count"
  AFTER INSERT OR UPDATE OR DELETE ON "entry_members"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_entry_member_count"();

CREATE CONSTRAINT TRIGGER "entries_exact_member_count"
  AFTER INSERT OR UPDATE ON "entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_entry_member_count"();

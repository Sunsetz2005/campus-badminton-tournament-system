-- 平台共用裁判账号：全体裁判统一登录同一个裁判员账号执裁所有赛事。
-- 带此标记的账号在每个赛事（含此后新建的赛事）都自动持有 REFEREE 角色；建赛向导只创建共用裁判账号模式的赛事。
ALTER TABLE "users" ADD COLUMN "platformReferee" BOOLEAN NOT NULL DEFAULT false;

-- 既有的平台裁判账号：未被某个赛事单独开通、只担任裁判员、不是队伍负责人、仍启用的普通账号。
UPDATE "users" AS u
SET "platformReferee" = true
WHERE u."systemRole" = 'USER'
  AND u."status" = 'ACTIVE'
  AND u."provisionedForTournamentId" IS NULL
  AND EXISTS (SELECT 1 FROM "role_assignments" r WHERE r."userId" = u."id" AND r."role" = 'REFEREE')
  AND NOT EXISTS (SELECT 1 FROM "role_assignments" r WHERE r."userId" = u."id" AND r."role" <> 'REFEREE')
  AND NOT EXISTS (SELECT 1 FROM "team_managers" m WHERE m."userId" = u."id");

INSERT INTO "role_assignments" ("id", "userId", "tournamentId", "role", "createdAt")
SELECT gen_random_uuid(), u."id", t."id", 'REFEREE', now()
FROM "users" u CROSS JOIN "tournaments" t
WHERE u."platformReferee"
ON CONFLICT ("userId", "tournamentId", "role") DO NOTHING;

-- 按用户决定统一改为共用裁判账号执裁；既有逐场指派记录保留，管理员仍可在赛事概览切回逐场指派。
UPDATE "tournaments" SET "refereeMode" = 'SHARED_ACCOUNT' WHERE "refereeMode" = 'PER_MATCH';

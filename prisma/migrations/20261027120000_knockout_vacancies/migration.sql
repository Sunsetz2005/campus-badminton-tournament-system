-- 赛务口径 K-1 / K-2（2026-10-27）：淘汰签位一侧确定为空（对手弃权、取消资格、小组出线人数不足、
-- 双方都不能比）时，另一侧以 WO 晋级；两侧都空则本场无胜者，空位继续传给下一轮。
--
-- sideAVacant / sideBVacant：该侧来源已经确定，但没有人可以填入（与「来源尚未产生」的 NULL 区分）。
-- vacancyDecided：本对阵因空位直接决出（未进行比赛），来源变化时据此撤回。
ALTER TABLE "fixtures"
  ADD COLUMN "sideAVacant" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sideBVacant" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "vacancyDecided" BOOLEAN NOT NULL DEFAULT false;

-- 「已决出但无胜者」（两侧都空、或淘汰赛确认为终止且无胜方）需要 decidedAt 有值而 winnerEntryId 为空。
-- 原约束要求二者同为空或同不为空，放宽为：有胜者就必须有决出时刻。
ALTER TABLE "fixtures" DROP CONSTRAINT "fixtures_decided_pair_check";
ALTER TABLE "fixtures"
  ADD CONSTRAINT "fixtures_decided_pair_check" CHECK ("winnerEntryId" IS NULL OR "decidedAt" IS NOT NULL);

ALTER TABLE "fixtures"
  ADD CONSTRAINT "fixtures_vacant_side_check" CHECK (
    (NOT "sideAVacant" OR "sideAEntryId" IS NULL)
    AND (NOT "sideBVacant" OR "sideBEntryId" IS NULL)
    AND ("kind" <> 'GROUP' OR (NOT "sideAVacant" AND NOT "sideBVacant"))
  ),
  ADD CONSTRAINT "fixtures_vacancy_decided_check" CHECK (
    NOT "vacancyDecided" OR (("sideAVacant" OR "sideBVacant") AND "decidedAt" IS NOT NULL)
  );

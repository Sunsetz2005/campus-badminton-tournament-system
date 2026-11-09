-- 独立复判第二轮 RV2-01：离场待续（S-9）的典型结局是伤停后退赛。原 CHECK 只允许「暂停中」带离场标记，
-- 记录退赛/弃权（转为结束待提交）会违反约束、整个命令回答 500。
-- 放宽为：离场待续的比赛不能处于会打球的状态（未开打 / 进行中），结束待提交、已提交仍可保留标记。
-- 保留标记而不是清除：作废特殊结果回到暂停中时标记仍在，恢复前仍须先转场（不重开 RV-02 的口子）。
ALTER TABLE "matches" DROP CONSTRAINT "matches_awaiting_court_only_suspended";
ALTER TABLE "matches" ADD CONSTRAINT "matches_awaiting_court_not_playable"
  CHECK ("awaitingCourtSince" IS NULL OR "lifecycleStatus" IN ('SUSPENDED', 'ENDED_PENDING_SUBMISSION', 'SUBMITTED'));

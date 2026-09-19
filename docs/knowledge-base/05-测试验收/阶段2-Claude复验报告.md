---
title: 阶段 2 Claude 独立复验报告
stage: 2
status: current
updated: 2026-09-19
tags:
  - 羽毛球赛事管理系统
  - 复验报告
  - 测试验收
---

# 阶段 2 Claude 独立复验报告

> 本文件按轮次追加，不覆盖历史结论。原始审查结论保留在[阶段 2 Claude 独立审查报告](阶段2-Claude审查报告.md)，本轮**未改写该文件一个字节**（仓库副本与 Vault 副本 SHA-256 均以 `8ba65500…` 开头）。
> 本轮为修复后的独立复验：只读业务源码、运行既有构建与测试、用临时探针用例取证，**未修改任何业务源码、既有测试、依赖、锁文件、迁移或环境配置**；探针文件在取证后已移出仓库。

---

## 第 2 轮 · 2026-09-19 · Claude 独立复验（Codex 修复 S2-001—S2-003 后）

### 一、复验基线

| 项 | 值 |
|---|---|
| 仓库路径 | `/Users/Shared/Files From d.localized/校园羽毛球赛事编排与成绩管理系统` |
| 分支 | `main`，`git stash list` 为空 |
| 基线 commit | `781906baded04957f4aabd12937bf98192ca3899`（Codex 本轮未提交、未推送） |
| 复验对象 | `git status --porcelain` 共 58 条（39 个已修改文件 + 19 个新增未跟踪文件） |
| 已跟踪改动规模 | `git diff --shortstat`：39 文件，+739 / −150 |
| 环境 | macOS 27.0 / Apple Silicon；`pnpm exec node -v` = v24.21.0；pnpm 11.9.0；PostgreSQL 15.18 |
| 隔离库 | 全部写入发生在 `badminton_tournament_test`；`badminton_tournament_dev` 与本机其余数据库全程未被访问 |

复验结束时测试库计数：`users=2 / sessions=0 / scoring_sessions=0 / audit_logs=0 / match_events=0`，与 Codex 自述一致。

#### 先做「是否靠削弱测试掩盖问题」的检查

| 测试文件 | 用例数 | 结论 |
|---|---|---|
| `tests/domain/match-engine.test.ts` | 26 | 含 3 条 `S2-00x` 新增回归；无删除痕迹 |
| `tests/db/database-safety.test.ts` | 4 | 未变 |
| `tests/domain/rule-profile.test.ts` | 3 | 未变 |
| `tests/e2e/phase-1.spec.ts` | 8 | 未变 |
| `tests/integration/authorization.test.ts` | 6 | 未变 |
| 其余 8 个文件 | 合计 20 | 未变 |

- `grep -rE '\.(skip|only|todo)\(|xit\(|xdescribe\('` 在 `tests/` 全量零命中。
- `vitest.config.ts` 的 `include` 仍为 `tests/**/*.test.ts`，**未新增 `exclude`**。
- 三条新增回归都是「拒绝断言 + 聚合未被修改断言」，方向是收紧而非放宽。

结论：**未发现通过删除测试、弱化断言或关闭校验来掩盖问题的行为。**

#### 未能独立复现的一项自述

Codex 自述「修复前新增 3 条回归全部失败」。`src/domain/rules/match-engine.ts` 与 `tests/domain/match-engine.test.ts` 均为**未跟踪文件**，`HEAD` 中不存在修复前版本，本轮**无法从 git 独立重放这一步**。该自述按「不可独立取证」处理，不写入结论。三个修复本身的有效性由下文的独立探针单独取证，不依赖该自述。

---

### 二、逐项复验结论

| 编号 | 原判定 | 本轮复验 | 结论 |
|---|---|---|---|
| S2-001 | 比分整体更正可写入自相矛盾状态 | 替换内容的校验已补齐；但**当前 phase 未设门禁**，同一命令可改写已确认结果 | **部分通过 — 另立 S2-007** |
| S2-002 | 物理端更正导致二次换边 | 裸更正被拒、引用后消费义务、端位只改变一次，**二次换边已消除** | **通过**（另立 S2-008，非阻塞） |
| S2-003 | `replayMatch` 回吐快照 | 已改为逐事件重新执行命令并全量比对事件；三类篡改全部被拒 | **通过** |
| S2-006 | 文档数量硬编码 | DOC-001 改为「由同步清单动态核对」，不再写死数量 | **通过** |

#### S2-001 — 部分通过

`applyReplacement`（`src/domain/rules/match-engine.ts:452` 起）新增的校验独立取证有效：

- `25:3` 且 `phase=IN_PROGRESS` → `corrected_game_already_won`
- `gamesWon` 与 `completedGames` 不一致 → `corrected_games_inconsistent`
- 单局 21 制更正到 `11:0` 而不带阈值义务 → `corrected_obligations_inconsistent`
- 显式带齐 `INTERVAL` + `CHANGE_ENDS` 且 `phase=OBLIGATIONS_PENDING` → accepted
- 非法更正后聚合逐字节不变

但校验的是**替换值里的 `phase`**，没有校验**命令发出时聚合所处的 `phase`**。`CORRECT_SCORE_STATE` 分支没有 `result_locked` 一类门禁，而 `UNDO_LAST_REVERSIBLE` 和 `RECORD_SPECIAL_OUTCOME` 都有。详见下方 S2-007。

#### S2-002 — 通过

独立探针确认：存在未处理 `CHANGE_ENDS` 时，裸的 `CORRECT_PHYSICAL_ENDS` 被 `change_ends_relationship_required` 拒绝；显式引用该义务后义务被消费、`physicalEnds` 只按提交值改变一次、剩余 `INTERVAL` 义务保留。原报告的「交换两次」路径已不可达。

#### S2-003 — 通过

独立篡改三类字段，全部被拒（不只是 Codex 回归里的 `stateAfter.score`）：

| 篡改对象 | 结果 |
|---|---|
| 末事件 `stateAfter.score` 改为 `99:99` | 抛出「事件快照与命令重放结果不一致」 |
| 末事件 `stateBefore.score` 改为 `7:7` | 抛错 |
| 末事件 `payload.side` 由 `B` 改为 `A` | 抛错 |

未篡改的 JSON 往返、含 `UNDO_LAST_REVERSIBLE` 的序列重放结果与权威状态一致。**遗留边界**（不构成不通过）：`initialState` 本身没有锚点，重放无法发现被替换的初始状态；这属于阶段 3 的持久化与签名范畴，原报告已写明。

---

### 三、本轮新发现

#### S2-007 — `CORRECT_*` 系列命令没有结果锁门禁，已确认的成绩可被静默改写

- **严重程度：P2（建议列为阶段 3 前置）**
- **证据状态：运行复现**
- **位置**：`src/domain/rules/match-engine.ts` 的 `nextStateForCommand`，`CORRECT_SCORE_STATE` / `CORRECT_SERVICE_ORDER` / `CORRECT_PHYSICAL_ENDS` / `CORRECT_LOGICAL_COURTS` 四个分支
- **实测**（单局 21 制单打）：

  ```
  20:0 → RALLY_WON(A) → MATCH_COMPLETE_PENDING_SUBMISSION
  SUBMIT_RESULT → SUBMITTED，CONFIRM_RESULT → CONFIRMED
  CORRECT_SCORE_STATE(replacement 5:3, phase=IN_PROGRESS)
    → accepted，状态变为 IN_PROGRESS / 5:3 / gamesWon {A:0,B:0}   ← 已确认成绩被抹掉
  同一状态下 UNDO_LAST_REVERSIBLE → rejected(undo_result_locked)   ← 门禁只保护了撤销
  同一状态下 CORRECT_SERVICE_ORDER / CORRECT_PHYSICAL_ENDS → accepted（phase 保持 CONFIRMED）
  ```

- **另外三条同源路径**：

  ```
  AWAITING_COIN_TOSS（未抛币）+ CORRECT_SCORE_STATE
    → accepted，phase=IN_PROGRESS 而 coinToss=null、physicalEnds=null     ← 绕过抛币
  SPECIAL_OUTCOME_PENDING_SUBMISSION（已记 RET，胜方 B）+ CORRECT_SCORE_STATE
    → accepted，phase=IN_PROGRESS 而 specialOutcome 仍为 RET/B            ← 两个互斥事实并存
  PAUSED + CORRECT_SCORE_STATE
    → accepted，phase=IN_PROGRESS 而 pausedFromPhase 仍为 IN_PROGRESS     ← 残留字段
  ```

- **与 S2-001 的关系**：同一条命令、同一类风险。S2-001 修的是「替换值内部自相矛盾」，S2-007 是「替换发生在不该发生的阶段」。原审查报告没有覆盖这一面，因此不是修复引入的回归，而是同一路径上未被发现的一半。
- **影响**：阶段 3 要把 `CORRECT_SCORE_STATE` 接到裁判长更正界面，并用 `ResultRevision` + `REOPEN_RESULT` 承载「已确认成绩的受控重开」。若纯引擎本身允许绕过 `REOPEN_RESULT` 直接改写 `CONFIRMED` 状态，这条审计链在引擎层就是空的，数据库层再补也只是补一半。
- **最小修复建议**：在四个 `CORRECT_*` 分支前统一加与 `RECORD_SPECIAL_OUTCOME` 相同的 `result_locked` 判断；`CORRECT_SCORE_STATE` 另外要求当前 `phase ∈ {IN_PROGRESS, OBLIGATIONS_PENDING, GAME_COMPLETE, PAUSED}`（或明确列出允许集合），并在 `SPECIAL_OUTCOME_PENDING_SUBMISSION` 下拒绝，或要求先撤销特殊结果。
- **建议回归测试**：`CONFIRMED` 下四条 `CORRECT_*` 全部被拒；未抛币状态下 `CORRECT_SCORE_STATE` 被拒；已记特殊结果时 `CORRECT_SCORE_STATE` 被拒。

#### S2-008 — 「更正端位」与「完成规则换边」被绑死，无法表达「只改记录、现场尚未换边」

- **严重程度：P3（非阻塞）**
- **证据状态：运行复现**
- **位置**：`src/domain/rules/match-engine.ts:588` 起的 `CORRECT_PHYSICAL_ENDS` 分支
- **实测**：存在未处理 `CHANGE_ENDS` 时，`CORRECT_PHYSICAL_ENDS` 只有一种被接受的形态——`fulfillsObligationId` 指向该 `CHANGE_ENDS`：

  ```
  不带 fulfillsObligationId                → rejected(change_ends_relationship_required)
  fulfillsObligationId 指向同时挂着的 INTERVAL → rejected(obligation_not_found)
  fulfillsObligationId 指向该 CHANGE_ENDS     → accepted（义务被消费）
  ```

- **问题**：拒绝信息写的是「必须明确**是否**同时完成该义务」，但命令载荷只有「是」这一个分支。若现场真实情况是「开局端位记错了，但规则换边尚未执行」，裁判只能二选一：放弃更正，或者消费掉一个并未完成的换边义务。
- **影响**：S2-002 要防的二次换边已经防住，这条只是表达能力缺口；但它会在阶段 3 的 UI 上变成一个无法如实回答的问题。
- **最小修复建议**：把 `fulfillsObligationId?: string` 改为显式三态，例如增加 `changeEndsRelationship: "FULFILLS" | "UNRELATED"`，`UNRELATED` 时保留义务并要求原因；或允许 `fulfillsObligationId` 为 `null` 但强制附加 `unrelatedReason`。

---

### 四、命令与结果（全部本机实际执行）

| 命令 | 结果 |
|---|---|
| `pnpm test` | 10 文件 / **47 passed** |
| `pnpm exec vitest run tests/domain/match-engine.test.ts` | **26 passed** |
| `pnpm run lint` | 通过，无输出 |
| `pnpm run typecheck` | 通过，无输出 |
| `pnpm run build` | 成功 |
| `pnpm run test:e2e` | **8 passed**（4.7s） |
| `pnpm run test:production-startup-security` | **2/2 pass** |
| `node --test tests/sync-knowledge-base.test.mjs` | **10/10 pass** |
| `pnpm run docs:sync:dry-run` | `create=0 update=0 unchanged=34 stale=0 conflict=0` |
| 三份 Claude 报告仓库/Vault SHA-256 | 三组两两一致 |

Codex 自述的每一项数字在本轮均独立复现，无夸大。

---

### 五、结论

- **S2-002、S2-003、S2-006：独立复验通过。**
- **S2-001：修复方向正确、替换值校验有效，但同一命令的阶段门禁缺失，复验判定为部分通过，遗留部分另立 S2-007。**
- 阶段 2 纯引擎的其余结论与第 1 轮一致；S2-004、S2-005 本轮未动，仍是非阻塞遗留。
- **是否可以进入阶段 3：建议先修 S2-007 再进入。** 理由与第 1 轮对 S2-001 的理由相同——它落在阶段 3 要建的「已确认成绩只能经 `REOPEN_RESULT` + `ResultRevision` 改写」这条审计链的地基上，在纯引擎里是几行判断，落库后再修就要处理已写入的错误历史。S2-008 可与阶段 3 并行处理。
- 本轮复验未修改任何业务源码或既有测试，阶段 3 仍未启动。

---

## 第 3 轮 · 2026-09-19 · Claude 独立复验（Codex 修复 S2-007 后）

### 一、复验基线

| 项 | 值 |
|---|---|
| 基线 commit | `781906baded04957f4aabd12937bf98192ca3899`（仍未提交、未推送） |
| 复验对象 | 第 2 轮之后对 `src/domain/rules/match-engine.ts`、`tests/domain/match-engine.test.ts` 及文档的增量改动 |
| 隔离库 | 仍只写 `badminton_tournament_test`；复验结束计数 `users=2 / sessions=0 / scoring_sessions=0 / audit_logs=0 / match_events=0` |

#### 「是否靠削弱测试掩盖问题」的检查

| 测试文件 | 第 2 轮 | 本轮 | 结论 |
|---|---|---|---|
| `tests/domain/match-engine.test.ts` | 26 | 28 | 只增不减（+2 条 `S2-007` 回归） |
| 其余 12 个文件 | 合计 41 | 合计 41 | 全部未变 |

`tests/` 全量 `grep` 仍无 `skip` / `only` / `todo`；`vitest.config.ts` 的 `include` 未变、仍无 `exclude`。**未发现削弱测试的行为。**

---

### 二、S2-007 复验结论：**通过**

门禁实现位于 `src/domain/rules/match-engine.ts:334`（`assertResultUnlocked`）与 `:340`（`assertScoreCorrectionAllowed`），调用点覆盖 `CORRECT_PHYSICAL_ENDS`、`CORRECT_LOGICAL_COURTS`、`CORRECT_SERVICE_ORDER`、`CORRECT_SCORE_STATE` 四个分支，与 `RECORD_SPECIAL_OUTCOME` 的既有 `result_locked` 语义一致。

Codex 回归之外，本轮另用独立探针补验了 4 个未被其回归覆盖的状态：

| 探针 | 状态 | 结果 |
|---|---|---|
| Q1 | `AWAITING_OPENING_SETUP`（已抛币未确认开局） | `score_correction_not_allowed` ✅ |
| Q2 | `MATCH_COMPLETE_PENDING_SUBMISSION` | accepted，全场制胜分被改回 `20:20 / IN_PROGRESS` ✅ 白名单按设计生效 |
| Q3 | `AWAITING_NEXT_GAME_SETUP` | 被挡；但 `UNDO_LAST_REVERSIBLE` 与「开下一局后用 `completedGames` 修正首局」两条出路均实测可用，**新门禁没有把合法更正变成死路** ✅ |
| Q4 | `SPECIAL_OUTCOME_PENDING_SUBMISSION` | 被挡；但**没有任何命令能回到计分**，详见 S2-009 |

第 2 轮报告中列出的四条实测路径逐条复测，全部已封堵：

```
CONFIRMED + CORRECT_SCORE_STATE            → rejected(result_locked)
CONFIRMED + CORRECT_SERVICE_ORDER          → rejected(result_locked)
CONFIRMED + CORRECT_PHYSICAL_ENDS          → rejected(result_locked)
CONFIRMED + CORRECT_LOGICAL_COURTS         → rejected(result_locked)
SUBMITTED + CORRECT_SCORE_STATE            → rejected(result_locked)
AWAITING_COIN_TOSS + CORRECT_SCORE_STATE   → rejected(score_correction_not_allowed)
PAUSED + CORRECT_SCORE_STATE               → rejected(score_correction_not_allowed)
SPECIAL_OUTCOME_... + CORRECT_SCORE_STATE  → rejected(score_correction_not_allowed)
CONFIRMED → REOPEN_RESULT → CORRECT_SCORE_STATE → accepted   ← 受控重开审计链未被误伤
```

同时确认 S2-001、S2-002、S2-003 的既有回归在新门禁下仍然成立（定向 28/28 全绿，无用例被改写为迁就门禁）。

---

### 三、本轮新发现

#### S2-009 — 特殊结果一经记录即不可逆，纯引擎没有「作废特殊结果」命令

- **严重程度：P3（不阻塞阶段 3，但建议在阶段 2 内顺手补齐）**
- **证据状态：运行复现**
- **位置**：`src/domain/rules/match-engine.ts` 的 `RECORD_SPECIAL_OUTCOME` 分支与 `MatchCommand` 联合类型
- **实测**：在 `1:0` 的进行中比赛上误记 `RET`（胜方 B）之后，穷举所有命令，**没有任何一条能回到 `IN_PROGRESS`**：

  ```
  CORRECT_SCORE_STATE    → score_correction_not_allowed
  UNDO_LAST_REVERSIBLE   → undo_has_later_operations
  RESUME_MATCH           → resume_not_allowed
  PAUSE_MATCH            → pause_not_allowed
  RALLY_WON              → match_not_scoring
  REOPEN_RESULT          → reopen_not_allowed
  SUBMIT → REOPEN 后 CORRECT_SCORE_STATE → score_correction_not_allowed
  SUBMIT → REOPEN 后 UNDO                → undo_has_later_operations
  ```

  仅剩的动作是用另一条 `RECORD_SPECIAL_OUTCOME` 覆盖（结果仍是特殊结果）或提交/确认。

- **与 S2-007 的关系**：**S2-007 的修复本身是正确的**。修复前这条死路有一个「错误的出口」——`CORRECT_SCORE_STATE` 会被接受，但 `specialOutcome` 不会被清除，留下「进行中比赛同时挂着 RET」的矛盾状态（即第 2 轮报告里的实测之一）。堵掉错误出口后，缺少正确出口这一事实才暴露出来。这是**既有缺口被显形**，不是修复引入的回归。
- **影响**：阶段 3 裁判工作台上，误点一次「退赛/弃权」即等于该场比赛在引擎层永久不可继续计分。
- **最小修复建议**：仿照已有的 `INVALIDATE_COIN_TOSS` 增加 `INVALIDATE_SPECIAL_OUTCOME`（要求原因、仅在 `SPECIAL_OUTCOME_PENDING_SUBMISSION` 下可用、清空 `specialOutcome` 并回到记录前的 phase）。`INVALIDATE_COIN_TOSS` 已经确立了「误记的一次性决定可受控作废」这一先例，本条与之同构。
- **建议回归测试**：误记特殊结果后作废，比分与发接发回到记录前状态；已 `SUBMITTED`/`CONFIRMED` 时作废被拒。

---

### 四、命令与结果（全部本机实际执行）

| 命令 | 结果 |
|---|---|
| `pnpm test` | 10 文件 / **49 passed** |
| `pnpm exec vitest run tests/domain/match-engine.test.ts` | **28 passed** |
| `pnpm run lint` / `pnpm run typecheck` / `pnpm run build` | 全部通过 |
| `pnpm run test:e2e` | **8 passed** |
| `pnpm run test:production-startup-security` | **2/2 pass** |
| `node --test tests/sync-knowledge-base.test.mjs` | **10/10 pass** |
| `pnpm run docs:sync:dry-run` | `create=0 update=0 unchanged=35 stale=0 conflict=0` |
| 四份 Claude 报告仓库/Vault SHA-256 | 四组两两一致（本报告第 2 轮版本为 `56e81654…`，Vault 侧与仓库逐字节相同） |

Codex 自述的每一项数字均独立复现。与第 2 轮同样，`match-engine.ts` 仍是未跟踪文件，「修复前 2 条回归失败」无法从 git 重放，按「不可独立取证」处理，不写入结论。

---

### 五、结论

- **S2-007：独立复验通过。** 四类更正命令的结果锁、比分更正的阶段白名单、以及 `REOPEN_RESULT` 受控重开通路三者同时成立。
- **S2-001 至此全部收口**：替换内容校验（第 2 轮通过）+ 入口阶段门禁（本轮通过）。
- S2-002、S2-003、S2-006 维持第 2 轮结论；S2-004、S2-005、S2-008 仍是已登记的非阻塞遗留。
- **是否可以进入阶段 3：可以。** 第 2 轮提出的唯一前置条件已消除，本轮新发现的 S2-009 是产品能力缺口而非正确性缺陷，不构成阶段 3 的地基风险；但它是纯引擎内的几十行改动，在阶段 2 收尾时补比进入阶段 3 后再补便宜。
- 本轮复验未修改任何业务源码或既有测试，阶段 3 仍未启动。

# 70fff5e 复审与修复记录（2026-09-21，第二轮）

## 基线与边界

- 审查基线：`main` / `70fff5e87c9252e0bd6cbd13060d6d870dd4cd37`（`feat: rebuild officiating workbench as a court-first console`）。
- 本机基线：同一提交 `70fff5e`，工作树带有上一轮 R3 修复的未提交改动。
- 审查方（ChatGPT）实际读取了固定提交的源码，但**未在项目环境执行测试、未打开浏览器、未连接数据库**；附带的
  `requirements/review-70fff5e/tests/referee-boundary-regressions.review.test.ts` 只做过语法检查。
  下表中的运行结果全部来自本机真实执行，不照抄审查报告的任何“通过”。
- 本轮没有提交、没有推送、没有部署，没有连接开发库以外的任何数据库写入；测试只连 `badminton_tournament_test`。

## 草案测试的真实首次运行

把审查草案逐字复制为 `tests/domain/referee-boundary-regressions.test.ts`（**不覆盖** `tests/domain/` 既有用例），
在修改任何实现之前运行：

```
pnpm exec dotenv -e .env.test -- pnpm exec vitest run tests/domain/referee-boundary-regressions.test.ts
→ 11 tests | 3 failed | 8 passed（证据：artifacts/review-70fff5e/rv3-baseline-draft-run.txt）
```

- RV3-001 的 6 条断言**全部通过**：该问题已由上一轮 R3-001 修复覆盖（`thresholdObligationsIssued`），
  审查报告基于 `70fff5e` 的分析在本机工作树已不成立，不重复修，也不回退。
- RV3-003 的 3 条**全部失败**：`expected 'OBLIGATIONS_PENDING' to be 'IN_PROGRESS'`，问题真实复现。
- 领域撤销的 2 条通过：局末/赛末撤销在**领域层**本来就支持，这证明 RV3-004 是界面缺口而不是规则缺口。

## 逐项处理

| 编号 | 本机复核结论 | 处理 | 真实证据 |
|---|---|---|---|
| RV3-001 阈值重复 | **已在更新版本修复** | 不改实现，保留草案 6 条断言做回归 | 草案首次运行即 6/6 绿；`tests/domain/threshold-obligations.test.ts` 15/15 |
| RV3-002 抛币选择写死 | **已复现**（六个按钮把负方固定成 `END_2` / `SERVE`） | 改为分步联动表单，保留引擎 `deriveCoinToss` | 领域 4 组合 4/4；浏览器 2 条新用例通过 |
| RV3-003 暂停中清空待办后卡死 | **已复现**（3 个规则档全红） | `RESUME_MATCH` 按当前待办结算恢复相位 | 草案 3 条转绿；另补 3 条边界用例 |
| RV3-004 局末/赛末无撤销入口 | **已复现**（`activePlay` 挡住减分按钮） | 结束待提交相位放开**得到结束分那一方**的撤销入口，并在主操作区给出显式按钮 | 浏览器端到端用例：21:19 → 撤销 → 20:19、`IN_PROGRESS`、撤销事件 1 条 |
| RV3-005 旧回执覆盖新状态 | **已在更新版本修复**（上一轮 R3-002） | 不重复修 | 浏览器注入：修复前 30 次采样 `["2"×6,"1"×24]`，修复后全为 `"2"` |
| RV3-006 更正照搬旧待办 | **已复现** | 领域新增 `deriveScoreCorrectionReplacement`，界面改为调用同一份推导 | 新增用例：旧做法 10:8→11:8 被拒 `corrected_obligations_inconsistent`，共用推导后接受 |
| RV3-007 结束时间被改写 | **已在更新版本修复**（上一轮 R3-004） | 不重复修 | 受控时钟集成用例：10:00 结束、10:05 提交、10:10 复核后仍为 10:00 |
| RV3-008 HTTP 错误一律丢弃原命令 | **已在更新版本修复**（上一轮 R3-003） | 不重复修 | 浏览器注入 4/4：502、畸形 200、超时、损坏本机记录均保留原 commandId |

## 实现说明

### RV3-003：恢复相位在 `RESUME_MATCH` 结算

问题不在“暂停时能不能处理待办”，而在恢复时回填了**处理前**的相位。
第一版改法是在 `finishObligationPhase` 里改写 `pausedFromPhase`，
但那会改变 `ACKNOWLEDGE_INTERVAL` / `CONFIRM_CHANGE_ENDS` 等事件的 `stateAfter`，
历史事件重放会失配。最终改法把结算放进 `RESUME_MATCH` 本身：

- 待办已清空 → 恢复到 `IN_PROGRESS`（或 `AWAITING_NEXT_GAME_SETUP`）。
- 还有待办 → 原样回填 `OBLIGATIONS_PENDING`，恢复后继续处理。
- **待办本来就为空的正常恢复，结算前后结果完全相同**，因此正常暂停/恢复历史逐字不变。

### RV3-006：更正推导只有一份

`deriveCorrectedObligations` 是唯一的推导，`applyReplacement`（服务端校验）与
`deriveScoreCorrectionReplacement`（界面收集意图后补全）共用它。
浏览器不再持有第二套竞赛推导算法，也没有放松任何领域校验：
服务端仍然独立验算并可拒绝，预览与最终提交走同一条命令、同一版本检查。
`CORRECT_SCORE_STATE` 的载荷形状没有改动，历史事件照常重放。

### RV3-002 / RV3-004：界面

- 抛币改为「胜方 → 胜方类别 → 具体选择 → 负方选剩余类别 → 摘要 → 确认」。
  表单不含任何随机数，取消不提交，确认前不发送命令，场地端标签跟随本机视角标明左右。
- 局末/赛末：只放开**得到结束分的一方**的“−1”，另一方仍禁用；
  主操作区同时给出「撤销刚才结束本局/本场的得分」按钮。
  是否真的可撤销由服务端 `applyUndo` 判定（已提交、已锁定、已开始下一局仍然拒绝），界面没有放宽规则。

## 历史事件与快照兼容

- 实测查询：`badminton_tournament_test` 与 `badminton_tournament_dev` 的 `MatchEvent` 计数均为 **0**，
  `PAUSE_MATCH` / `RESUME_MATCH` 事件各 0 条——本轮改动不影响任何已存历史。（只读查询，未写入。）
- 即便如此，改法仍按“可重放”设计：新增回归用例用 `replayMatch` 逐条比对命令重算结果与已记录事件的完整前后快照，
  覆盖正常暂停/恢复历史与暂停中处理待办两种轨迹，均通过。
- 上一轮的引擎 v1 → v2 升级方案（`normalizeMatchState` / `downgradeMatchStateToEngineV1` /
  `alignEventToRecordedShape`）保持不变，`MATCH_ENGINE_VERSION` 本轮不变。
- **没有删除事件、没有清库、没有关闭哈希或重放校验。**

## 截图证据目录被无声覆盖的问题（本轮一并处理）

`tests/e2e/phase-3.spec.ts` 过去每次运行都无条件重写 `artifacts/phase3-browser-simulated/` 却不更新清单，
`referee-court-shots.spec.ts` 的 `REFEREE_SHOT_DIR` 默认值也直接写 `after/`。
把文件还原到 HEAD 提交的字节后 `shasum -a 256 -c SHA256SUMS` 仍 6/6 FAILED，属改动前就存在的不一致。

本轮：两个 spec 默认改写到未提交的 `*local-run` 目录（已加入 `.gitignore`），
只有显式设置 `PHASE3_SHOT_DIR` / `REFEREE_SHOT_DIR` 才写入已记账目录；
`SHA256SUMS` 按当前已提交字节重算并自校验 6/6 OK，原清单保留为 `SHA256SUMS.superseded-2026-09-21`，
同目录 `README.md` 说明了经过。**重算只是让清单与现存文件自洽，不代表复现了旧清单的字节。**
复跑整套 e2e 后 `git status artifacts/` 不再出现被修改的已提交截图。

## 本轮实际执行结果

| 命令 | 结果 |
|---|---|
| `pnpm run lint` | 0 |
| `pnpm run typecheck` | 0 |
| `pnpm test` | **19 文件 / 178 用例通过**（上一轮 153） |
| `pnpm run test:e2e` | **52 通过**（上一轮 47） |
| `pnpm run build` | 成功 |
| `pnpm run test:production-startup-security` | 4/4 |
| `node --test tests/sync-knowledge-base.test.mjs` | 10/10 |

界面截图：`artifacts/review-70fff5e/shots/`，抛币表单与局末撤销入口各 5 个视口
（390×844、320×720、820×1180、1180×820、1440×1000），每个视口同时断言根级无横向溢出。
**这是 Chromium 设备模拟，不是真机验收。**

## 仍未验证

- 真机 iPhone / iPad / Android 执裁；真人裁判试用。
- HTTPS、反向代理与跨设备认证来源；生产部署与备份恢复。
- 并发负载、多只读端吞吐。
- BWF 正式规程采用（三个 profile 仍是演示配置）。
- 本轮全部是开发自测，**不是独立验收**；RV3-002/003/004/006 的状态是「已修复待独立复验」。

## 下一轮独立复验的最小步骤

1. `git status` 确认工作树与本记录一致；`pnpm install --frozen-lockfile`。
2. `pnpm exec dotenv -e .env.test -- pnpm exec vitest run tests/domain/referee-boundary-regressions.test.ts`，应 25/25。
3. `git stash` 领域与组件改动后重跑同一文件，应重现 RV3-003 的 3 条红灯。
4. `pnpm test`、`pnpm run test:e2e` 全量。
5. 手动打开 `/officiating/MS-DEMO-001`：走四种抛币组合，各自核对发球方与场地端；
   再把比分推到局末误点，验证撤销入口与另一方“−1”仍禁用。
6. 复跑 e2e 后检查 `git status artifacts/`，应无已提交截图被修改。

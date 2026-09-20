---
title: 阶段 3 裁判工作台与 UI-01-B Claude 联合独立验收提示词
stage: 3
status: current
updated: 2026-09-20
tags:
  - 羽毛球赛事管理系统
  - Claude
  - 独立验收
  - 裁判工作台
  - UI-01-B
---

# 阶段 3 裁判工作台与 UI-01-B Claude 联合独立验收提示词

> 将本文件从“你的角色”开始完整交给 Claude。不要同时附带开发者口头保证，也不要把 Codex 自测记录当成 Claude 的验收结论。

## 你的角色

你是本项目的独立代码审查与验收人员，不是修复者。本轮同时审查两条工作线：

1. `e150aa6`、`0b72198`、`b29e0f8` 覆盖的规则语义、特殊结果回退、场地图裁判工作台和配套文档；
2. `b29e0f8` 之后实现的 `UI-01-B` 每日赛程与比赛详情隔离预览。

必须从 Git、规则代码、服务端事务、组件接口、真实浏览器、测试数据库和截图证据独立复现。Codex 自测的命令、计数和结论以项目最终文档记录为准，全部仅作为待复核声明；不得直接转写成 Claude 结论。

最终分别给出以下四项结论：

- S2-008 换边待办关系：通过／部分通过／不通过／无法确认；
- S2-009 特殊结果受控作废：通过／部分通过／不通过／无法确认；
- 阶段 3 场地图裁判工作台：通过／有条件通过／不通过／无法确认；
- UI-01-B 隔离预览：通过／有条件通过／不通过／无法确认。

最后再给一个联合总判定。未执行、环境不具备或证据不足的项目必须写“未测试／无法确认”，不能用静态阅读替代运行结论。

## 只读边界

1. 完全不修改仓库中的源码、测试、配置、迁移、依赖、锁文件、文档、截图或其他资产。
2. 不新增验收报告文件；最终报告只在对话回复中输出。
3. 不运行会写入仓库的格式化、代码生成、快照更新或自动修复命令。
4. 不执行 `git reset`、`git checkout --`、`git clean`、`git stash`、rebase、commit 或 push。
5. 不删除、覆盖或“恢复”用户当前工作树。即使发现测试改写文件，也只能报告，不能自行处理。
6. 不修改断言、fixture、seed、环境文件或测试配置来让测试通过。
7. 不安装新依赖，不修改全局软件。
8. 不运行 `pnpm run docs:sync`、`--adopt-target` 或任何 Vault 写操作；只允许执行 `docs:sync:dry-run`。
9. 所有数据库写探针只能使用库名以 `_test` 结尾的测试库。不得迁移、写入、清理或探测开发库和生产库。
10. 参考站截图、用户概念图、生成设计图和开发者已有截图只能作为待核对材料，不能替代本轮独立浏览器证据。
11. 发现问题后不要修复。继续完成其余安全检查，最后给最小修复建议和回归建议。
12. 当前仍是阶段 3 收尾。不得建议自动进入阶段 4，也不得把 UI-01-B 模拟预览称为真实公开赛程系统。

## 建立 Git 基线

阶段 3 工作线的预期提交链为：

```text
c9e6b004c9012f656f1b50feafd6bfe16b227097
  └─ e150aa6ff643bb515b83a46caa5f2ef898427497
      └─ 0b721980d42554ad4974c5851c0754a233b1862d
          └─ b29e0f8f94abad8274039b26ebcef2c134d11479
```

先独立解析并验证提交对象、父子关系和当前分支：

```bash
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git rev-parse 'c9e6b00^{commit}'
git rev-parse 'e150aa6^{commit}'
git rev-parse '0b72198^{commit}'
git rev-parse 'b29e0f8^{commit}'
git log --format='%H %P %s' --decorate -12
git merge-base --is-ancestor c9e6b00 e150aa6
git merge-base --is-ancestor e150aa6 0b72198
git merge-base --is-ancestor 0b72198 b29e0f8
git status --porcelain=v1 --untracked-files=all
git diff --stat c9e6b00 e150aa6
git diff --name-status c9e6b00 e150aa6
git diff --stat e150aa6 0b72198
git diff --name-status e150aa6 0b72198
git diff --stat 0b72198 b29e0f8
git diff --name-status 0b72198 b29e0f8
git diff --stat b29e0f8
git diff --name-status b29e0f8
git diff --cached --stat
git ls-files --others --exclude-standard
git stash list
```

差异必须分开归类：

- `c9e6b00..e150aa6`：规则语义与协议；
- `e150aa6..0b72198`：场地图和裁判工作台；
- `0b72198..b29e0f8`：测试、证据和文档包；
- `b29e0f8..当前 HEAD/工作树`：UI-01-A/B、共享组件及后续改动；
- 无法归属或超出任务范围的改动。

不要用单一的 `git diff c9e6b00` 代替分段审查，否则会把 UI-01 工作树误算为场地图提交。`0b72198` 依赖 `e150aa6` 的新命令语义，不能把它当成可单独移植到旧基线的纯 UI 提交。

若提交不再是当前分支祖先，或 UI-01-B 的实际基线不是 `b29e0f8`，不要擅自改写历史。报告真实拓扑，按提交对象和当前工作树分别审查，并把基线偏差列为风险。

开始和结束时各记录一次 Git 状态。最终状态必须与开始状态一致；任何已跟踪或未跟踪仓库文件变化都必须逐项解释。

## 在临时副本运行会写文件的测试

阶段 3 Playwright 用例会把截图写入已跟踪的 `artifacts/phase3-browser-simulated/`。因此不得直接在用户工作树运行完整 `pnpm run test:e2e`。

先把当前工作树复制到权限受限的系统临时目录，再在副本中安装、构建、测试和截图。复制必须包含当前未提交及未跟踪实现，但排除 `.git`、缓存、依赖和既有测试输出。

```bash
SOURCE_ROOT="$(pwd)"
REVIEW_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/badminton-claude-review.XXXXXX")"
chmod 700 "$REVIEW_ROOT"
mkdir -p "$REVIEW_ROOT/repo" "$REVIEW_ROOT/evidence" "$REVIEW_ROOT/logs"

rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='playwright-report' \
  --exclude='test-results' \
  --exclude='.env' \
  --exclude='.env.test' \
  --exclude='.env.seed' \
  "$SOURCE_ROOT/" "$REVIEW_ROOT/repo/"

cp "$SOURCE_ROOT/.env.test" "$REVIEW_ROOT/repo/.env.test"
chmod 600 "$REVIEW_ROOT/repo/.env.test"
```

复制前后再次取得源工作树状态和 diff 哈希。如果复制期间源工作树发生变化，当前副本不是稳定审查快照，必须重新建立副本或把该轮写成“无法确认”。

不得在报告中输出数据库密码、认证密钥或模拟账号口令。停止全部测试服务后删除临时副本中的 `.env.test`，但保留不含秘密的截图、日志及其 SHA-256 供用户检查。

## 阅读权威材料

先阅读审查时的实际版本：

- `AGENTS.md`
- `README.md`
- `docs/knowledge-base/00-首页.md`
- `docs/knowledge-base/06-开发日志/当前进度与下一步.md`
- `docs/knowledge-base/01-项目规划/需求验收追踪矩阵.md`
- `docs/knowledge-base/03-竞赛规则/计分与双打发接发.md`
- `docs/knowledge-base/03-竞赛规则/换边撤销与更正.md`
- `docs/knowledge-base/03-竞赛规则/分组排名与特殊结果.md`
- `docs/knowledge-base/04-交互设计/裁判端交互规范.md`
- `docs/knowledge-base/04-交互设计/亚运会网站参考与本项目界面规范.md`
- `docs/knowledge-base/04-交互设计/公开赛程与成绩中心-页面与状态清单.md`
- `docs/knowledge-base/05-测试验收/阶段3-场地图工作台-Claude验收提示词.md`
- UI-01 证据索引、哈希清单及当前实现实际引用的图片资产。

文档和代码不一致时，以运行代码事实为准，并把文档漂移单列为发现。不得改写历史 Claude 报告。

## 审查规则与裁判工作台

### 规则和协议

至少检查：

- `src/domain/rules/match-engine.ts`
- `src/server/services/scoring-command-schema.ts`
- `src/server/services/scoring-command-service.ts`
- `src/server/services/match-state-service.ts`
- `src/server/services/scoring-session-service.ts`
- 计分、控制、预览和原命令查询 API
- `prisma/schema.prisma` 及相关迁移
- 对应领域、服务、集成和 E2E 测试。

如可联网，重新从 BWF 官方域名取得项目文档引用的规则原文，记录最终 URL、标题、版本、下载时间和 SHA-256。核对单打奇偶发球区、双打得分后轮转、发接发对角关系和错误更正保留比分。官方原文不可访问时，只能写“规则原文无法独立确认”，不能用博客或开发者转述判定通过。

### S2-008 独立复验

自行构造 `CHANGE_ENDS` 和 `PHYSICAL_ENDS_REVIEW` 待办，不复用现有测试 helper，验证：

1. `obligationRelationship.action="FULFILL"` 按提交值更正物理端，只消费目标待办，不能再多交换一次；
2. `KEEP_PENDING` 只修正此前端位记录，保留 `CHANGE_ENDS`，之后确认换边时只交换一次；
3. `PHYSICAL_ENDS_REVIEW` 必须显式完成，不能以 `KEEP_PENDING` 留下；
4. 缺少关系、错误 ID、错误待办类型、无待办却声明关系、新旧字段同时存在均拒绝，聚合、事件、版本、快照、局分和审计零变化；
5. 历史 `fulfillsObligationId` 只允许重放既有事件，新 HTTP 命令使用旧字段必须被拒绝；
6. 相同 `commandId` 同内容只生效一次；同 ID 改 action 必须拒绝；
7. 三类更正命令分别验证自己的 phase 白名单，不能假设允许阶段完全相同；
8. 浏览器中“完成换边”和“只修正记录、保留待办”文案及预览结果可区分。

现有测试有部分通过手工改 phase 构造状态。Claude 必须补充从真实命令可达的状态轨迹，不能只复制现有测试。

报告列出待办、端位、版本和事件数的前后值，并单独给出 S2-008 结论。

### S2-009 独立复验

从非零比分分别进入进行中、暂停、存在待办和允许记录特殊结果的赛前状态，记录错误的特殊结果，再执行 `INVALIDATE_SPECIAL_OUTCOME`：

1. 原特殊结果事件保留，作废事件正确记录 `invalidatedCommandId`；
2. 精确恢复目标事件的 `stateBefore`，包括比分、胜局、当前局、发球方、发球员、接发员、逻辑 R/L、物理端、待办、暂停来源和 phase；
3. 不硬编码恢复为 `IN_PROGRESS`；
4. 已有特殊结果不能被另一条 `RECORD_SPECIAL_OUTCOME` 覆盖，必须先作废；
5. `SUBMITTED/CONFIRMED` 不能直接作废；经裁判长有审计的 `REOPEN_RESULT` 后再处理；
6. 原命令和作废命令分别验证幂等、同 ID 异载荷、JSON 往返和完整重放；
7. 通过真实 HTTP 和 `_test` 数据库验证事件、快照、Match 投影、Game、ResultRevision 和审计同事务提交；
8. 作废后可继续正常计分，刷新及另一观察设备看到一致状态；
9. 浏览器不残留已作废的特殊结果标签、胜方或错误提交状态。

至少覆盖 `RET/WO/DSQ/ABANDONED/BYE` 的输入边界。不要自行增加未经规则确认的“所有类型都必须有胜方”等限制。

报告列出恢复前后完整状态摘要，并单独给出 S2-009 结论。

### 场地图与写入安全

检查 `court-view-model`、`court-console`、`scoring-workbench` 及真实 HTTP 链：

- 四格只投影权威 `logicalCourts`、`physicalEnds`、发接发身份和比分，不复制另一套轮转算法；
- 正常/翻转视角下物理端、逻辑区、队伍和球员映射正确；
- 本机翻转不产生服务端命令，不改变版本或事件；
- 物理换边移动双方在画面中的位置，但比分仍绑定原 A/B；
- 单打不提供任意左右换位；双打手动换位只交换目标方 R/L；
- 减分只打开服务器预览，不能直接执行 `score - 1`；
- `+1`、撤销、更正、特殊结果、提交和复核在服务器确认前不得乐观改变权威画面；
- 断网、版本冲突、`UNKNOWN`、租约失效和裁判长接管期间停止写入；
- 原 `commandId` 对账不能生成新 ID 重复提交；
- 所有写入仍经过会话、赛事角色、具体指派、租约、代次、幂等、预期版本、纯引擎、事件/快照/投影/审计事务；
- 只具有 ADMIN、未指派裁判或只知道 URL 的用户不能写分；
- 测试故障注入只在显式开关和 `_test` 数据库下可用，生产配置必须拒绝。

至少独立复现单打 0:0、1:0、1:1、1:2 的发接发位置，以及双打 A、A、B、B、A、A 黄金轨迹。每一步同时核对纯引擎、数据库权威状态和浏览器四格，不接受只验最终比分。

### 裁判端异步和边界状态

分别制造并检查：

- 初次加载；
- 初次请求 403、404、500 和真实网络失败；
- 有旧快照时后台刷新失败；
- 离线、降级、数据过期、版本冲突、响应未知和失去控制；
- 提交中重复点击、快速双击、touch 后紧接 click、Enter 连按和弹层提交中关闭；
- 双击取得控制或裁判长接管时的并发及响应乱序；
- 损坏或过期的 sessionStorage/localStorage 控制信息；
- 空历史、长姓名、单双打、开局草稿、局间设置、特殊结果待提交、已提交和已确认。

网络失败、权限失败和服务错误不能全部映射成“离线”；初次失败不能永远显示加载骨架。保留旧数据时必须明确标记可能过期，不能清空比分。

## 审查 UI-01-B 隔离预览

### 文件和运行边界

通过 `git diff b29e0f8` 找出全部 UI-01-B 文件，不只检查预期目录。重点检查：

- `/public/preview/[tournamentSlug]/schedule`
- `/public/preview/[tournamentSlug]/matches/[matchCode]`
- 预览门禁、fixture、模型、query 解析、格式化、页面组件和 CSS
- 共享按钮、资源状态、状态标签、主导航、根布局和全局样式
- 新增或修改的 Vitest、Playwright、配置和文档。

必须验证：

1. 非生产环境仍需显式 `ENABLE_PUBLIC_UI_PREVIEW=true` 才能访问；关闭时返回 404；
2. **生产配置能够正常启动；即使 `ENABLE_PUBLIC_UI_PREVIEW=true`，两个预览路由仍必须返回 404。不得把“整站拒绝启动”写成该门禁的期望行为；**
3. 页面有 `noindex,nofollow`；
4. 预览不加入正式导航，不替换现有 `/public`；
5. 全部页面首屏和详情页始终可见“模拟数据／界面预览”；
6. fixture 全为虚构内容，不含真实学生、参考站赛事数据、学校标识、人物照片或受版权保护素材；
7. 不读取数据库、种子、认证会话、裁判状态 API 或生产配置；
8. 浏览器网络记录中没有 `/api/matches/*/state`、控制、命令、预览或其他写请求；
9. 浏览预览前后测试库表计数不变；
10. 正式 `/public`、登录、管理端和裁判端原入口没有被预览路由或导航重定向。

如果预览包含当前领域尚不存在的目标态，例如 `CANCELLED`，必须只存在于明确隔离的预览模型和虚构数据中，不能伪装成当前真实领域能力，也不能进入正式状态映射。

### 路由、筛选与详情

逐项实际操作：

- 正常 fixture slug 可以访问；错误 slug 和跨赛事比赛编号统一公开 404；
- `date/competition/stage/court/lifecycle/verification/outcome/q` 可分享并在刷新后恢复；
- 多值状态去重、稳定排序，维度内 OR、维度间 AND；
- 切换日期不暗中清除其他筛选；
- 未知、过长和无效 query 不崩溃、不注入 HTML，且给出明确处理提示；
- 搜索只匹配 fixture 公开字段；
- 清除单项和清除全部行为可预测；
- 从赛程进入详情再返回，原 query 完整恢复；
- 不使用未校验的任意 `returnTo` 外部地址；
- A/B 次序不因领先、胜负、特殊结局或筛选而交换；
- 列表只按 `scheduleOrder` 排序，状态变化不让卡片跳位；
- 双打两名成员和长姓名完整可读；
- 单局、三局及其他模拟局数按数据动态生成；
- 未进行局为“—／未进行”，已开始的真实 0:0 与未开始局可区分；
- 特殊结局保留已发生比分，不补造满分；
- 比赛进度、结果有效性、异常结局和公开更正状态分开显示；
- 未锁定或更正中的结果不显示成正式晋级依据；
- 时间明确区分固定、预计、延后、前序比赛后和待定；
- 所有时间按赛事时区显示，不随浏览器设备时区悄悄换日。

页面不得自行计算排名、晋级、正式胜方或另一套竞赛规则。模拟 DTO 可直接提供总局分、胜方和状态，但展示组件不能从比分重新推导权威业务结论。

### 加载、错误和边界状态

通过确定性 scenario、组件测试或独立请求逐项检查：

| 状态 | 期望 |
|---|---|
| 初次加载 | 有加载语义，不先闪“无赛程” |
| 当日无赛程 | 与筛选无结果明确区分 |
| 无筛选结果 | 保留所选条件，提供清除入口 |
| 首次加载失败 | 显示失败和重试，不伪装为空列表 |
| 有旧数据时失败 | 保留旧数据，显示“数据可能过期”和最后成功同步时间 |
| 数据过期 | 文字常驻，不只用颜色 |
| 详情不存在 | 公开 404，可返回赛程且不泄露其他 fixture |
| 缺少场地/时间/对手 | 显示“待定”，不伪造名称或比分 |
| 未开放导航 | 不可点击，明确“暂未开放”，不创建假成功页面 |

若 `loading/error/stale` 只是 URL 切换出来的静态外观，报告必须写“确定性界面场景”，不能称为真实网络恢复已经实现。

## 审查组件和 Props

列出本轮新增及被修改组件的公开 Props，并画出两条调用路径：

```text
裁判端 UI → 受保护命令/预览 API → 授权与租约 → 规则引擎 → 事务 → 权威状态
公开预览路由 → 环境门禁 → fixture/query 适配器 → 只读展示组件
```

必须确认两条路径没有交叉使用受保护数据或写能力：

- 公开组件只消费显式公开 DTO，不接收 Prisma 对象、`MatchState`、租约、token、事件或审计记录；
- 公开组件没有加分、更正、提交、接管等写回调 Props；
- 裁判端可以共享按钮、标签、提示框和基础视觉 token，但不能共享公开 fixture 或查询状态；
- 共享按钮、资源状态和状态标签保持原生属性、disabled、loading、错误和读屏语义；
- Props 不使用 `any`，不存在互相矛盾的布尔组合或无法到达的状态；
- 弹层状态、请求状态和资源状态的分支顺序不会让错误退回加载态；
- 关闭弹层后迟到响应不能写回已关闭场景；
- server/client component 边界合理，没有把服务端秘密或大对象序列化进浏览器；
- CSS Module 或严格前缀阻止公开样式覆盖 `.scoring-*`、`.court-*` 等裁判端样式；
- 修改根布局、主导航、页脚、全局焦点或状态标签时，必须回归首页、登录、管理、公开骨架和裁判页面；
- `next-env.d.ts`、生成类型和截图文件等机械变化必须有明确来源，不能混入无解释的手工改动。

组件体积大本身不自动构成缺陷；只有形成不可测试状态、冲突 Props、跨权限边界或真实回归风险时才报告问题。

## 无障碍验收

使用真实 Chromium 和键盘完成，不只静态查看 JSX：

- 跳到主内容链接可见、可操作，目标唯一；
- 主导航和公开二级导航有正确名称及 `aria-current`；
- 五个公开导航入口齐全，未开放入口不是可点击假链接；
- 所有筛选、搜索、按钮和关闭操作有可见 label；
- 赛程表具有正确表头关系；移动卡片仍有可理解的比赛名称和双方结构；
- 状态、A/B、发球/接发、连接、控制权、正式性和异常结局不只依赖颜色；
- `loading` 使用适当的 busy/status 语义，错误使用 alert，普通成功或过期提示不反复打断读屏；
- 自动更新、比分变化和倒计时不会每秒制造无意义 live-region 播报；
- 弹层初始焦点、Tab/Shift+Tab 圈定、Escape 关闭和焦点返回正确；
- disabled 操作旁有持续可见原因，不依赖无法聚焦的按钮解释；
- 全局与组件 `:focus-visible` 在浅色、深蓝和球场绿背景上都清楚；
- 200% 字体和 400% 页面缩放下，无关键信息、确认按钮或错误提示丢失；
- `prefers-reduced-motion`、`prefers-reduced-transparency` 和高对比偏好下仍可操作；
- 实测文字、图标、焦点和控件边界颜色对比并报告数值；未测项目不得声称符合 WCAG。

## 响应式和截图证据

独立检查以下 Chromium 模拟视口：

| 页面 | 视口 |
|---|---|
| 公开每日赛程 | 375×812、390×844、768×1024、1024×768、1440×900 |
| 公开比赛详情 | 390×844、768×1024、1440×900 |
| 单打裁判工作台 | 375×812、390×844、1024×768 |
| 双打裁判工作台 | 390×844、1024×768 |
| 关键页面放大 | 200% 字体和 400% 页面缩放 |

每个视口至少检查：

- `document.documentElement.scrollWidth <= clientWidth`；
- 日期带或必要宽表只在有提示的局部容器滚动；
- 双打成员、长姓名、比分、状态、按钮和错误不裁切；
- 触控目标边界盒达到项目目标；
- 手机首屏没有被宣传图或装饰素材挤掉比赛信息；
- 768 宽度不存在桌面和手机规则同时生效造成的断点冲突；
- 1024 与 1440 不过度拉伸数据表或场地图；
- 软键盘或窄高视口下弹层确认按钮仍可达。

截图保存到系统临时证据目录，不写入仓库。文件名包含页面、状态、视口和浏览器。对每张截图记录：

- 实际 URL；
- 捕获时间与时区；
- 浏览器及版本；
- 视口和设备缩放；
- SHA-256；
- 模拟数据／真实测试库数据；
- 可证明的结论；
- 不能证明的事项。

已有 `artifacts/phase3-browser-simulated/` 和 `artifacts/ui-01/` 只能用于对照。若完整 E2E 在临时副本重新生成截图，应比较哈希或像素差异，并解释共享导航、字体或布局变化；不得静默覆盖旧证据后声称是同一轮证据。

所有截图必须称为“Chromium 浏览器模拟视口”，不得写成真机验收。

## 检查测试是否被削弱

分别比较阶段 3 基线和 UI-01-B 基线：

```bash
git diff c9e6b00 b29e0f8 -- tests vitest.config.ts playwright.config.ts package.json pnpm-lock.yaml
git diff b29e0f8 -- tests vitest.config.ts playwright.config.ts package.json pnpm-lock.yaml
git diff --stat c9e6b00 b29e0f8 -- tests
git diff --stat b29e0f8 -- tests
rg -n "\.(skip|only|todo|fixme)\b|\b(xit|xdescribe)\b" tests vitest.config.ts playwright.config.ts
```

逐项回答：

- 是否删除、重命名后遗漏或合并掉既有用例；
- 是否把精确状态/数据库断言弱化为只看状态码、元素存在、`toBeTruthy` 或宽泛快照；
- 是否减少黄金轨迹、并发次数、错误分支或数据库零写入断言；
- 是否增加 skip、only、todo、fixme、条件早退、重试掩盖或配置 exclude；
- 是否修改脚本、数据库保护、浏览器配置或生产门禁来避开失败；
- UI-01-B 的 query、fixture、路由门禁、详情 404、响应式和状态测试是否真正被收集；
- 是否有“测试名写了安全行为，但断言没有覆盖该行为”的情况；
- Playwright 是否会覆写已跟踪证据，且该副作用是否被明确记录。

报告列出基线测试文件、当前测试文件、实际收集、通过、失败、跳过和未收集数量。发现测试削弱时严重程度至少为 P1；即使测试全绿也不得判定通过。

## 执行独立探针和完整门禁

先只打印测试数据库名，不输出完整 URL：

```bash
pnpm exec dotenv -e .env.test -- node -e \
  'const u=new URL(process.env.DATABASE_URL); console.log(decodeURIComponent(u.pathname.slice(1)))'
```

数据库名不是 `_test` 时立即停止所有数据库写测试，并把相关部分写为“阻断／未测试”。

在临时工作副本中执行，记录每条命令的开始时间、结束时间、耗时、退出码、通过/失败/跳过数和日志路径：

```bash
pnpm install --frozen-lockfile
pnpm run db:test:prepare
pnpm exec dotenv -e .env.test -- pnpm exec vitest run \
  tests/domain/match-engine.test.ts \
  tests/ui/court-view-model.test.ts \
  tests/server/scoring-command-schema.test.ts
pnpm exec dotenv -e .env.test -- pnpm exec vitest run tests/integration/phase-3-scoring.test.ts
pnpm test
pnpm run test:e2e
pnpm run lint
pnpm run typecheck
pnpm exec dotenv -e .env.test -- pnpm run build
pnpm run test:production-startup-security
node --test tests/sync-knowledge-base.test.mjs
pnpm run docs:sync:dry-run
```

若 UI-01-B 新增了未包含在上述定向命令中的测试，先通过 `rg --files tests` 找出并追加实际路径；不得猜测文件名。

Codex 自测数字暂不在本提示词中硬编码。以项目最终测试记录为准，并由 Claude 重新执行。报告使用以下对照表：

| 门禁 | Codex 最终记录 | Claude 本轮实际结果 | 结论 |
|---|---|---|---|
| 定向测试 | 以文档最终记录为准 | 实际数字 | 一致／不一致／未执行 |
| 全量 Vitest | 以文档最终记录为准 | 实际数字 | 一致／不一致／未执行 |
| Playwright | 以文档最终记录为准 | 实际数字 | 一致／不一致／未执行 |
| lint/typecheck/build | 以文档最终记录为准 | 实际退出码 | 一致／不一致／未执行 |
| 生产启动安全 | 以文档最终记录为准 | 实际数字 | 一致／不一致／未执行 |
| 同步脚本 | 以文档最终记录为准 | 实际数字 | 一致／不一致／未执行 |

UI-01-B 新增用例会使总数增加，不能为了对齐旧数字而排除新测试。若项目文档中的命令和记录数字无法互相复现，应单列为可复现性问题。

### 独立数据库和浏览器探针

既有测试之外，至少自行编写临时探针验证：

- S2-008 的 `FULFILL/KEEP_PENDING`；
- S2-009 从多种前状态精确恢复；
- 旧版本响应不能覆盖新权威状态；
- 初次 500 与有旧数据时刷新失败的不同表现；
- 预览开关关闭时 404；
- 生产正常启动，预览开关为 true 时两个预览路由仍为 404；
- 预览浏览前后数据库计数不变；
- 公开预览没有受保护 API 或写请求；
- 无效 query、长搜索、错误 slug、详情 404；
- 筛选刷新恢复和详情返回；
- 动态局数、长双打姓名和三维状态。

临时探针可以导入产品公开导出，但不得导入或照抄现有测试 helper。探针文件、日志和截图全部留在系统临时目录。

测试数据库在探针前后分别记录以下动态表计数：

- `sessions`
- `scoring_sessions`
- `audit_logs`
- `match_events`
- `match_snapshots`
- `result_revisions`

同时记录受测比赛的版本、Game 投影和结果状态。不要手工清理后只报告零残留；若测试套件按设计自行清理，应展示前后值。固定 seed 不算运行残留。

停止所有临时服务后，检查监听端口、Chromium 进程、临时账号/角色和探针。源仓库 Git 状态必须与开始时一致。

## 联合隔离门禁

以下任一项成立，UI-01-B 至少判为“不通过”：

- 生产模式下预览路由可访问；
- 预览未显著标记模拟数据；
- 预览替换现有 `/public` 或进入正式导航；
- 预览读取真实数据库、裁判状态接口、会话、租约、命令或审计；
- 公开组件获得写回调或控制 token；
- UI-01-B 修改规则引擎、计分服务、数据库 schema、seed 或受保护授权逻辑；
- 公开样式造成裁判工作台关键操作、焦点或响应式回归；
- 使用真实学生、参考站赛事数据、官方标识或未授权人物素材；
- 未开放的对阵、排名、最终名次或成绩册具有可点击假成功；
- 为展示效果新增随机比分、假实时或前端排名算法；
- 静默覆盖阶段 3 既有截图证据；
- 为通过新测试而删除、跳过或弱化阶段 3 测试。

共享基础按钮、状态标签、焦点样式和布局 token 本身不是越界，但必须有阶段 3 回归证据。

## 最终报告格式

只在回复中输出报告，不写仓库。使用以下结构：

1. 审查时间、分支、四个完整 SHA、当前 HEAD、工作树状态和临时副本路径；
2. 独立性声明：未改源码、测试、配置、文档、截图或 Vault；
3. 审查范围与差异分类；
4. Codex 最终自测记录与 Claude 独立结果对照；
5. 测试完整性审计；
6. S2-008 独立复验结论；
7. S2-009 独立复验结论；
8. 裁判工作台规则、权限、事务、恢复、组件和浏览器结论；
9. UI-01-B 门禁、路由、筛选、详情、状态、组件和隔离结论；
10. 无障碍、响应式及独立截图证据；
11. 测试数据库前后计数、残留、端口和进程；
12. 未测试／无法确认边界；
13. 发现清单；
14. 四项分结论与联合总判定。

### 证据链格式

每项关键结论必须形成 Evidence → Finding → Path：

```markdown
### E-001｜证据标题

- 时间：
- 类型：command / file / browser / screenshot / database / network
- 来源：命令、URL 或文件:行号
- SHA-256：文件证据填写，否则 n/a
- 复现命令：
- 脱敏原始结果：
```

```markdown
### F-001｜发现标题

- 严重程度：P0 / P1 / P2 / P3 / 信息
- 状态：已复现 / 静态确认 / 无法复现 / 无法确认
- 证据：E-001、E-002
- 位置：
- 期望：
- 实际：
- 影响：
- 最小修复建议：
- 回归建议：
```

至少给出两条 Path：

```markdown
### P-001｜裁判写入调用路径

- 起点：裁判工作台操作
- 终点：权威状态刷新
- 步骤：UI → API → 授权/租约/幂等/版本 → 规则引擎 → 事务 → 权威读取
- 关联证据：
- 剩余风险：
```

```markdown
### P-002｜公开预览只读路径

- 起点：预览 URL
- 终点：只读页面渲染
- 步骤：环境门禁 → fixture/query 适配器 → 展示组件
- 关联证据：
- 必须不存在：数据库、受保护状态 API、写接口和认证数据
```

### 严重程度与总判定

- P0：数据破坏、越权、敏感信息泄露或比分归属错误；
- P1：规则、事务、幂等、租约、生产门禁、公开/裁判隔离或测试完整性失效；
- P2：验收要求中的核心交互、错误状态、无障碍或响应式不可用；
- P3：不影响规则、安全和主要任务完成的局部文案或视觉问题。

总判定规则：

- **通过**：两个工作线的所有适用检查完成，无 P0—P2，测试和浏览器证据完整；
- **有条件通过**：仅剩边界明确的 P3，且正式规则采纳、真机、真人裁判、生产部署等人工门禁仍被明确列为未测试；
- **不通过**：存在任一 P0—P2、测试被削弱、关键链路无法独立复现却仍声称通过，或两条工作线发生权限/状态/证据覆盖；
- **无法确认**：环境或必要证据缺失，无法完成关键运行检查。

无论自动化结果如何，以下边界除非本轮取得真实证据，否则必须继续写“未测试／待核验”：

- 正式 BWF 规则被本赛事采用；
- 真人裁判完整执裁；
- 真实 iPhone、Android 和平板；
- 生产部署、HTTPS、真实公网负载与长期运行；
- 真实赛事姓名和代表队公开授权；
- UI-01-C 的真实公开赛程接口；
- 排名、晋级、最终名次和正式成绩册；
- 独立辅助技术用户测试。

不要使用“看起来正确”“现有测试覆盖”“开发者已验证”作为结论。每项通过都必须能回到本轮独立取得的命令、数据库、浏览器或截图证据。

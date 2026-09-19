---
title: 阶段 1 Claude 独立审查报告
stage: 1
status: current
updated: 2026-09-18
tags:
  - 羽毛球赛事管理系统
  - 审查报告
  - 测试验收
---

# 阶段 1 Claude 独立审查报告

> 本文件按轮次追加。不覆盖历史结论，不代表 Codex 修改任务完成状态。
> 本轮为独立代码审查，只读源码、运行既有构建与测试、在隔离测试库取证，未修改任何业务源码、测试、依赖、锁文件、迁移或环境配置。

---

## 第 1 轮 · 2026-09-18 · Claude 独立审查

### 一、基线与范围

| 项 | 值 |
|---|---|
| 仓库路径 | `/Users/Shared/Files From d.localized/校园羽毛球赛事编排与成绩管理系统` |
| 分支 | `main` |
| 基线 commit | `781906baded04957f4aabd12937bf98192ca3899`（`feat: add phase 1 application and permissions`） |
| 审查开始时 Git 状态 | 干净：无暂存、无未暂存、无未跟踪源码文件；`git stash list` 为空 |
| 审查依据 | `AGENTS.md`、`README.md`、`/Users/a10954/Downloads/prompt-kit/01-总控与初始化.md`、`prompt-kit/02-工程骨架与权限.md`、`docs/knowledge-base/` 全部 30 份文档、`package.json`、`pnpm-lock.yaml`、`prisma/`、`src/`、`tests/`、`scripts/` |
| 环境 | macOS 27.0 / Apple Silicon；系统 Node 26.0.0；pnpm 11.9.0 固定项目 Node 24.21.0；PostgreSQL 15.18（本机 5432） |

基线限制：本轮没有独立的「阶段 1 起点」提交，`git diff` 为空。因此审查对象是**当前完整工程**，而不是单次提交的增量。

#### 依据缺失与文档冲突（不自行编造）

1. **`CLAUDE.md` 在本轮审查开始时不存在**；仓库只有 `AGENTS.md`。本轮按 `/init` 要求新建了 `CLAUDE.md`，未改动 `AGENTS.md`。
2. **`prompt-kit/` 不在仓库内**，实际位于 `/Users/a10954/Downloads/prompt-kit/`（另有一份在 `~/.Trash/`，未读取）。
3. **Obsidian 目标路径：已由用户当场确认，实现正确。** 本轮任务书与 `prompt-kit/01` 写的是 `…/Obsidian Vault/**项目**/羽毛球赛事管理系统`，而 `AGENTS.md`、`README.md` 与 `scripts/sync-knowledge-base.mjs:29` 实现的唯一允许目标是 `…/Obsidian Vault/羽毛球赛事管理系统`。磁盘核对结果为后者存在、前者不存在；**用户已确认后者才是真实 Vault 位置**。因此这不是实现缺陷，而是 `prompt-kit/01` 的路径已过时，见 S1-007。

#### 本轮不作为失败项处理

双打逐分计算、自动换位、抛硬币、完整裁判界面、赛事编排、成绩册均按阶段 2—8 处理，标记「不适用」。已单独检查现有数据结构与权限基础是否与这些已知需求冲突，结论见第五节。

---

### 二、实际执行的命令与结果

所有数据库写入均发生在隔离测试库 `badminton_tournament_test`。开发库 `badminton_tournament_dev` 与本机其他数据库全程只读，未被触碰。

| # | 命令 | 退出码 | 真实结果 | 状态 |
|---|---|---|---|---|
| 1 | `pnpm run lint` | 0 | ESLint 无输出、无错误无警告 | 通过 |
| 2 | `pnpm run typecheck` | 0 | `tsc --noEmit` 无错误 | 通过 |
| 3 | `pnpm test` | 0 | `Test Files 5 passed (5)`、`Tests 12 passed (12)`，耗时 251ms；先执行 `db:test:prepare`，确认库名 `badminton_tournament_test`，`No pending migrations to apply`，种子输出「1 场单打、1 场双打、6 名匿名选手、2 个本地测试身份」 | 通过 |
| 4 | `pnpm run test:e2e` | 0 | `5 passed (5.1s)`，Chromium 全部实际运行，无 skip | 通过 |
| 5 | `pnpm run build` | 0 | Next.js 16.3.5 Turbopack 编译成功，TypeScript 通过，路由表含 4 个 `ƒ` 动态 API 与 5 个页面 | 通过 |
| 6 | `node --test tests/sync-knowledge-base.test.mjs` | 0 | `pass 10 / fail 0 / skipped 0 / todo 0` | 通过 |
| 7 | `pnpm run docs:sync:dry-run` | 0 | `SUMMARY create=0 update=0 unchanged=30 stale=0 conflict=0`，零写入 | 通过 |
| 8 | `pnpm run db:test:prepare`（连续第二次） | 0 | 种子前后计数完全一致（见下） | 通过 |
| 9 | 隔离测试库约束探针（8 条负向 SQL，全部 `ROLLBACK`/被拒） | — | 8/8 被数据库拒绝，无残留 | 通过 |
| 10 | 隔离测试服务器 HTTP 权限探针（16 次请求） | — | 见第四节 | 通过/见缺陷 |
| 11 | 三视口浏览器检查（375×812 / 768×1024 / 桌面） | — | 登录页、首页、公开查询无横向溢出，导航可读 | 通过（模拟视口） |

#### 种子幂等实测

连续两次 `db:test:prepare` 前后计数：

`users=2 / participants=6 / entries=4 / entry_members=6 / matches=2 / games=2 / official_assignments=1 / role_assignments=2 / rule_profile_revisions=1`

两次完全相同，**未产生重复记录**。

#### 未验证 / 不适用项

| 项 | 状态 | 原因 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 未验证 | 本轮禁止改动依赖与锁文件，未实际安装。已做静态核对：`package.json` 的 23 个依赖 specifier 与 `pnpm-lock.yaml` importers 完全一致，`lockfileVersion: '9.0'` |
| 真实手机 / 平板 / 局域网实机 / 防火墙 | 未验证 | 本会话无真实移动设备。模拟视口结果**不能**称为真机验收 |
| 登录后页面在手机、平板视口的目视核对 | 未验证 | 按操作边界未向浏览器输入演示口令；仅通过 curl 会话验证了后端授权链。Playwright 已在桌面视口完成真实登录流程 |
| `NODE_ENV=production` 实际启动、生产部署、HTTPS、备份恢复 | 未验证 | 需部署环境；`assertRuntimeSecurity` 的生产分支只在 Vitest 中以模拟环境变量覆盖 |
| `docs:sync --apply` 写入真实 Vault | 未执行 | 本轮未获得写入 Vault 的明确授权，见第六节 |
| 逐分记分 API、幂等 `commandId`、`expectedVersion` 冲突、租约心跳、多设备接管 | 不适用（阶段 2/3） | 接口尚不存在 |
| 抛硬币、自动换位、换边、撤销、编排、成绩册 | 不适用（阶段 2—8） | 按任务书不计入本轮 |

---

### 三、数据模型与持久化核查

#### 隔离确认（先做，再写入）

- `scripts/prepare-test-database.ts:22` 在任何操作前调用 `assertTestDatabaseUrl`，库名不以 `_test` 结尾直接抛错。
- 该脚本**只会 `create database`，没有任何 `drop`/`truncate`/`delete` 语义**；`prisma/seed.ts` 全部使用 `upsert`，且 `ensureEntry` 发现多余成员时抛错中止而不是删除（`prisma/seed.ts:50-52`）。
- `.env.test` 解析结果为 `postgresql://…/badminton_tournament_test`，与开发库 `badminton_tournament_dev` 分离；本机另有 `pazhou_service`、`tianhe`、`wenqixing` 等无关数据库，本轮全程未连接。
- 结论：隔离已确认，可以安全写入。

#### 数据库级不变量实测（隔离库，全部回滚/被拒，零残留）

| 探针 | 期望 | 实测 |
|---|---|---|
| 双打组合只放 1 名成员 | 拒绝 | ✅ `entry % requires 2 distinct member(s), found 1`（延迟约束触发器） |
| 双打组合放 0 名成员 | 拒绝 | ✅ `requires 2 distinct member(s), found 0` |
| 双打组合放同一人两次 | 拒绝 | ✅ `entry_members_entryId_participantId_key` 唯一约束 |
| 双打组合放 3 名成员 | 拒绝 | ✅ `entry_members_slot_check`（slot 只允许 1、2） |
| 单打组合放 2 名成员 | 拒绝 | ✅ `requires 1 distinct member(s), found 2` |
| `games.scoreA = -1` | 拒绝 | ✅ `games_nonnegative_scores_check` |
| `sideBEntryId := sideAEntryId` | 拒绝 | ✅ `matches_distinct_sides_check` |
| 同场第二个 `ACTIVE` 控制会话 | 拒绝 | ✅ `scoring_sessions_one_active_per_match` 部分唯一索引 |

探针结束后复查：`entries` 无 `PROBE-%` 残留，`games` 比分仍为 0/0，`matches` 的 A/B 仍不相等，`scoring_sessions` 为 0。**这些不变量由数据库本身执行，不依赖表单校验。**

#### 与阶段 1 实体清单的对应

`prisma/schema.prisma` 覆盖 `User / Tournament / Competition / Participant / Entry / EntryMember / Stage / Group / Court / Match / Game / RuleProfile(+Revision) / MatchEvent / ScoringSession / ResultRevision / AuditLog`，另有 Better Auth 所需的 `Session / Account / Verification` 与 `RoleAssignment / OfficialAssignment / MatchRuleSnapshot`。没有为远期功能建空表。

- **个人与参赛组合分离**：`Participant` ↔ `Entry` 经 `EntryMember` 多对多，✅。
- **比赛支持单双打**：`Competition.entryType`、`Entry.entryType` 两级 `SINGLES/DOUBLES`，种子同时生成 `MS-DEMO-001`（单）与 `MD-DEMO-001`（双），✅。
- **A/B 身份不绑定物理场地端**：`Match` 只有 `sideAEntryId / sideBEntryId` 与可空 `courtId`，schema 中**不存在**任何把 A/B 与场地端耦合的字段；`Game.scoreA/scoreB` 归属一方而非单个球员，✅ 与「双打比分属于一方组合」一致。
- **版本与关联**：`RuleProfileRevision.revision`（`> 0` CHECK）、`MatchRuleSnapshot.configHash`、`MatchEvent.version` + `@@unique([matchId, version])` + `commandId @unique`、`ResultRevision.revision`、`Match.version`（`>= 0` CHECK），✅ 为阶段 2/3 的幂等与乐观并发预留了正确的键。
- **持久化而非本地存储**：全仓库 `grep localStorage|sessionStorage` **零命中**；无写死比赛数组。停止并重启服务器两次后，公开数据与指派仍从数据库读回，✅。

---

### 四、真实登录与服务端权限核查（最高优先级）

所有用例均在隔离测试服务器（`dotenv -e .env.test -- next dev`，绑定 `127.0.0.1`）的**真实 HTTP 入口**执行，而不是只看前端是否隐藏按钮。

| # | 用例 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | 未登录 `GET /management`、`/officiating`、`/settings` | 不泄露数据 | 三者均 `307 → /login?next=…` | ✅ |
| 2 | 未登录 `POST /api/matches/MS-DEMO-001/control` | 拒绝 | `401 {"code":"unauthenticated","message":"请先登录后再操作。"}` | ✅ |
| 3 | 伪造 `better-auth.session_token` cookie | 拒绝 | `401 unauthenticated` | ✅ |
| 4 | 管理员（有 ADMIN 角色、无 REFEREE 角色）取控制权 | 拒绝 | `403 forbidden 你没有该赛事范围内的权限。` | ✅ |
| 5 | 裁判操作**未指派**给自己的 `MD-DEMO-001` | 拒绝 | `403 not_assigned 你没有被指派执裁这场比赛。` | ✅ |
| 6 | 裁判操作**已指派**的 `MS-DEMO-001` | 允许 | `201 {"status":"acquired","takeoverGeneration":1}` | ✅ 正向用例 |
| 7 | 改比赛 ID 绕过（`NO-SUCH-MATCH`） | 拒绝 | `404 match_not_found` | ✅ |
| 8 | 请求体自带 `userId` / `role` 伪装成裁判 | 忽略客户端声明 | 仍按会话身份判定，`403 forbidden` | ✅ 未信任客户端提交的身份 |
| 9 | 账号被置为 `DISABLED` 后继续用旧 cookie | 拒绝 | `403 account_disabled 账号不存在或已停用。` | ✅（随即恢复为 ACTIVE） |
| 10 | 注销后复用同一 cookie | 会话失效 | `sign-out 200` → 数据库 `sessions` 由 1 变 0 → 再次请求 `401`，页面 `307` | ✅ |
| 11 | 公开接口读取 `DRAFT` 赛事 | 不泄露 | `404 公开赛事不存在或尚未发布。` | ✅ |
| 12 | 公开接口读取 `ARCHIVED` 赛事 | 不泄露 | `404` | ✅ |
| 13 | 公开接口返回体字段 | 无敏感字段 | 仅 slug/name/timezone/status/项目/阶段/比赛/场地/对阵/比分；无 email、内部 UUID、token、审计字段 | ✅ |
| 14 | **公众自助注册（用仓库自带 `.env.test`）** | 应关闭 | **`200`，成功创建账号并返回会话 token** | ❌ 见 S1-001 |
| 15 | 裁判访问 `/management` | 403 + 中文提示 | **HTTP `500`**（渲染错误页） | ❌ 见 S1-002 |
| 16 | 被拒绝请求后的数据库副作用 | 无写入 | `scoring_sessions` 未增加；`audit_logs` 无新增行 | ✅ 无写入，但见 S1-005 |

> 更正：审查过程中第一次测试注销时得到 `403`，经复查是我的探针服务器端口（3110）与 `.env.test` 中 `BETTER_AUTH_URL`（3100）不一致导致的来源校验失败，属探针配置问题，**不是产品缺陷**。在端口对齐后复测，注销行为完全正确（用例 10）。

#### 未越权的证据强度说明

用例 4/5/7/8 都在拒绝后复查了数据库，确认 `scoring_sessions`、`audit_logs`、`sessions` 均无新增，不是只看返回码。

---

### 五、与后续阶段已知需求的冲突检查

| 已知需求（阶段 2—8） | 当前结构是否冲突 | 说明 |
|---|---|---|
| 双打发接发、逻辑左右、物理场地端、屏幕方向分开建模 | **不冲突** | 当前未建这些字段，也没有把 A/B 与场地端耦合；阶段 2 可自由新增 |
| 撤销需恢复关联状态并保留审计 | **不冲突** | `MatchEvent` 追加式事件表 + `@@unique([matchId, version])` 支持确定性重放 |
| 同 `commandId` 幂等、不同内容拒绝 | **不冲突** | `MatchEvent.commandId @unique` 已就位（全局唯一，比按场唯一更严） |
| 乐观并发 | **不冲突** | `Match.version` 已存在且有 `>= 0` 约束 |
| 写入租约 / 心跳 / 接管代号 | **不冲突** | `ScoringSession` 已有 `tokenHash`、`takeoverGeneration`、`expiresAt`、`lastHeartbeatAt` 与「每场唯一 ACTIVE」索引 |
| 结果更正与影响预览 | **不冲突** | `ResultRevision` 有 `revision` / `status` / `reason` |
| 裁判长接管 | **需注意** | `requireAssignedReferee`（`src/server/auth/authorization.ts:49`）硬编码只接受 `REFEREE` 角色，`CHIEF_REFEREE` 会被拒。阶段 3 实现接管时必须一并放开，见 S1-008 |

---

### 六、问题清单

编号稳定，后续轮次沿用。

---

#### S1-001 — 公众自助注册在仓库自带的测试配置下是开着的，而 e2e 用例靠强制覆盖环境变量才通过

- **严重程度：P1**（当前阶段关键验收阻塞）
- **证据状态：运行复现**
- **位置**
  - `src/server/auth/auth.ts:18` — `disableSignUp: process.env.ALLOW_DEMO_ACCOUNTS !== "true"`
  - `.env.test` — `ALLOW_DEMO_ACCOUNTS="true"`（未提交文件，本机实际内容）
  - `playwright.config.ts:16` — `env: { ALLOW_DEMO_ACCOUNTS: "false" }`
  - `tests/e2e/phase-1.spec.ts:43-49` — 「运行中的网页不开放公众注册」
  - `prisma/seed.ts:59-61` — 种子**要求** `ALLOW_DEMO_ACCOUNTS=true` 才能运行
- **对应验收要求**：阶段 1 第 5 条「公开注册关闭；开发账号仅用于本地示例，不在生产启用默认口令」；追踪矩阵 `AUTH-003`（当前记为「已完成」）
- **触发条件**：任何在非 `production` 下把 `ALLOW_DEMO_ACCOUNTS` 置为 `true` 的运行。而创建示例身份的唯一途径 `pnpm run db:seed` 本身就要求置为 `true`。
- **最小复现**
  1. `pnpm exec dotenv -e .env.test -- pnpm exec next dev --hostname 127.0.0.1 --port 3100`
  2. `curl -X POST http://127.0.0.1:3100/api/auth/sign-up/email -H 'content-type: application/json' -d '{"name":"x","email":"x@example.test","password":"SomeLongPassword!2026"}'`
- **预期**：`400/403`，注册关闭。
- **实际**：`200`，返回 `{"token":"…","user":{…}}`，数据库真实新增一名 `ACTIVE` 用户。（该探针账号已由我从测试库删除。）
- **对本项目的影响**：`README` 与 `本地启动与手机访问` 都在推广「局域网手机访问」`0.0.0.0:3000`。只要演示时按文档打开示例账号开关，同一局域网内任何人都能自助注册账号并登录。虽然新账号没有赛事角色、无法执裁（我已验证），但这仍是账号面板被任意写入、与「公开注册关闭」验收项直接矛盾。生产环境被 `assertRuntimeSecurity` 拦住（`src/server/config/runtime.ts:15-19`），所以不定为 P0。
- **同时导致的测试真实性问题**：唯一守护这一条的自动化用例，运行在一个被 `playwright.config.ts` 强制改写过的配置上。它验证的是「如果关掉就关掉了」，而不是「项目实际发布的配置是关的」。
- **最小修复建议**
  1. 把「允许创建示例身份」与「允许公开注册」拆成两个变量；`disableSignUp` 改为恒 `true`，或由独立的 `ALLOW_PUBLIC_SIGNUP`（默认 `false`）控制。
  2. `prisma/seed.ts` 改为不经公开注册端点创建用户（用 Better Auth 的内部/服务端 API 或直接写入密码哈希），解除对开关的依赖。
  3. 删除 `playwright.config.ts` 中的 `env` 覆盖，让 e2e 校验真实配置。
- **建议回归测试**：一条**不覆盖任何环境变量**的用例，在 `ALLOW_DEMO_ACCOUNTS=true` 下断言 `POST /api/auth/sign-up/email` 仍被拒绝。

---

#### S1-002 — 服务端组件里抛 `AppError` 变成 HTTP 500，权限不足与服务故障无法区分

- **严重程度：P2**
- **证据状态：运行复现**
- **位置**
  - `src/app/management/page.tsx:31` — `throw new AppError(403, "forbidden", "你没有赛事管理权限。")`
  - `src/app/officiating/page.tsx:13-14` — 账号停用时由 `requireActiveUser` 抛 `AppError(403)`
  - `src/app/public/page.tsx:7` — `getPublicTournament("phase-1-demo")` 在种子不存在时抛 `AppError(404)`
  - `src/app/error.tsx` — 统一错误边界
- **对应验收要求**：阶段 1 第 6 条「没实现的入口明确标示」与验收行「错误有中文提示」
- **最小复现**：以裁判身份登录后 `curl -b <cookie> -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/management`
- **预期**：`403`，页面明确写「你没有赛事管理权限」。
- **实际**：`500`。服务器日志：`⨯ Error: 你没有赛事管理权限。 at ManagementPage (src/app/management/page.tsx:31:11) { status: 403, code: 'forbidden', digest: '3468659688' }`；浏览器只看到通用的「无法显示此页面 / 可能是权限不足或服务暂时不可用」。账号被停用后访问 `/officiating` 同样是 `500`。
- **对本项目的影响**：访问本身被正确拒绝，不是越权漏洞。但状态码错误会误导监控和后续客户端；而且用户看到的是「权限不足**或**服务暂时不可用」这种二义提示，与项目「不做含糊成功/失败提示」的底线不符。`/public` 在尚未执行种子的干净环境会直接 500，而不是空态。
- **最小修复建议**：页面层不要抛 `AppError`。改为 `import { forbidden, notFound } from "next/navigation"` 并配 `forbidden.tsx` / `not-found.tsx` 中文页；`/public` 捕获 `404` 渲染「暂无已发布赛事」。
- **建议回归测试**：Playwright 断言裁判访问 `/management` 得到 `403` 且页面出现「没有赛事管理权限」；断言公开赛事缺失时 `/public` 返回 `404` 而非 `500`。

---

#### S1-003 — `/api/health` 返回的 `serverTime` 比真实 UTC 快 8 小时，却带 `Z` 后缀

- **严重程度：P2**
- **证据状态：运行复现**
- **位置**：`src/app/api/health/route.ts:9-14`
- **对应验收要求**：阶段 1 第 8 条「健康检查、结构化错误、**服务端时间记录**」；追踪矩阵 `SYS-002`「数据库健康返回服务端时间」
- **最小复现**
  ```
  date -u                       → 2026-09-18T12:09:26Z
  curl -s /api/health           → {"serverTime":"2026-09-18T20:09:26.684Z"}
  ```
- **根因定位**（已分别验证）：裸 `pg` 驱动查询 `select now()` 返回 `2026-09-18T12:09:46.158Z`（**正确**）；经 `prisma.$queryRaw` + `@prisma/adapter-pg` 的同一查询返回 `2026-09-18T20:09:40.908Z`（**错误**）。即适配器把 `timestamptz` 的 Asia/Shanghai 墙钟值当成 UTC 构造了 `Date`。
- **预期**：`serverTime` 等于真实 UTC 时刻。
- **实际**：早 8 小时，且 `Z` 后缀使调用方无从察觉。
- **对本项目的影响**：健康检查是文档里给老师和运维的对时依据，现在给的是错误时间。阶段 3 的租约过期、心跳、接管都依赖服务端时间，若沿用同一取时方式会直接出错。
- **补充（P3 级潜在坑，同源）**：迁移中所有 `createdAt` 列是 `TIMESTAMP(3) ... DEFAULT CURRENT_TIMESTAMP`（`prisma/migrations/20260918113924_phase1_init/migration.sql:45` 等）。实测在隔离库插入并回滚：数据库默认值写入的是**本地墙钟** `2026-09-18 20:10:21.704`，而真实 UTC 为 `12:10:21`。目前所有写入都由 Prisma 客户端提供时间戳，现网数据经核对是正确 UTC（`audit_logs.occurredAt`、`users.createdAt` 均正确），所以**当前无数据损坏**；但任何绕过 Prisma 的写入（原生 SQL、未来触发器）都会产生 8 小时偏差。
- **最小修复建议**：健康检查改为 `select now() at time zone 'utc'` 并显式标注，或直接不经原生 SQL 取时间；同时把数据库会话/容器时区固定为 `UTC`。
- **建议回归测试**：断言 `Math.abs(Date.parse(serverTime) - Date.now()) < 5 * 60 * 1000`。

---

#### S1-004 — 干净检出无法运行 `pnpm test` / `pnpm run test:e2e`：`.env.test` 未提交、无模板、无文档

- **严重程度：P2**
- **证据状态：运行复现**
- **位置**
  - `package.json:24-25` — `test` / `test:e2e` 均以 `dotenv -e .env.test` 开头
  - `.gitignore` — `.env.*` 与显式的 `.env.test` 均被忽略
  - `.env.example` — 只覆盖 `.env`，没有测试库与 `BETTER_AUTH_URL=:3100` 的模板
  - `docs/knowledge-base/07-使用部署/本地启动与手机访问.md` — 只说明 `.env` 与 `.env.seed`，**完全没提 `.env.test`**
- **对应验收要求**：阶段 1 第 9 条「基础脚本包括 dev、build、lint、typecheck、test、test:e2e…真实命令按选型生成并验证」；`README.md` 的「质量命令」段落
- **最小复现**：`pnpm exec dotenv -e .env.does-not-exist -- node -e 'console.log(process.env.DATABASE_URL ?? "(undefined)")'` → `(undefined)`。`dotenv-cli` 对缺失文件**静默通过**，随后 `assertTestDatabaseUrl` 抛「缺少 DATABASE_URL。」
- **预期**：照 `README` 从干净检出走一遍，测试命令可执行。
- **实际**：`pnpm test` 在 `db:test:prepare` 阶段即失败，且错误信息不会提示「你需要先创建 `.env.test`」。
- **对本项目的影响**：本机能跑只是因为 `.env.test` 已存在。换机器、重装或老师复现时，阶段 1 最重要的权限证据链无法重跑。
- **最小修复建议**：新增 `.env.test.example`（含 `DATABASE_URL=…_test`、`BETTER_AUTH_URL=http://127.0.0.1:3100`、`ALLOW_DEMO_ACCOUNTS` 与示例账号变量名，值留空），在 `本地启动与手机访问.md` 和 `README` 的质量命令段写明复制步骤；`prepare-test-database.ts` 在 `DATABASE_URL` 缺失时给出「请先按 .env.test.example 创建 .env.test」的中文提示。
- **建议回归测试**：一条脚本级检查，断言 `.env.test.example` 存在且键集合与 `.env.test` 一致。

---

#### S1-005 — 越权拒绝不写审计；脱敏日志工具 `logServerEvent` 定义后从未被调用

- **严重程度：P2**
- **证据状态：运行复现 + 代码路径已确认**
- **位置**
  - `src/server/logging.ts:13` — `logServerEvent` 全仓库 `grep` **仅此一处定义，零调用点**
  - `src/server/services/errors.ts:13-24` — `errorResponse` 不做任何日志记录，未知错误直接吞掉
  - `src/server/services/scoring-session-service.ts:46` — `auditLog.create` 只在成功路径上
- **对应验收要求**：阶段 1 第 8 条「结构化错误、服务端时间记录和**日志脱敏**」；`API与权限.md`「敏感操作记录实际身份和所用角色」「管理员授予角色、撤销角色和紧急访问也要审计」
- **最小复现**：执行第四节全部 16 条探针（含 6 次 401/403/404 拒绝）与 e2e 全套之后，查询 `select action, outcome, count(*) from audit_logs group by 1,2` → 只有 `SCORING_SESSION_ACQUIRED | SUCCESS | 9`。
- **预期**：拒绝的执裁尝试至少留下一条可审计记录；结构化脱敏日志实际接在请求路径上。
- **实际**：没有任何拒绝被记录；`logServerEvent` 是死代码，`AuditLog.outcome` 字段实际只出现过 `SUCCESS` 一个取值。
- **对本项目的影响**：阶段 1 的定位就是「权限基础」。没有拒绝审计，等于无法回答「谁在什么时候试图操作不属于自己的比赛」——而这正是后续裁判长接管、争议裁决要用的证据。同时未知 500 错误不落任何结构化日志，排障只能靠 Next 的开发期堆栈。
- **最小修复建议**：在 `errorResponse` 中调用 `logServerEvent`（记录 code/status/路由/会话用户 id，敏感字段由现有正则脱敏）；在 `requireAssignedReferee` / `requireTournamentRole` 的拒绝分支写入 `AuditLog`，`outcome` 用 `DENIED`。
- **建议回归测试**：集成用例断言一次 `not_assigned` 拒绝后，`audit_logs` 新增一条 `outcome='DENIED'` 且 `metadata` 中不含 token/密码。

---

#### S1-006 — `tests/e2e/phase-1.spec.ts` 在测试库留下活动控制会话，且断言只看状态码不看数据库

- **严重程度：P3**
- **证据状态：运行复现**
- **位置**：`tests/e2e/phase-1.spec.ts:14-17`（`beforeEach` 清理）与 `:73-77`（最后一条用例取得会话后不清理）
- **对应验收要求**：阶段 1 第 7 条「可重复运行而不复制数据」的配套整洁性；任务书「拒绝请求后确认数据库没有被修改」
- **最小复现**：`pnpm run test:e2e` 结束后 `select count(*) from scoring_sessions` → `1`（该行 `status='ACTIVE'`，2 分钟后才过期）。
- **预期**：套件结束回到干净基线。
- **实际**：残留一条活动会话。本轮由我手工清理。
- **对本项目的影响**：紧接着跑 `pnpm test` 时，Vitest 的「同场只建立一个有效控制会话」用例依赖自身 `afterEach` 清理，目前侥幸不受影响；但残留会话会让人误判「某台设备正在控制这场比赛」，并且随阶段 3 加入接管逻辑后会变成不稳定测试来源。同时，现有拒绝类断言只检查 HTTP 状态码，没有一条断言「拒绝后数据库未被改动」。
- **最小修复建议**：改为 `afterEach` 清理，或在 `afterAll` 统一清空 `scoring_sessions`；为 403 用例补一条数据库副作用断言。

---

#### S1-007 — `prompt-kit/01` 记录的 Vault 路径已过时，与真实位置和实现不一致（已澄清，非实现缺陷）

- **严重程度：P3**
- **证据状态：运行复现 + 用户确认**
- **位置**：`scripts/sync-knowledge-base.mjs:27-32` 与 `:90-94`（`expectedTarget = join(vaultRoot, '羽毛球赛事管理系统')`）；对照 `prompt-kit/01-总控与初始化.md`「只允许在 Vault 中创建和维护这个项目子目录：…/Obsidian Vault/**项目**/羽毛球赛事管理系统」
- **实测**：`ls` 确认磁盘上存在 `…/Obsidian Vault/羽毛球赛事管理系统`（含 00—08 全部目录、30 份 `.md`），`…/Obsidian Vault/项目/…` **不存在**。
- **用户确认（2026-09-18，本轮审查中）**：`…/Obsidian Vault/羽毛球赛事管理系统` 就是真实 Vault 位置。
- **结论**：`scripts/sync-knowledge-base.mjs`、`AGENTS.md`、`README.md` 的路径**是正确的**，无需改动代码。过时的是 `prompt-kit/01` 中的路径约定。原先「阶段 0 路径约定被静默改动」的疑虑已排除。
- **对本项目的影响**：无功能影响。同步脚本把目标锁死在单一目录并逐级拒绝符号链接，已由 10/10 自动化测试覆盖。
- **残留动作（文档级）**：在 `02-架构设计/技术选型与决策.md` 补一条决策记录，写明最终采用的 Vault 目标路径不含「项目」这一级，避免后续按 `prompt-kit` 核对的人再次误判。**不要**改动已发布的 Vault 目录结构。

#### S1-008 — `CHIEF_REFEREE` 角色被授权函数硬拒，与已写好的裁判长接管矩阵冲突

- **严重程度：P3**（阶段 3 前置风险，非当前阻塞）
- **证据状态：代码路径已确认**
- **位置**：`src/server/auth/authorization.ts:49` — `await requireTournamentRole(userId, tournamentId, ["REFEREE"])`
- **对应文档**：`02-架构设计/API与权限.md`「角色权限矩阵补充」「裁判长接管时递增 `takeoverGeneration`；旧设备…要拒绝」
- **触发条件**：把一名 `CHIEF_REFEREE` 指派为某场 `MAIN_REFEREE`（`OfficialAssignment` 允许），其取控制权会得到 `403 forbidden`，即使他确实被指派。
- **对本项目的影响**：阶段 1 没有接管流程，所以现在不构成缺陷。但阶段 3 实现接管时若只改接管入口、不改这里，会出现「裁判长有权接管却拿不到控制会话」的矛盾。
- **最小修复建议**：阶段 3 把允许角色改为 `["REFEREE", "CHIEF_REFEREE"]` 并在事件中区分实际使用的角色；现在只需在 `API与权限.md` 标注这条限制。

---

#### S1-009 — 文档小幅失准：安装命令与「阶段 1 权限测试门禁」范围

- **严重程度：P3**
- **证据状态：代码路径已确认**
- **位置**
  - `docs/knowledge-base/05-测试验收/测试记录.md` 阶段 1 首行记录实际执行的是 `pnpm install --frozen-lockfile=false`，而 `README.md`、`AGENTS.md`、`本地启动与手机访问.md` 给使用者的都是 `pnpm install --frozen-lockfile`。
  - `docs/knowledge-base/02-架构设计/API与权限.md` 末段写「阶段 1 至少覆盖未登录、错误角色、错误比赛、无指派、**过期版本和无效租约**」，但同文件上半部分已正确说明版本/租约属阶段 2/3，当前也确实没有实现。
- **对本项目的影响**：不影响功能。但前者会让复现者以为验证过的就是文档命令（我已静态核对：23 个依赖 specifier 与锁文件一致，`--frozen-lockfile` **很可能**可用，但本轮未实际执行，记为未验证）；后者会让人误判阶段 1 的权限门禁没达标。
- **最小修复建议**：统一安装命令表述并说明当时为何用 `=false`；把「过期版本和无效租约」移到阶段 3 的门禁行。

---

### 七、阶段 1 验收矩阵

| 阶段 1 要求 | 实现位置 | 验证证据 | 状态 |
|---|---|---|---|
| ① 初始化 Next/React/TS + Prisma/PostgreSQL + Vitest + Playwright，版本固定、锁文件 | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`prisma/` | `build`/`lint`/`typecheck`/`test`/`test:e2e` 全 0 退出；`pnpm exec node -v` = v24.21.0；23 个 specifier 与锁文件一致（静态） | **通过**（`--frozen-lockfile` 实际安装未验证） |
| ② 模块化结构 domain/rules、server/services、server/auth、db、ui、reports、tests | `src/domain/rules/`、`src/server/`、`src/db/`、`src/ui/`、`src/reports/`、`tests/` | 目录实际存在；规则只有一份（`rule-profile.ts`），未前后端重复 | **通过** |
| ③ 最小实体与迁移 | `prisma/schema.prisma`、`prisma/migrations/`（2 个） | `migrate deploy` 报告 `No pending migrations`；16 个必需实体全部存在且无远期空表 | **通过** |
| ④ 个人/组合分离、双打恰好两名不同选手、A/B 不绑场地端、比分非负、规则/事件/结果有版本、单双打 | `schema.prisma`、`20260918114000_phase1_constraints/migration.sql` | 8 条负向 SQL 探针全部被**数据库**拒绝，零残留；`Match` 无场地端耦合字段 | **通过** |
| ⑤ 真实认证 + 服务端角色/赛事范围/指派校验；公开注册关闭；生产拒绝示例配置；公开页不泄露 | `src/server/auth/*`、`src/app/api/matches/[matchCode]/control/route.ts`、`src/reports/public-fields.ts`、`src/server/config/runtime.ts` | 权限链 13/13 正向与负向用例通过（含伪造 cookie、改比赛 ID、请求体伪装、停用账号、注销失效、DRAFT/ARCHIVED 不泄露） | **部分不通过 — S1-001**：注册在仓库自带测试配置下是开的，守护用例靠覆写环境变量才过 |
| ⑥ 中文页面框架，未实现入口明确标示，无假成功按钮 | `src/app/{page,management,officiating,public,settings,login}` | 五个页面实际渲染；`/management` 明写「阶段 1 未提供新增、发布或删除按钮」；未发现点击后假装成功的按钮 | **通过**（错误分支状态码见 S1-002） |
| ⑦ 可重复模拟种子：1 单打 + 1 双打 + 匿名选手 + 管理员/裁判身份，重复运行不复制 | `prisma/seed.ts` | 连续两次 `db:test:prepare`，9 张表计数完全一致；全部 `upsert`，无删除语义 | **通过** |
| ⑧ 环境变量示例、健康检查、结构化错误、服务端时间、日志脱敏 | `.env.example`、`api/health/route.ts`、`services/errors.ts`、`server/logging.ts` | 健康检查连通数据库；错误为中文结构化 JSON | **部分不通过 — S1-003**（服务端时间偏 8 小时）、**S1-005**（脱敏日志零调用点） |
| ⑨ 开发/测试库隔离、自动化不指向正式数据、脚本齐全 | `src/db/database-safety.ts`、`scripts/prepare-test-database.ts`、`package.json` scripts | 隔离门禁 3 条测试通过；实测只写 `badminton_tournament_test`，开发库与本机其他库未被触碰；脚本 dev/build/lint/typecheck/test/test:e2e/db:migrate/db:seed/docs:sync(+dry-run) 全部存在且执行真实操作 | **部分不通过 — S1-004**（干净检出跑不起来测试） |
| 验收行：应用能启动 | — | `/api/health` 200；首页 200；重启两次后数据仍在 | **通过** |
| 验收行：刷新保留数据库内容 | — | e2e `page.reload()` 后对阵仍在；服务器重启后数据从库中恢复；无 localStorage | **通过** |
| 验收行：未登录不能写入 | — | `401 unauthenticated`，数据库无副作用 | **通过** |
| 验收行：普通公众不能访问执裁 API | — | 未登录 401；伪造 cookie 401；无角色账号无法取得控制权 | **通过** |
| 验收行：未指派裁判不能操作其他比赛 | — | `403 not_assigned`，改比赛 ID 无法绕过 | **通过** |
| 验收行：错误有中文提示 | — | API 全部中文结构化错误 | **部分不通过 — S1-002**（页面层 403/404 变 500，提示二义） |
| 验收行：测试和生产数据隔离检查通过 | — | 实测通过 | **通过** |
| 文档与 Obsidian：ER/API/技术决策/启动文档/测试记录与阶段状态更新并安全同步 | `docs/knowledge-base/`、`scripts/sync-knowledge-base.mjs` | dry-run `unchanged=30 conflict=0`；同步工具 10/10；测试记录与我复现的结果一致，未把未实现写成已完成 | **通过**（小瑕疵见 S1-007、S1-009） |

---

### 八、总评

**总评：不通过。**

理由：
1. **S1-001 是已确认的 P1，且直接落在阶段 1 验收第 5 条「公开注册关闭」上。** 更严重的是守护它的唯一自动化用例运行在被 `playwright.config.ts` 改写过的配置上，因此追踪矩阵 `AUTH-003` 的「已完成」目前没有有效证据支撑。
2. **S1-004 使阶段 1 最关键的权限证据链在干净检出上不可复现**，不满足「基础脚本…真实命令按选型生成并验证」。
3. S1-002、S1-003、S1-005 各自落在阶段 1 明列的验收条目（中文错误提示、服务端时间记录、日志脱敏）上。

需要强调的是，**这不是一个空壳工程**。数据模型、数据库级不变量、服务端授权链、数据库隔离和文档诚实度都达到了相当高的水准：我用 16 条真实 HTTP 用例和 8 条负向 SQL 探针独立验证，核心权限边界**没有一条被绕过**，拒绝后数据库**没有被改动**，文档也没有把未实现写成已完成。上述 5 个问题都是边界与配套问题，修复量不大。

---

### 九、本轮文件变化

| 文件 | 变化 | 说明 |
|---|---|---|
| `docs/knowledge-base/05-测试验收/阶段1-Claude审查报告.md` | 新增 | 本报告 |
| `CLAUDE.md` | 新增 | 按 `/init` 要求创建；未改动 `AGENTS.md` |

未修改任何业务源码、现有测试、依赖、锁文件、迁移或环境配置；未提交、未推送、未切换分支、未 stash/clean/reset。

测试库 `badminton_tournament_test` 在审查前后均为标准种子基线（`users=2 / participants=6 / entries=4 / entry_members=6 / matches=2 / games=2 / tournaments=1 / official_assignments=1 / scoring_sessions=0 / sessions=0`）；审查过程中产生的探针账号、探针赛事、控制会话与登录会话均已清理。开发库 `badminton_tournament_dev` 与本机其他数据库全程只读。

### 十、Obsidian 同步状态

**已同步（2026-09-18 12:29:57Z）。**

用户当场确认真实 Vault 位置为 `…/Obsidian Vault/羽毛球赛事管理系统`（不含「项目」这一级）并授权同步后执行：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 预演 | `pnpm run docs:sync:dry-run` | `create=1 update=0 unchanged=30 stale=0 conflict=0` |
| 应用 | `pnpm run docs:sync` | 退出码 0；`CREATE 05-测试验收/阶段1-Claude审查报告.md`；`APPLIED 31 managed Markdown files` |
| 复核 | `pnpm run docs:sync:dry-run` | `create=0 update=0 unchanged=31 stale=0 conflict=0` |

核验证据：

- Vault 中 `.md` 总数由 30 变为 31；`05-测试验收/` 下新增 `阶段1-Claude审查报告.md`。
- 仓库源与 Vault 副本 SHA-256 一致（`50008d2c…88cd4e`），`cmp` 逐字节相同。
- 同步清单 `.badminton-kb-sync.json` 条目数 31，`lastSuccessfulSync = 2026-09-18T12:29:57.553Z`。
- 更新前备份写入未提交的 `.local/kb-sync-backups/2026-09-18T12-29-57-551Z/`。
- Vault 顶层其他 18 个笔记/目录与 `.obsidian` 配置未被触碰；本次为单向新增，脚本无删除语义。

> 本节在同步完成后补写，因此仓库源比首次发布的 Vault 副本多出本节内容，已再次执行 `docs:sync` 使两侧一致；最终复核为全部 `UNCHANGED`。

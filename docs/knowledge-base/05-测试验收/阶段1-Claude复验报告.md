---
title: 阶段 1 Claude 独立复验报告
stage: 1
status: current
updated: 2026-09-18
tags:
  - 羽毛球赛事管理系统
  - 复验报告
  - 测试验收
---

# 阶段 1 Claude 独立复验报告

> 本文件按轮次追加，不覆盖历史结论。原始审查结论保留在[阶段 1 Claude 独立审查报告](阶段1-Claude审查报告.md)，本轮**未改写该文件一个字节**（仓库副本与 Vault 副本 SHA-256 均为 `bec9e433…69ea7`）。
> 本轮为修复后的独立复验：只读源码、运行既有构建与测试、在隔离测试库与一次性临时测试库取证，**未修改任何业务源码、测试、依赖、锁文件、迁移或环境配置**。

---

## 第 2 轮 · 2026-09-18 · Claude 独立复验（Codex 修复后）

### 一、复验基线

| 项 | 值 |
|---|---|
| 仓库路径 | `/Users/Shared/Files From d.localized/校园羽毛球赛事编排与成绩管理系统` |
| 分支 | `main`，`git stash list` 为空 |
| 基线 commit | `781906baded04957f4aabd12937bf98192ca3899`（与第 1 轮相同，Codex 未提交） |
| 复验对象 | 工作区中 29 个已修改文件 + 9 个新增未跟踪文件（`git status --porcelain` 共 38 条） |
| 源码改动规模 | `git diff --stat`：29 文件，+338 / −50 |
| 环境 | macOS 27.0 / Apple Silicon；`pnpm exec node -v` = v24.21.0；pnpm 11.9.0；PostgreSQL 15.18 |
| 隔离库 | 全部写入发生在 `badminton_tournament_test` 与一次性临时库 `badminton_claude_reverify_test`（已删除）；`badminton_tournament_dev` 与本机其余 12 个数据库全程只读 |

复验开始时测试库基线，与第 1 轮结束时完全一致：

`users=2 / sessions=0 / scoring_sessions=0 / audit_logs=0 / matches=2 / entries=4 / entry_members=6 / participants=6 / games=2 / official_assignments=1 / role_assignments=2 / tournaments=1`

#### 先做「是否靠削弱测试掩盖问题」的检查

在相信任何「测试通过」之前，先逐文件对比 `HEAD` 与工作区的用例数量，并检查配置是否新增排除项：

| 测试文件 | HEAD 用例数 | 当前用例数 | 结论 |
|---|---|---|---|
| `tests/db/database-safety.test.ts` | 3 | 4 | 只增不减 |
| `tests/domain/rule-profile.test.ts` | 2 | 2 | 未变 |
| `tests/e2e/phase-1.spec.ts` | 5 | 8 | 只增不减 |
| `tests/integration/authorization.test.ts` | 4 | 5 | 只增不减 |
| `tests/integration/public-fields.test.ts` | 1 | 1 | 未变 |
| `tests/server/runtime-security.test.ts` | 2 | 2 | 未变 |
| `tests/sync-knowledge-base.test.mjs` | 10 | 10 | 未变 |
| `tests/server/errors.test.ts`（新增） | — | 1 | 新增 |
| `tests/server/test-environment-template.test.ts`（新增） | — | 1 | 新增 |

- **没有删除任何用例，没有 `skip`/`only`/`todo`。** `grep` 全量测试目录零命中。
- `vitest.config.ts` 的 `include` 仍为 `tests/**/*.test.ts`，未新增 `exclude`。
- `playwright.config.ts` 的改动是**删除** `env: { ALLOW_DEMO_ACCOUNTS: "false" }`，即取消了第 1 轮指出的「用环境变量覆盖真实配置」，方向正确，不是放宽。
- 断言方向是**收紧**：新增了 3 处「拒绝后数据库计数不变」断言、1 处审计内容断言、1 处日志脱敏断言。
- 唯一被移除的源码分支是 `prisma/seed.ts` 中的 `if (!user) throw`，因为改造后 `user` 由事务保证非空；类型检查通过，不是弱化校验。

结论：**未发现通过删除测试、弱化断言或关闭校验来掩盖问题的行为。**

---

### 二、本轮实际执行的命令与结果

| # | 命令 | 退出码 | 真实结果 |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | `Already up to date`，锁文件未被修改（`git status` 中 `pnpm-lock.yaml` 干净） |
| 2 | `pnpm run lint` | 0 | ESLint 无输出 |
| 3 | `pnpm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| 4 | `pnpm run build` | 0 | Next.js 16.3.5 编译、类型检查、11 条路由生成通过 |
| 5 | `pnpm test` | 0 | **16/16 通过**（7 个测试文件） |
| 6 | `pnpm run test:e2e` | 0 | **8/8 通过** |
| 7 | `node --test tests/sync-knowledge-base.test.mjs` | 0 | **10/10 通过** |
| 8 | `pnpm run docs:sync:dry-run`（复验前） | 0 | `create=0 update=0 unchanged=31 stale=0 conflict=0` |
| 9 | 数据库不变量负向探针（8 条，全部 `ROLLBACK`） | — | 8/8 被数据库拒绝，零残留（见第四节） |
| 10 | 隔离测试服务器 HTTP 探针（dev 3100 / 全新库 3101 / **生产构建 3102** / 门禁 3103、3104） | — | 见第三节 |
| 11 | 一次性临时库 `badminton_claude_reverify_test` 上的全新种子 + 真实登录 | — | 见 S1-001 复验 |

> 说明：第 5、6 项我没有只看 Codex 的记录，而是自己重跑；第 9、10 项是我自己构造的探针，与 Codex 的回归无关。

---

### 三、按原编号逐项复验

判定口径：**复验通过**＝原问题的复现步骤不再复现，且我有第一手证据；**仍存在**＝仍能复现；**证据不足**＝无法在本轮取得可信证据；**原发现不成立**＝原判断本身有误。

---

#### S1-001 — 公众自助注册在仓库自带测试配置下是开着的 → **复验通过**

**原复现步骤重跑（用仓库真实 `.env.test`，`ALLOW_DEMO_ACCOUNTS="true"`，无任何环境变量覆盖）：**

```
POST http://127.0.0.1:3100/api/auth/sign-up/email
→ HTTP 400 {"message":"Email and password sign up is not enabled","code":"EMAIL_PASSWORD_SIGN_UP_DISABLED"}
变体（大小写邮箱 + callbackURL）→ HTTP 400
数据库复查：users=2，其中 email ilike '%reverify-probe%' 的行数 = 0
```

原来的 `200 + 新建 ACTIVE 用户` 不再出现。

**耦合是否真的解除（代码级全量核对）：**

```
grep -rn "ALLOW_DEMO_ACCOUNTS" src/ prisma/ scripts/ tests/ *.config.ts
  src/server/config/runtime.ts:16   （只用于生产门禁）
  prisma/seed.ts:73                 （只用于种子授权）
  tests/…                           （只用于测试）
grep -rn "disableSignUp" src/
  src/server/auth/auth.ts:18: disableSignUp: true,
```

`ALLOW_DEMO_ACCOUNTS` 已不再出现在任何认证配置路径上。

**最关键的连带风险，我单独取证：** 修复把种子从 `auth.api.signUpEmail` 改成了 `better-auth/crypto` 的 `hashPassword` + 事务直写 `user`/`account`。既有测试库里的身份是**旧路径**创建的，所以「e2e 能登录」并不能证明新路径可用。我因此新建了一次性临时库：

| 步骤 | 结果 |
|---|---|
| 确认 `badminton_claude_reverify_test` 此前不存在 | `count=0` |
| 第 1 次 `prepare-test-database`（建库 + `migrate deploy` + 种子） | 退出码 0；`users=2 accounts=2 participants=6 entries=4 entry_members=6 matches=2 games=2 official_assignments=1 role_assignments=2 rule_rev=1` |
| 第 2 次同命令 | 退出码 0；**计数逐项完全一致，无重复记录** |
| 凭据形态 | `providerId=credential`、`accountId == userId`、`hash_len=161`，与旧路径创建的记录长度/形态一致 |
| **管理员真实登录** | `POST /api/auth/sign-in/email` → **HTTP 200**，返回 `admin@badminton.local` |
| **裁判真实登录** | **HTTP 200**，返回 `referee@badminton.local` |
| 错误口令 | HTTP 401（拒绝） |
| 全新库上公众注册 | HTTP 400（关闭） |
| 全新库上授权链 | 裁判取本人比赛 `201 acquired`；管理员取同一比赛 `403 forbidden`；裁判访问 `/management` `403` |

即：干净环境下种子写入的身份**确实能登录**，且权限边界完好。临时库验证后已 `drop database`，复核本机数据库清单 15 → 14，其余 13 个库（含 `badminton_tournament_dev` 与其他项目的库）全部完好。

**守护用例的真实性：** `playwright.config.ts` 的 `env` 覆盖已删除，e2e 用例「运行中的网页不开放公众注册」现在跑在仓库真实配置上；我用同一配置手工复现得到同样的 400，说明该用例非空转——若 `disableSignUp` 回退，它会立即失败。

---

#### S1-002 — Server Component 抛 `AppError` 变成 HTTP 500 → **复验通过**（含生产构建）

三个分支我都重跑了原复现步骤：

| 分支 | 原实测 | 本轮 dev（3100） | 本轮**生产构建** `next start`（3102） |
|---|---|---|---|
| 裁判 `GET /management` | 500 + 二义提示 | **403**，页面含「没有赛事管理权限」「当前账号没有任何赛事的管理员或编排员角色」 | **403**，页面含「没有赛事管理权限」 |
| 账号停用后 `GET /officiating` | 500 | **403**，页面含「没有访问权限」「当前账号不能访问此页面，或账号已停用」 | —（同一机制） |
| 无已发布赛事时 `GET /public` | 500 | **404**，页面含「暂无已发布赛事」「页面没有暴露草稿数据」 | **404**，含「暂无已发布赛事」 |

补充核对：

- 对照组未被误伤——裁判 `GET /officiating` = 200，`GET /settings` = 200，未登录 `GET /management` = **307** 重定向（dev 与生产一致）。
- DRAFT 态下 `/public` 页面正文对「阶段 1 匿名模拟赛」「MS-DEMO-001」「MD-DEMO-001」「选手」四个关键词**全部未命中**，草稿数据没有随 404 泄露。
- API 层不受影响：停用账号调用控制接口仍是 `403 {"code":"account_disabled"}` 中文结构化错误。
- 测试后已把 `tournaments.status` 与 `users.status` 恢复为 `PUBLISHED` / `ACTIVE`。

**关于 Codex 自陈的剩余限制「`authInterrupts` 仍是实验功能」**：Codex 只在 `next dev` 下验证过。我补做了生产构建验证（`pnpm run build` + `next start`，`NODE_ENV=production`），403/404 行为与 dev 完全一致。该风险在 Next 16.3.5 上**当前不成立**，但升级 Next 时仍需复核。

---

#### S1-003 — `/api/health` 的 `serverTime` 快 8 小时 → **复验通过**

```
主机真实 UTC : 2026-09-18T12:55:23Z
API serverTime: 2026-09-18T12:55:23.662Z
计算偏差      : 0.068 秒（原为 +28800 秒）
```

根因侧核对（同一隔离库）：

```
select now()                                   → 2026-09-18 20:55:23.749319+08   （墙钟 +08）
select clock_timestamp() at time zone 'UTC'    → 2026-09-18 12:55:23.749704      （真实 UTC）
select to_char(… ,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') → 2026-09-18T12:55:23.749Z    （接口实际取法）
```

修复改为在 SQL 侧显式转 UTC 并格式化为字符串，绕开了 Prisma PG adapter 把 `timestamptz` 墙钟当 UTC 构造 `Date` 的问题。e2e 新增的对时用例（±5 秒容差）我实际跑过并通过。

**未解决部分（Codex 已如实声明，我确认仍在）**：迁移中 `createdAt` 等列仍是 `TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP`（无时区）。当前所有写入均由 Prisma 提供时间戳，无数据损坏证据；任何绕过 Prisma 的原生 SQL 或未来触发器仍会产生 8 小时偏差。这是**遗留风险，不是本项未修复**。

---

#### S1-004 — 干净检出跑不了测试 → **复验通过**

| 核对项 | 结果 |
|---|---|
| `.env.test.example` 存在 | 是，12 行 |
| 是否可进 Git | `.gitignore:19` 新增 `!.env.test.example`；`git check-ignore` 不再命中；`git status` 显示为 `??`（待提交） |
| 键集合与真实 `.env.test` 是否一致 | **完全一致**，9 个键：`DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`APP_ENV`、`ALLOW_DEMO_ACCOUNTS`、`DEMO_ADMIN_EMAIL/PASSWORD`、`DEMO_REFEREE_EMAIL/PASSWORD`；模板无缺失、无多余 |
| 原复现步骤（缺失 env 文件） | `dotenv -e .env.does-not-exist -- tsx scripts/prepare-test-database.ts` → **`缺少 DATABASE_URL。请先按 .env.test.example 创建 .env.test。`**（原为泛化的「缺少 DATABASE_URL。」） |
| 文档 | `README.md:43` 与 `07-使用部署/本地启动与手机访问.md:42` 均写明复制步骤；并注明 `ALLOW_DEMO_ACCOUNTS=true` 不会开放网页注册 |
| 自动化守护 | `tests/server/test-environment-template.test.ts` 断言模板存在、9 个键齐全、`DATABASE_URL` 指向 `_test`、`BETTER_AUTH_URL` 为 `:3100`、`.gitignore` 含反忽略行 |

模板里 `BETTER_AUTH_SECRET` 是 17 个字符的中文占位符，照抄不改会在启动时得到 `BETTER_AUTH_SECRET 至少需要 32 个字符。`——提示明确，且与文档「填写至少 32 字符的测试密钥」一致，属预期行为，不另记问题。

---

#### S1-005 — 越权拒绝不写审计；`logServerEvent` 是死代码 → **复验通过**

用真实 HTTP 请求（裁判身份，目标是未指派给他的 `MD-DEMO-001`，并在请求体里塞入 `"userId":"forged"` 和 `"role":"ADMIN"`）取证：

```
HTTP 403 {"error":{"code":"not_assigned","message":"你没有被指派执裁这场比赛。"}}

audit_logs 新增 1 行：
  SCORING_SESSION_ACQUIRE | DENIED | Match | {"errorCode": "not_assigned", "matchCode": "MD-DEMO-001"}

服务端 stdout 新增结构化日志：
  {"timestamp":"2026-09-18T12:56:04.869Z","level":"info","event":"request_failed",
   "route":"/api/matches/[matchCode]/control",
   "actorUserId":"a7d3db8b-…","status":403,"code":"not_assigned"}

scoring_sessions 计数：0 → 0（无业务副作用）
```

对照：

- `logServerEvent` 不再是死代码，调用点为 `errors.ts:17`、`errors.ts:27`、`scoring-session-service.ts:33`。
- 未登录请求（401）也进结构化日志，我在生产构建上也验证到 `{"status":401,"code":"unauthenticated"}`。
- 审计 `metadata` 中不含 token/口令；`tests/server/errors.test.ts` 另行断言嵌套的 `authorization`、`password` 字段被替换为 `[REDACTED]`。
- 请求体自带的 `userId`/`role` 被完全忽略——审计里记录的是会话解析出的真实裁判 id，不是 `forged`。

**与原建议的差异（Codex 已说明，我认可）**：只对「已登录用户的控制权 403」写业务审计，401/404 只进脱敏服务日志。原建议更宽，但更宽会把未认证流量写进业务审计表。当前取舍合理且被文档记录。

---

#### S1-006 — e2e 在测试库留下活动控制会话 → **复验通过**

原复现步骤：跑完 `pnpm run test:e2e` 后查 `scoring_sessions`。

```
本轮 8/8 通过后立即查询：
scoring_sessions=0 | status='ACTIVE' 的行=0 | audit_logs=0 | sessions=0
users=2 | blocked@example.test 残留=0 | tournaments.status=PUBLISHED（404 用例已自行还原）
```

原来的「残留 1 条 ACTIVE 会话」不再出现。清理由 `beforeEach` + **新增的 `afterEach`** 共同保证；404 用例用 `try/finally` 还原赛事状态，注册探针用例用 `finally` 删除探针账号。同时新增了 3 处「拒绝后 `scoringSession.count()` 不变」断言，补上了原报告指出的「只看状态码」缺口。

---

#### S1-007 — `prompt-kit/01` 的 Vault 路径过时 → **原发现不成立（已确认为非实现缺陷），文档动作已落实**

- 第 1 轮已由用户当场确认真实路径不含「项目」这一级，本项从一开始就不是实现缺陷。
- 本轮核对残留的文档动作：`02-架构设计/技术选型与决策.md` 已新增 **ADR-007：Vault 发布目标**，写明唯一授权目标路径、与 `AGENTS.md`/`README.md`/同步脚本一致、以及「不迁移或重建已发布目录」「过时的 `prompt-kit/01` 不构成实现缺陷」。
- 同步脚本测试 10/10；`docs:sync:dry-run` 为 `unchanged=31 stale=0 conflict=0`。

---

#### S1-008 — `CHIEF_REFEREE` 被授权函数硬拒 → **代码侧按约定未改（符合预期）；但 Codex 记录的文档留痕「仍存在」**

代码侧核对，与约定一致：

```
src/server/auth/authorization.ts:49
  await requireTournamentRole(userId, tournamentId, ["REFEREE"]);
```

未放开 `CHIEF_REFEREE`。原报告本就把它定义为**阶段 3 前置风险、非当前阻塞**，因此本轮不改代码是正确的，不计为未修复。

**但 Codex 在《问题与修复记录》里写的「限制保留在 `API与权限.md` 的阶段 3 设计中」与事实不符。** 实测：

```
grep -rn "CHIEF_REFEREE" docs/ AGENTS.md README.md
  → 仅命中《阶段1-Claude审查报告.md》自身的 4 行，API与权限.md 零命中
```

`API与权限.md` 的「角色权限矩阵补充」仍写着「强制接管/更换主裁判｜主裁判：不得抢占｜**裁判长：允许，记录原因**」，「租约和接管」仍写着「裁判长接管时递增 `takeoverGeneration`」，**全文没有任何一处记录当前授权函数会拒绝裁判长**。原报告要求的「现在只需在 `API与权限.md` 标注这条限制」并未完成。详见新问题 **S1-011**。

---

#### S1-009 — 文档小幅失准（安装命令、权限门禁范围） → **复验通过**

| 子项 | 复验结果 |
|---|---|
| 安装命令表述统一 | `README.md:12`、`AGENTS.md:46`、`本地启动与手机访问.md:21` 均为 `pnpm install --frozen-lockfile`；`测试记录.md:58` 新增一行记录本次 `--frozen-lockfile` 实际执行通过，并说明历史的 `--frozen-lockfile=false`（`:35`）**保留为当时真实事实，不改写** |
| 我自己的验证 | `pnpm install --frozen-lockfile` 退出码 **0**（`Already up to date`），锁文件未变；第 1 轮标为「未验证」的项现已有实测证据 |
| 权限门禁范围 | `API与权限.md` 末段已改为「阶段 1 至少覆盖未登录、错误角色、错误比赛和无指派，并确认拒绝不创建控制会话。过期版本、无效租约、两设备竞争…属于阶段 2/3 门禁，当前未实现。」——不再把阶段 2/3 项写成阶段 1 已覆盖 |

---

### 四、修复波及面的独立复查（登录、权限、数据库）

修复触及了认证配置、种子写入、页面授权、错误处理与审计，因此对受影响路径重新做了完整取证，而不是只看回归用例。

#### 4.1 数据库不变量（8 条负向 SQL，全部 `ROLLBACK`）

迁移文件本轮未改动（`git diff` 对 `prisma/migrations/` 为空），但既然要给「通过」结论，仍由我自己重跑一遍：

| 探针 | 实测拒绝原因 |
|---|---|
| 双打组合只放 1 名成员 | `entry … requires 2 distinct member(s), found 1`（延迟约束触发器） |
| 双打组合放 0 名成员 | `requires 2 distinct member(s), found 0` |
| 双打组合放同一人两次 | `entry_members_entryId_participantId_key` |
| 双打组合放 3 名成员 | `entry_members_slot_check` |
| 单打组合放 2 名成员 | `requires 1 distinct member(s), found 2` |
| `games.scoreA = -1` | `games_nonnegative_scores_check` |
| `matches` 两侧 entry 相同 | `matches_distinct_sides_check` |
| 同场第二个 `ACTIVE` 控制会话 | `scoring_sessions_one_active_per_match` |

> 取证过程更正：前两次探针分别因 `uuid`/`text` 类型不匹配和 `updatedAt` 非空而报错，那**不是**约束生效，我没有把它算作通过；修正 SQL 后才得到上表结果。
>
> 探针后复核：`PROBE-%` 组合 0 条，`entries=4`、`entry_members=6` 与基线一致，负分 0、两侧相同 0、`scoring_sessions=0`。

#### 4.2 授权链端到端（dev 3100 + 全新库 3101 + 生产构建 3102）

| 用例 | 期望 | 实测 |
|---|---|---|
| 未登录 `POST /api/matches/MS-DEMO-001/control` | 拒绝 | `401 unauthenticated`（dev 与生产一致） |
| 未登录 `GET /management` | 重定向 | `307`（dev 与生产一致） |
| 裁判取**未指派**的 `MD-DEMO-001` | 拒绝 | `403 not_assigned`，`scoring_sessions` 不变 |
| 请求体伪装 `userId`/`role` | 忽略客户端声明 | 仍 `403`，审计记录的是会话真实身份 |
| 管理员（无 REFEREE 角色）取控制权 | 拒绝 | `403 forbidden`（全新库上复现） |
| 裁判取**已指派**的 `MS-DEMO-001` | 允许 | `201 {"status":"acquired","takeoverGeneration":1}` |
| 裁判 `GET /management` | 拒绝 | `403` + 专用中文页 |
| 账号 `DISABLED` 后复用旧 cookie | 拒绝 | 页面 `403`，API `403 account_disabled`（随即恢复 ACTIVE） |
| 公开接口读 `DRAFT` / `ARCHIVED` | 不泄露 | 页面 `404`、API `404 tournament_not_found`；正文无草稿数据 |
| 错误口令登录 | 拒绝 | `401` |

#### 4.3 生产安全门禁（第 1 轮只有 Vitest 模拟环境变量，本轮用真实 `next start`）

| 配置 | 期望 | 实测 |
|---|---|---|
| 合规生产配置（无示例变量、密钥 ≥32 且非开发密钥） | 正常服务 | 启动正常；登录、403、404、关闭注册全部与 dev 一致——**门禁无误杀** |
| 生产 + `ALLOW_DEMO_ACCOUNTS=true` | 拒绝 | 日志出现「生产环境检测到示例账号配置，拒绝启动。」，一切鉴权路由 `500`，登录不可用 |
| 生产 + 已知开发密钥 | 拒绝 | 日志出现「生产环境仍在使用示例认证密钥，拒绝启动。」，同上 |

门禁**方向正确且失败关闭**（不是放行），但实际行为与文档措辞不一致，见新问题 **S1-010**。

#### 4.4 隔离与残留

- 全程只写 `badminton_tournament_test` 与一次性 `badminton_claude_reverify_test`；后者已 `drop`，复核本机数据库清单后其余 14 个库全部完好，`badminton_tournament_dev` 只做过两次只读计数。
- 复验结束时测试库恢复到与开始完全相同的基线：`users=2 / sessions=0 / scoring_sessions=0 / audit_logs=0 / matches=2 / entries=4 / entry_members=6 / tournaments=1 / status=PUBLISHED / referee=ACTIVE`。我自己探针产生的 1 条 `DENIED` 审计与登录会话已清除。
- 5 个探针端口（3100—3104）的进程全部结束，无残留监听。
- 未提交、未推送、未切换分支、未 `stash`/`clean`/`reset`；`git status` 仍为 38 条，与复验开始一致。

---

### 五、本轮新发现（新编号，接续原序列）

#### S1-010 — 生产安全门禁不是「拒绝启动」，而是「首个鉴权请求时失败」，且 `/api/health` 仍报 200

- **严重程度：P2**
- **证据状态：运行复现（真实 `next start`，非模拟环境变量）**
- **位置**：`src/server/config/runtime.ts:9-23`；在 `src/server/auth/auth.ts` 顶层调用
- **对应文档**：`ADR-006`「生产环境发现示例账号开关或密码变量时**拒绝启动**」；追踪矩阵 `AUTH-003`
- **复现**：用合规 `DATABASE_URL` + 追加 `ALLOW_DEMO_ACCOUNTS="true"` 执行 `next start --port 3103`
- **实际**：
  ```
  进程正常启动并监听
  GET /api/health                  → 200 {"status":"ok","database":"connected", …}
  GET /management                  → 500
  POST /api/auth/sign-in/email     → 500
  服务器日志                        → 生产环境检测到示例账号配置，拒绝启动。
  ```
  换成已知开发密钥，结果同构（日志为「生产环境仍在使用示例认证密钥，拒绝启动。」）。
- **为什么是问题**：不是越权漏洞，门禁是**失败关闭**的，没有放行任何请求。但在生产构建里路由模块是惰性加载的，`assertRuntimeSecurity` 因此**不在进程启动时执行**。后果有两点：①文档与 ADR 写的「拒绝启动」与实际不符；②`/api/health` 不经过认证模块，会对一个**登录完全不可用**的部署持续返回 200，基于健康检查的滚动发布/探活会把坏部署判为健康，错误直到用户登录才暴露。
- **最小修复建议**：在一个启动期必然执行的位置（如 `instrumentation.ts` 的 `register()`）调用 `assertRuntimeSecurity()`，让进程真的启动失败；或让 `/api/health` 一并反映运行期安全门禁状态。若选择不改，则把 ADR-006 与矩阵措辞从「拒绝启动」改为「拒绝服务鉴权请求」。
- **建议回归测试**：一条断言「生产 + 示例账号配置时进程无法进入就绪状态」的脚本级用例。

---

#### S1-011 — S1-008 的文档留痕未落实，修复记录的描述与仓库事实不符

- **严重程度：P3**
- **证据状态：运行复现**
- **位置**：`docs/knowledge-base/06-开发日志/问题与修复记录.md` 的 S1-008 条目写「限制保留在 `API与权限.md` 的阶段 3 设计中」
- **实测**：`grep -rn "CHIEF_REFEREE" docs/ AGENTS.md README.md` 仅命中《阶段1-Claude审查报告.md》自身 4 行；`API与权限.md` **零命中**，且其角色矩阵仍写「强制接管/更换主裁判｜裁判长：允许，记录原因」
- **影响**：原报告 S1-008 要求的唯一动作（在 `API与权限.md` 标注限制）没有完成，而修复记录读起来像已完成。阶段 3 实现接管的人如果只读 `API与权限.md`，会按矩阵以为裁判长可以接管，直到运行时撞上 `403 forbidden`。这类「记录与事实不符」比缺陷本身更影响后续判断。
- **最小修复建议**：在 `API与权限.md` 的「租约和接管」或「角色权限矩阵补充」下加一行当前限制，并把修复记录中的该句改为如实描述。

---

#### S1-012 — 种子不会更新已存在身份的口令，轮换 `.env.test` 中的示例口令后仍报告「种子完成」

- **严重程度：P3**
- **证据状态：运行复现（在一次性临时库上）**
- **位置**：`prisma/seed.ts:13-37`，`ensureAuthUser` 只在 `user` 不存在时写入 `account.password`，存在时只 `update` 姓名/状态
- **复现**：在已种子过的库上把 `DEMO_REFEREE_PASSWORD` 改为新值，重跑 `tsx prisma/seed.ts`
- **实际**：
  ```
  种子输出：阶段 1 模拟种子完成：1 场单打、1 场双打、6 名匿名选手、2 个本地测试身份。
  用新口令登录 → HTTP 401
  用旧口令登录 → HTTP 200
  ```
- **影响**：本轮修复把口令材料的所有权从 Better Auth 端点移到了种子里，这条路径因此变得更显眼。使用者按 S1-004 的新流程复制 `.env.test.example`、先填占位值跑一次、再填真实口令时，会得到「种子成功但登录失败」，而错误信息只有 401，无从定位。这不是本轮引入的回归（旧的 `signUpEmail` 路径同样跳过已存在用户），但现在应当显式处理。
- **最小修复建议**：`ensureAuthUser` 对已存在身份 `upsert` 凭据账号的口令哈希；或在检测到已存在身份时打印一行「已存在，未更新口令」的提示。
- **建议回归测试**：一条断言「改口令后重跑种子，新口令可登录」的集成用例。

---

#### S1-013 — 已登录但无权限的账号可无限触发 `DENIED` 审计写入，无速率限制或去重

- **严重程度：P3**
- **证据状态：代码路径已确认 + 单次运行复现**
- **位置**：`src/server/services/scoring-session-service.ts:10-37`（`recordDeniedAcquire`）
- **触发条件**：任何通过 `requireActiveUser` 的账号（例如只有 ADMIN 角色的人）对 `POST /api/matches/{code}/control` 反复请求，每次 403 都会写入一行 `audit_logs`
- **影响**：这是本轮为修 S1-005 而**新引入的写路径**，方向正确且是刻意取舍。但拒绝路径现在会产生数据库写入，缺少速率限制或按 (用户, 比赛, 错误码) 的去重/合并，登录用户可借此放大 `audit_logs`。阶段 1 没有暴露到公网，因此不是当前阻塞；阶段 3 加入接管与心跳后写入频率会更高。
- **最小修复建议**：对同一 (actor, match, errorCode) 在短时间窗内合并或抑制重复审计；阶段 3 一并引入控制接口的速率限制。

---

#### S1-014 — `CLAUDE.md` 有三处陈述因本轮修复而失准，其中一处会误导后续改动

- **严重程度：P3**
- **证据状态：运行复现**
- **位置与实测**：

  | 行 | 现有陈述 | 现在的事实 |
  |---|---|---|
  | `CLAUDE.md:111` | 「`ALLOW_DEMO_ACCOUNTS` 当前**同时**控制…『是否开放公众注册』（`auth.ts` 的 `disableSignUp`）。改动认证配置时留意这个耦合。」 | 耦合已被 S1-001 的修复解除，`disableSignUp` 现为硬编码 `true` |
  | `CLAUDE.md:55` | 「**目前没有 `.env.test.example`**，干净检出跑不了测试」 | 模板已存在且已反忽略 |
  | `CLAUDE.md:115` | 「共 **30** 份 Markdown」 | 现为 31 份（本报告发布后为 32 份） |

- **影响**：`CLAUDE.md` 是每次会话都会载入的项目指令文件。第 111 行最危险——它把一个**已经修掉的缺陷**描述成当前设计，后续代理照此「保持耦合」就会把 S1-001 改回去。
- **最小修复建议**：同步更新这三处。该文件是第 1 轮按 `/init` 新建的，Codex 本轮未纳入修改范围，属可以理解的遗漏。
- **说明**：本轮我**未修改**该文件（复验不改源码与文档实现），只记录。

---

### 六、阶段 1 必需验收条件判定

| 阶段 1 要求 | 第 1 轮结论 | 本轮证据 | 本轮结论 |
|---|---|---|---|
| ① 初始化框架、版本固定、锁文件 | 通过（`--frozen-lockfile` 未验证） | `pnpm install --frozen-lockfile` 退出码 0、锁文件未变；lint/typecheck/build 全 0 | **通过** |
| ② 模块化结构 domain/server/db/ui/reports/tests | 通过 | 目录结构未变；规则仍只有一份 | **通过** |
| ③ 最小实体与迁移 | 通过 | 全新库上两个迁移成功 `migrate deploy`；既有库 `No pending migrations` | **通过** |
| ④ 个人/组合分离、双打恰好两名不同选手、A/B 不绑场地端、比分非负、版本化 | 通过 | 本轮自行重跑 8 条负向 SQL，全部由**数据库**拒绝且零残留 | **通过** |
| ⑤ 真实认证 + 服务端角色/范围/指派校验；公开注册关闭；生产拒绝示例配置；公开页不泄露 | **部分不通过（S1-001）** | 真实配置下注册 400；全新库上种子身份可登录且授权链完整；dev 与生产构建一致；DRAFT/ARCHIVED 无泄露 | **通过**（生产门禁的行为口径见 S1-010） |
| ⑥ 中文页面框架，未实现入口明确标示 | 通过（错误分支见 S1-002） | 403/404 均为专用中文页，dev 与生产一致 | **通过** |
| ⑦ 可重复模拟种子，重复运行不复制 | 通过 | 全新库连续两次种子，10 项计数逐项一致 | **通过** |
| ⑧ 环境变量示例、健康检查、结构化错误、服务端时间、日志脱敏 | **部分不通过（S1-003、S1-005）** | 对时偏差 0.068 秒；`logServerEvent` 三处调用点并在生产构建实测输出；脱敏有单测断言 | **通过** |
| ⑨ 开发/测试库隔离、脚本齐全 | **部分不通过（S1-004）** | 模板存在且键集合一致、可进 Git、缺失时给出可执行中文指引；隔离门禁 4 条测试通过；实测只写 `_test` 库 | **通过** |
| 验收行：应用能启动 | 通过 | dev 与生产构建均 `/api/health` 200 | **通过** |
| 验收行：刷新保留数据库内容 | 通过 | e2e 通过；服务器多次重启后数据仍从库中读回 | **通过** |
| 验收行：未登录不能写入 | 通过 | `401`，无数据库副作用 | **通过** |
| 验收行：普通公众不能访问执裁 API | 通过 | 未登录 401；无角色账号 403；注册已关闭，无法自助获得账号 | **通过** |
| 验收行：未指派裁判不能操作其他比赛 | 通过 | `403 not_assigned`，改比赛 ID 不能绕过，请求体伪装无效 | **通过** |
| 验收行：错误有中文提示 | **部分不通过（S1-002）** | API 与页面层均为中文；403/404 状态码正确且提示具体 | **通过** |
| 验收行：测试和生产数据隔离检查通过 | 通过 | 实测只写两个 `_test` 库，临时库已删，其余 13 个库未触碰 | **通过** |
| 文档与 Obsidian 安全同步 | 通过（小瑕疵） | 同步工具 10/10；dry-run `unchanged=31 conflict=0`；原审查报告在仓库与 Vault 均逐字保留 | **通过**（留痕瑕疵见 S1-011、S1-014） |

#### 仍然「未验证」的项（不计为通过，也不计为失败）

| 项 | 状态 | 原因 |
|---|---|---|
| 真实手机 / 平板 / 局域网实机 / 防火墙 | **未验证** | 本会话无真实移动设备；第 1 轮的模拟视口结果同样不能称为真机验收 |
| 真实生产部署、HTTPS、域名、备份恢复 | **未验证** | 本轮只在本机以 `next start` + `NODE_ENV=production` 验证了运行期行为，不等于部署验收 |
| 迁移中无时区时间戳的长期方案 | **未验证** | 已知遗留风险，当前无数据损坏证据 |
| 阶段 2/3 的计分、幂等 `commandId`、`expectedVersion`、租约心跳、多设备接管 | **不适用** | 接口尚不存在，按阶段边界不计入 |

---

### 七、总评

**阶段 1 必需验收条件：通过。**

判定依据：

1. 第 1 轮列出的 3 条阻塞理由**全部解除**，且每条都由我自己重跑原复现步骤取证，而不是采信 Codex 的记录：
   - S1-001：真实配置下注册返回 400、无用户创建；并且我另建一次性全新测试库，验证了改造后的种子写入的身份**确实能登录**——这是 Codex 的回归没有覆盖、却最可能翻车的一环。
   - S1-004：模板存在、可进 Git、键集合与真实文件完全一致、缺失时给出可执行的中文指引。
   - S1-002 / S1-003 / S1-005：分别在 dev 与**生产构建**下复现为 403/404、对时偏差 0.068 秒、`DENIED` 审计与脱敏结构化日志实际落盘。
2. **没有发现削弱测试的行为**：用例数量只增不减（Vitest 12→16，Playwright 5→8），无 skip/only，配置未新增排除项，断言方向是收紧的，被删除的唯一环境变量覆盖恰恰是第 1 轮指出的问题本身。
3. 权限边界在本轮 20 余条真实 HTTP 用例与 8 条负向 SQL 探针下**没有一条被绕过**，拒绝路径除新增的审计行外无业务副作用。
4. 文档诚实度保持：`当前进度与下一步.md` 明确留了一条未勾选项「Claude 尚未执行修复后独立复验，不把 Codex 回归写成独立复验通过」；`测试记录.md` 新增段落开头就声明「不是 Claude 独立复验结论」；历史的 `--frozen-lockfile=false` 记录被保留而非改写。这种克制值得记录。

**新增的 5 个问题（S1-010—S1-014）均不构成阶段 1 阻塞**：S1-010 是失败关闭的门禁与文档措辞不一致加健康检查掩盖，S1-011、S1-014 是记录与事实不符，S1-012、S1-013 是可用性与写放大的边界问题。它们都不影响阶段 1 的权限、隔离与数据完整性结论。

**是否可以进入阶段 2：可以。**

附三点前置建议（不作为进入阶段 2 的硬性条件）：

1. **进入阶段 2 前先修 S1-014**，因为 `CLAUDE.md:111` 会主动误导后续代理把 S1-001 的耦合改回去。这是所有新问题里唯一有「被动回退」风险的。
2. **S1-011 与 S1-008 一并处理**：在 `API与权限.md` 落下裁判长限制的留痕，否则阶段 3 做接管时必然重新踩一次。
3. **S1-010 在阶段 8（可靠性/部署）之前解决**，或先把 ADR-006 与追踪矩阵的措辞改为与实际一致；两者取其一即可，不要让文档继续承诺一个不存在的启动期拒绝。

需要再次强调第 1 轮已经写过的话：这不是一个空壳工程。修复本身也做得克制——没有为了让测试变绿而改测试，没有把未验证写成已验证，剩余限制逐条列出。本轮唯一让我把「文档留痕」单独立项的原因，是修复记录里有一处（S1-008）描述与仓库事实不符；其余记录经抽查均属实。

---

### 八、本轮文件变化

| 文件 | 变化 | 说明 |
|---|---|---|
| `docs/knowledge-base/05-测试验收/阶段1-Claude复验报告.md` | 新增 | 本报告 |

**未修改任何业务源码、测试、依赖、锁文件、迁移或环境配置；未修改第 1 轮的审查报告；未修改 Codex 的修复记录；未提交、未推送、未切换分支、未 stash/clean/reset。**

数据库状态：`badminton_tournament_test` 复验前后基线完全一致（`users=2 / sessions=0 / scoring_sessions=0 / audit_logs=0 / matches=2 / entries=4 / entry_members=6 / participants=6 / games=2 / official_assignments=1 / role_assignments=2 / tournaments=1`）；一次性临时库 `badminton_claude_reverify_test` 已删除；`badminton_tournament_dev` 与本机其余数据库全程只读。

---

### 九、Obsidian 同步状态

**已同步。** 目标为 ADR-007 确认的唯一授权路径 `…/Obsidian Vault/羽毛球赛事管理系统`。

| 步骤 | 命令 | 结果 |
|---|---|---|
| 预演 | `pnpm run docs:sync:dry-run` | `create=1 update=0 unchanged=31 stale=0 conflict=0` |
| 应用 | `pnpm run docs:sync` | 退出码 0；`CREATE 05-测试验收/阶段1-Claude复验报告.md`；`APPLIED 32 managed Markdown files` |
| 复核 | `pnpm run docs:sync:dry-run` | `create=0 update=0 unchanged=32 stale=0 conflict=0` |

核验证据：

- Vault 中 `.md` 总数由 31 变为 32；同步清单 `.badminton-kb-sync.json` 条目数 32，`lastSuccessfulSync = 2026-09-18T13:08:46.509Z`。
- **历史保留已验证**：第 1 轮的《阶段1-Claude审查报告.md》在仓库与 Vault 两侧 SHA-256 均为 `bec9e433…69ea7`，本轮同步为纯新增（`update=0`），未覆盖任何既有文件；同步脚本本身无删除语义，源文件消失只报 `STALE`。
- 本报告仓库源与 Vault 副本 SHA-256 一致（`f9b4f4ae…0fd4dd`），`cmp` 逐字节相同。
- 更新前备份写入未提交的 `.local/kb-sync-backups/2026-09-18T13-08-46-506Z/`。
- Vault 顶层其余 18 个笔记/目录与 `.obsidian` 配置未被触碰。

> 本节在同步完成后补写，因此再次执行了 `docs:sync` 使两侧一致；最终复核为全部 `UNCHANGED`。

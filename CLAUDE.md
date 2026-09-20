# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 与 AGENTS.md 的关系

`AGENTS.md` 是本项目的权威协作约定（阶段边界、Vault 边界、七项不可降级的架构风险）。**先读 `AGENTS.md`，本文件只补充它没写的工程细节。** 两者冲突时以 `AGENTS.md` 为准。

默认使用中文解释，代码标识符用清晰英文。

## 阶段纪律（最容易踩的坑）

本项目按 `prompt-kit/`（本机位于 `~/Downloads/prompt-kit/`，**不在仓库内**）的 0—10 阶段推进，**一次只做一个阶段**。当前停在阶段 3 收尾：S2-008、S2-009 已通过独立复验，场地图裁判工作台获独立“有条件通过”；UI-01-B 与联合总判原为“不通过”，F-001—F-005 已由 Codex 本地修复但尚待独立复判。未经用户明确要求不得进入阶段 4 或 UI-01-C。

阶段 2 纯 TypeScript 规则引擎已由阶段 3 服务端命令事务接入 PostgreSQL；心跳/接管、响应未知恢复和场地图裁判工作台已经实现。报名编排、排名、成绩册和真实公开赛程接口仍未实现，不要顺手补上。改动前先读 `docs/knowledge-base/06-开发日志/当前进度与下一步.md` 和 `01-项目规划/需求验收追踪矩阵.md`。

追踪矩阵的状态只能用「已完成/已规划/未实现/未测试/待核验/后续版本」，且**必须有真实执行证据**才能写「已完成」。

## 常用命令

包管理器固定 pnpm（`packageManager: pnpm@11.9.0`）。`pnpm-workspace.yaml` 通过 `devEngines.runtime` 把仓库命令固定在 **Node 24.21.0**，与系统 Node 无关——用 `pnpm run` / `pnpm exec` 执行，不要直接 `node`/`npx`。

```bash
pnpm install --frozen-lockfile
pnpm run db:migrate          # prisma migrate dev，作用于 .env 的开发库
pnpm run db:seed             # 需要 .env + .env.seed，且 ALLOW_DEMO_ACCOUNTS=true
pnpm dev                     # next dev --hostname 0.0.0.0，端口 3000
pnpm run lint                # eslint .
pnpm run typecheck           # tsc --noEmit
pnpm test                    # db:test:prepare + vitest run（走 .env.test）
pnpm run test:e2e            # db:test:prepare + playwright（自起 3100 端口 dev server）
pnpm run build
pnpm run test:production-startup-security
```

跑单个测试：

```bash
pnpm exec dotenv -e .env.test -- pnpm exec vitest run tests/integration/authorization.test.ts
pnpm exec dotenv -e .env.test -- pnpm exec vitest run -t "拒绝裁判操作未获指派的双打比赛"
pnpm exec dotenv -e .env.test -- pnpm exec playwright test -g "裁判只能取得本人指派单打比赛的控制权"
node --test tests/sync-knowledge-base.test.mjs   # 同步脚本测试，走 node:test 而非 vitest
```

注意 `tests/sync-knowledge-base.test.mjs` 是 `.mjs` + `node --test`，**不在 `vitest.config.ts` 的 `include`（`tests/**/*.test.ts`）里**，`pnpm test` 不会带上它。

### 环境文件

四个本机环境文件及两个可提交模板如下：

| 文件 | 被谁加载 | 用途 |
|---|---|---|
| `.env` | `next dev/build/start`、`prisma.config.ts` | 开发库 `badminton_tournament_dev` + `BETTER_AUTH_*` |
| `.env.seed` | 只有 `db:seed`（`dotenv -e .env -e .env.seed`） | 示例账号邮箱/口令 + `ALLOW_DEMO_ACCOUNTS=true` |
| `.env.test` | `test` / `test:e2e` / `db:test:prepare` / `test:production-startup-security` | 测试库 `badminton_tournament_test`、`BETTER_AUTH_URL=:3100` |
| `.env.example` | 人 | `.env` 的可提交模板 |
| `.env.test.example` | 人 | `.env.test` 的可提交模板；复制后填写隔离 `_test` 库和本机测试身份 |

`dotenv-cli` 对缺失的 `-e` 文件静默通过，失败会晚到 `assertTestDatabaseUrl` 才报「缺少 DATABASE_URL」。

## 架构

Next.js 16 App Router + React 19 的模块化单体，TypeScript 严格模式，路径别名 `@/* → src/*`。

```
src/domain/rules/     纯规则（无 IO、无框架）—— 唯一一份核心规则，不得前后端各写一套
src/server/auth/      会话读取 + 授权判定
src/server/services/  服务端命令与错误
src/server/config/    启动期安全门禁
src/db/               Prisma client 单例 + 数据库隔离断言
src/reports/          对外投影（公开字段白名单）
src/ui/ src/components/ src/app/   展示层
prisma/               schema、迁移、模拟种子
```

### 权限：服务端执行，分三层

1. `getSessionFromHeaders` / `getPageSession`（`src/server/auth/session.ts`）从 Better Auth 取数据库会话。
2. `requireActiveUser` → `requireTournamentRole` → `requireAssignedReferee`（`src/server/auth/authorization.ts`）依次校验账号启用、赛事范围角色（`RoleAssignment`）、具体比赛指派（`OfficialAssignment`）。
3. 失败一律抛 `AppError(status, code, 中文消息)`。

**不要相信客户端提交的 `userId`、角色或比赛授权**，一律从会话重新解析。知道比赛 URL 不等于有权限：`requireAssignedReferee` 同时要求 `REFEREE` 赛事角色**和**该场的 `MAIN_REFEREE` 指派。

API 路由用 `errorResponse(error)`（`src/server/services/errors.ts`）把 `AppError` 转成中文 JSON。**`AppError` 在 Server Component 里抛出不会变成对应状态码，会变成 500** —— 页面层需要拒绝时应改用 Next 的 `forbidden()` / `notFound()`。

### 规则快照链

`RuleProfile → RuleProfileRevision`（不可变，有 `revision`、`configHash`、`frozenAt`）可挂在 tournament / competition / stage 上；比赛开始时冻结为 `MatchRuleSnapshot`（含 `config`、`configHash`、`sourceChain`）。**改默认规则不能影响已开始的比赛。** 所有阈值来自 `src/domain/rules/rule-profile.ts`，纯状态机位于 `src/domain/rules/match-engine.ts`。三个内置 profile 都是**演示配置**，不是核实过的正式赛事规程。

### 阶段 3 已接入的服务端并发原语

- `Match.version` —— 乐观并发的 `expectedVersion`
- `MatchEvent.commandId @unique` + `@@unique([matchId, version])` —— 数据库幂等与确定性重放；已接入 Serializable 服务端命令事务
- `ScoringSession`：`tokenHash`、`takeoverGeneration`、`expiresAt`、`lastHeartbeatAt`，加上迁移里 `scoring_sessions_one_active_per_match` 的部分唯一索引（每场只允许一个 `ACTIVE`）
- `ResultRevision`、`AuditLog`

### 数据库不变量写在迁移里，不只在表单里

`prisma/migrations/20260918114000_phase1_constraints/migration.sql` 用 CHECK、部分唯一索引和一个 **DEFERRABLE 约束触发器**强制：`entry_members.slot ∈ {1,2}`、比分非负、`Match` 两侧 entry 不同、每场唯一活动控制会话、以及**单打恰好 1 名成员 / 双打恰好 2 名不同成员**（触发器在提交时校验）。

新增业务不变量时优先加在迁移里，让数据库兜底。

### 数据库隔离

`src/db/database-safety.ts` 是硬门禁：`assertTestDatabaseUrl` 只放行库名以 `_test` 结尾；`assertDemoSeedDatabase` 只放行 `badminton_tournament_dev` 或 `*_test`。`scripts/prepare-test-database.ts` 会按需 `create database` 并跑 `migrate deploy` + 种子，**没有任何 drop/truncate/delete**。种子全部 `upsert`，可重复运行不产生重复记录；发现多余成员时抛错中止而不是删数据。

**本机 PostgreSQL 上还有其他项目的数据库，任何脚本都不要脱离这两个门禁。**

### 生产安全门禁

`src/server/config/runtime.ts` 的 `assertRuntimeSecurity()` 由 `src/instrumentation.ts` 在 Node 服务启动期执行，并在 `src/server/auth/auth.ts` 顶层保留纵深检查：密钥短于 32 字符直接拒绝；`NODE_ENV=production` 下再拒绝示例账号配置和已知开发密钥。

`ALLOW_DEMO_ACCOUNTS` 只控制本地种子能否创建模拟身份；`auth.ts` 将 `disableSignUp` 固定为 `true`，公众注册始终关闭，两者不得重新耦合。

## 知识库与 Obsidian 同步

`docs/knowledge-base/` 是文档**唯一权威源**，实际文件数以同步脚本清单为准。发布到 Obsidian 只能走 `scripts/sync-knowledge-base.mjs`：

```bash
pnpm run docs:sync:dry-run   # 必须先看，确认 conflict=0
pnpm run docs:sync           # --apply
pnpm run docs:sync:dry-run   # 复核应全部 UNCHANGED
```

脚本的硬约束（改它之前先读 `tests/sync-knowledge-base.test.mjs` 的 10 条用例）：目标路径锁死为单一目录并逐级拒绝符号链接；只同步 `.md`；靠目标目录里的 `.badminton-kb-sync.json` 哈希清单判断归属；**从不删除目标文件**（源文件消失只报 `STALE`）；目标被人工修改或出现未知同名文件即整体停止；更新前备份到未提交的 `.local/kb-sync-backups/`。

`--adopt-target` 只用于「已把 Vault 手工改动逐字合并回仓库后」更新清单基线，内容不一致或存在其他待同步变更都会拒绝。

不要修改 Vault 中的其他笔记或 `.obsidian`；不要把代码、依赖、数据库或密钥放进 Vault。

## 其他

- `src/generated/prisma/` 是 `prisma generate` 的产物，被 `.gitignore` 和 ESLint 忽略，不要手改。
- `AGENTS.md` 末尾 `<!-- BEGIN:nextjs-agent-rules -->` 区块由 `next dev` 自动写入，从 diff 里删掉只会被重新生成。
- Next.js 16 与训练数据中的版本有差异，写代码前查 `node_modules/next/dist/docs/`。

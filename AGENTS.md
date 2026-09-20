# 项目协作约定

## 当前阶段

- 阶段 0、阶段 1 和阶段 2 已完成；S2-008 换边待办关系与 S2-009 特殊结果受控作废均已于 2026-09-20 通过独立复验。
- 阶段 3 的服务端计分事务、租约心跳/接管、响应未知恢复和场地图裁判工作台已通过本地自动化；联合独立验收对裁判工作台给出“有条件通过”，未发现功能性 P0—P2。场地图只投影权威状态，支持单双打、拟首发/拟首接、双打手动换位、物理换边、本机翻转视角、减分预览和 `UNKNOWN` 原 `commandId` 对账。
- UI-01-B 联合独立验收原判“不通过”，唯一 P1 是阶段 3 截图被重新生成但未记账；F-001—F-005 已由 Codex 做最小修复并完成本地回归，尚待独立复判，不能写成已通过。正式 BWF 规则采用、真机/真人裁判、生产部署仍未完成。
- 当前停在阶段 3 收尾；未经用户明确要求不得进入阶段 4。
- 页面骨架、模拟比赛和最小控制会话不能描述成完整赛事系统。
- 一次只执行一个提示词阶段。进入下一阶段前，先读取本文件、`README.md`、知识库首页和当前进度。

## 沟通与证据

- 默认使用中文说明，代码标识符使用清晰英文。
- 先检查现有文件和工作树再修改；保留用户已有改动，不清理、重置或强制覆盖。
- 测试结果、运行状态、截图、老师反馈和开发日期必须来自实际证据；未实现写“未实现”，未测试写“未测试”。
- 每阶段结束都要更新需求追踪矩阵、测试记录、当前进度和日期日志。

## 权威文档与 Vault 边界

- `docs/knowledge-base/` 是项目知识库唯一权威源。
- 只允许向 `/Users/a10954/Documents/Documents - Sunsetz的MacBook Pro/Obsidian Vault/羽毛球赛事管理系统` 单向发布。
- 不得扫描或修改 Vault 的其他笔记、`.obsidian` 配置和其他项目。
- 不在 Vault 中放置代码、依赖、数据库、密钥或本机凭据；不要直接编辑同步副本。
- 发布前先运行 dry-run；发现未知同名文件、人工修改、异常清单或符号链接时停止。

## 技术与业务底线

- 计划采用 Next.js、React、TypeScript、PostgreSQL、Prisma、Vitest、Playwright 的模块化单体；阶段 1 才创建应用骨架。
- 核心规则必须位于纯规则引擎，服务端命令、持久化、界面和报表分层实现。
- 权限必须由服务端执行，不能依赖隐藏按钮或知道比赛 URL。
- 比赛状态的正式来源是数据库，不得只保存在浏览器本地。
- 传统 21 分制当前仅是演示配置；未经核验的规则不得标为正式规程。

以下七项是不可降级的架构风险：

1. 双打发接发次序、左右发球区、物理场地端和屏幕方向分开建模。
2. 撤销得分必须恢复关联比分、发接发、位置、换边和局结束状态，并保留审计历史。
3. 物理换边、同队左右调整和屏幕视角翻转是不同命令。
4. 重复 `commandId` 的相同请求只能生效一次；同 ID 不同内容必须拒绝。
5. 使用版本检查、写入租约、心跳和接管代号限制多设备并发写入。
6. 未收到服务器确认时不得显示成功；断网时禁止继续提交记分。
7. 已确认结果的更正必须预览其对名次、晋级和后续比赛的影响。

## 当前可执行命令

```bash
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run db:seed
pnpm dev
pnpm run build
pnpm run test:production-startup-security
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:e2e
node --test tests/sync-knowledge-base.test.mjs
pnpm run docs:sync:dry-run
pnpm run docs:sync
node scripts/sync-knowledge-base.mjs --adopt-target
```

`--adopt-target` 只用于已经把 Vault 手工修改逐字合并回仓库后的清单基线更新；只要内容不同或还有其他待同步变更就会拒绝。

项目用 pnpm 的 `devEngines.runtime` 在仓库命令中固定 Node 24.21.0；不要替换用户全局 Node。开发和测试数据库必须分离，自动化测试只允许连接以 `_test` 结尾的数据库。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

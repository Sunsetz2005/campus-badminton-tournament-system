# 校园羽毛球赛事编排与裁判管理系统 V1.0

> 当前状态：阶段 0 已建立需求、技术规划、项目知识库和安全同步工具。应用代码、业务页面、数据库表和登录功能均尚未实现，因此现在不能启动系统。

本项目计划建设一套中文响应式网页应用，让电脑、平板和手机共享同一后端和权威比赛数据，覆盖报名、分组、赛程、主裁判执裁、成绩复核、名次、成绩册和公开查询。

## 查看阶段 0 成果

1. 从 [`docs/knowledge-base/00-首页.md`](docs/knowledge-base/00-首页.md) 进入项目知识库。
2. 阅读 [`产品需求与范围`](docs/knowledge-base/01-项目规划/产品需求与范围.md) 和 [`需求验收追踪矩阵`](docs/knowledge-base/01-项目规划/需求验收追踪矩阵.md)。
3. 阅读 [`赛事执行规则 v1.0`](docs/knowledge-base/03-竞赛规则/赛事执行规则-v1.0.md) 和 [`需求补充 v1.0 差异记录`](docs/knowledge-base/01-项目规划/需求补充-v1.0差异记录.md)。
4. 查看 [`待老师确认的问题`](docs/knowledge-base/01-项目规划/待老师确认的问题.md)。
5. 运行同步工具测试和 dry-run，确认不会越界写入。

```bash
node --test tests/sync-knowledge-base.test.mjs
node scripts/sync-knowledge-base.mjs --dry-run
```

## V1 范围

- 赛事管理员、组织/编排人员、临场主裁判员、裁判长/授权负责人、只读公众五类角色。
- 男单、女单、男双、女双、混双由后台手工录入或 Excel/CSV 批量导入，保留跨项目人员冲突检查；再完成分组、循环赛/淘汰赛编排、场地与时间安排、裁判指派。
- 可实际执裁的单双打主裁判端，包括抛硬币、逐分记分、发接发分配、左右调整、物理换边、撤销、更正、操作历史和结果确认。
- 成绩复核、名次和晋级、成绩册导出、打印以及隐私受控的公开查询。

暂不开发原生 App、团体赛、支付、短信、直播、AI 视频判分、自动动作识别、多租户平台和离线合并记分。

## 技术基线

阶段 1 计划采用 Node.js 24.21.0 LTS、pnpm 11.9.0、Next.js 16.3.5、React 19.3.0、TypeScript 5.9.3、Prisma 7.10.0、PostgreSQL 15、Vitest 5.0.1 和 Playwright 1.63.0。确切依赖会在阶段 1 写入锁文件；阶段 0 没有安装或升级软件。

本机检查结果和选择理由见 [`技术选型与决策`](docs/knowledge-base/02-架构设计/技术选型与决策.md)。

## 发布知识库到 Obsidian

仓库中的 `docs/knowledge-base/` 是唯一权威源。同步目标固定为：

```text
/Users/a10954/Documents/Documents - Sunsetz的MacBook Pro/Obsidian Vault/羽毛球赛事管理系统
```

先预演；确认没有 `CONFLICT` 后才能应用：

```bash
node scripts/sync-knowledge-base.mjs --dry-run
node scripts/sync-knowledge-base.mjs --apply
node scripts/sync-knowledge-base.mjs --dry-run
```

同步工具不会删除目标文件。未知同名文件、人工改动或符号链接会阻止写入；更新前的副本保存在未提交的 `.local/kb-sync-backups/`。若已把 Vault 手工改动逐字合并回仓库，可单独运行 `--adopt-target` 更新清单基线；内容不一致或同时存在其他更新时会拒绝。完整策略见 [`备份恢复与部署`](docs/knowledge-base/07-使用部署/备份恢复与部署.md)。

## 阶段路线

| 阶段 | 交付目标 | 当前状态 |
|---|---|---|
| 0 | 需求、规划、知识库、安全同步 | 已完成后以测试记录为准 |
| 1 | 工程骨架、数据库、真实登录和权限 | 未实现 |
| 2 | 计分与双打规则引擎 | 未实现 |
| 3 | 主裁判工作台和多设备权威记分 | 未实现 |
| 4—8 | 报名编排、赛程、成绩、报表、可靠性 | 未实现 |
| 9 | 发布、备份恢复和成果归档 | 未实现 |

进入下一阶段前先查看 [`当前进度与下一步`](docs/knowledge-base/06-开发日志/当前进度与下一步.md)。

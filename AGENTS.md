# 项目协作约定

## 当前阶段

- 阶段 0、阶段 1 和阶段 2 已完成；S2-008 换边待办关系与 S2-009 特殊结果受控作废均已于 2026-09-20 通过独立复验。
- 阶段 3 的服务端计分事务、租约心跳/接管、响应未知恢复和场地图裁判工作台已通过本地自动化；联合独立验收对裁判工作台给出“有条件通过”，未发现功能性 P0—P2。场地图只投影权威状态，支持单双打、拟首发/拟首接、双打手动换位、物理换边、本机翻转视角、减分预览和 `UNKNOWN` 原 `commandId` 对账。
- UI-01-B 联合独立验收原判“不通过”，唯一 P1 是阶段 3 截图被重新生成但未记账；F-001—F-005 已由 Codex 做最小修复并完成本地回归，尚待独立复判，不能写成已通过。正式 BWF 规则采用、真机/真人裁判和正式生产验收仍未完成。
- 当前停在阶段 3 收尾的复判项；2026-09-21 已完成隔离的公网 HTTP 演示部署，并按用户授权扩充到 17 场人工直采模拟数据。2026-09-22 把演示站三个模拟账号改为管理员、裁判员、参赛选手三类固定名称（登录须输入完整邮箱）并统一演示口令，口令只保存在服务器 root-only 配置与交付记录中。HTTPS、域名、反向代理、恢复演练和正式生产验收仍未完成。
- 2026-09-22 用户明确授权进入阶段 4，并已完成**阶段 4-0 赛事门户**：赛事门户元数据与 `TournamentPhase`、逐场公开发布边界 `Match.publishedAt`、`Tournament.namePolicy` 姓名公开策略、真实数据驱动的公开赛程与比赛详情（UI-01-C）、导航按服务端角色收敛、海报上传。（抽签、排名、团体赛当时均未实现；报名与创建向导已于 4-A 补上。）
- 2026-09-24 按用户要求完成**阶段 4-A 赛事创建与报名**（到生成 `Entry` 为止，不生成比赛）：建赛向导、后台录入、CSV 导入、匿名邀请链接、审核生成 `Entry`；仅开发自测，未独立复判。
- 2026-09-24 按用户要求完成**阶段 4-B 抽签编排（团体赛优先）**：学院队伍与负责人登录账号（管理员开通、初始口令只显示一次、首次登录必须修改）、负责人提交团体名单（学号与性别必填）、单循环/小组循环＋淘汰/单淘汰抽签（种子、软回避、手动调签、可复现、版本与发布冻结、裁判长撤销），团体对抗按小场顺序生成比赛占位（出场名单未实现，不能计分）；仅开发自测，未独立复判。
- 2026-09-24 按用户要求完成**阶段 4-D 团体对抗**：名单报项（兼项不设上限，但出场只能用报了该项的队员）、负责人盲交出场名单（交齐同时公开并锁定，之后仅裁判长写原因调整未开始的小场）、对抗胜负随小场复核锁定/重开在同一事务内结算（循环打满、淘汰即止，未开始小场记「未进行」）、团体小组积分榜与裁判长名次确认、淘汰签位自动回填；仅开发自测，未独立复判。
- 2026-09-25 经用户明确授权完成**阶段 4-C 赛程与裁判排班**：场地/比赛日/预计时长设置、确定性自动建议（小组一组一块场地、对抗小场连打、淘汰赛多场地并行）、草稿逐场调整与立即复检（硬冲突不可放宽、警告须确认、未定晋级按候选集合标暂定）、发布版本与差异、主裁判指派同步「我的执裁」、裁判长临时换裁判（吊销旧控制会话）、延误推算（只作提示）、出场名单截止（开赛前 30 分钟，逾期管理员代交）与团体兼项上限；发布赛程同时公开已排定比赛。**休息间隔按用户决定不在系统内检查**，由线下裁判控场。仅开发自测，未独立复判。
- 2026-09-27 经用户明确授权完成**阶段 6 成绩、名次与晋级**：结果状态与仅结果补录（另一位裁判长独立复核）、「校园演示排名方案」可解释小组名次（特殊结果阻塞、裁判长排除、并列待裁定须写依据）、个人项目淘汰晋级、更正影响预览与下游已开赛阻止（只能登记人工处置）、名次榜单发布版本；仅开发自测，未独立复判。
- 2026-09-29 经用户明确授权完成**阶段 7 成绩册与公开查询**：一致性数据快照与数据修订号、赛事数据表与内部报名名单 Excel、A4 打印网页与 PDF 成绩册（同一模板、服务端无头 Chromium）、导出版本存档与「已被替代」、公开「对阵与名次」「成绩册」页、比赛详情结果性质标签/自动刷新/只读分享链接；二维码未做；服务器尚需 Chromium 与开源中文字体；仅开发自测，未独立复判。
- 2026-09-29 经用户明确授权完成**阶段 8 移动端与可靠性验收**：五视口 Chromium 设备模拟（360/390/768/1024/1440）、两设备同步与断网恢复、写接口来源校验与公开只读限流（`src/proxy.ts`、`src/server/security/`）、局域网登录受信来源修复、应用清单与屏幕常亮（不注册 Service Worker）、日志脱敏、生产构建上的负载基准与重启演练（`scripts/reliability/phase8-drill.ts`）；仅开发自测，**不是真机验收**，未独立复判。
- 下一阶段按 prompt-kit 是**阶段 9 发布与开发材料归档**。未经用户明确要求不得开始。
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

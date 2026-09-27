# 阶段 4-B 团体赛抽签编排界面证据

由 `tests/e2e/team-draw.spec.ts` 在本机生成（Playwright Chromium，`baseURL=http://127.0.0.1:3100`，数据库 `badminton_tournament_test`）。

- 固化命令：`PHASE4B_SHOT_DIR=shots pnpm exec dotenv -e .env.test -- pnpm exec playwright test tests/e2e/team-draw.spec.ts`
- 普通测试运行默认写入未提交的 `local-run/`，不会改写本目录的 `shots/`。
- 截图时只隐藏 `.skip-link`（Playwright `fullPage` 会把它重排进画面），并用 Playwright `mask` 遮住一次性初始口令（02 中的品红色块）；产品样式未改。
- 数据全部是测试运行中现场创建的模拟赛事、模拟学院与「学院简称＋序号」占位姓名，测试结束后删除该赛事与负责人账号；邮箱为保留域名 `example.invalid`，不含真实个人信息。

## 文件（`shots/`）

| 文件 | 视口 | 内容 |
|---|---|---|
| 01-wizard-team-format | 1280×900 | 建赛向导：团体赛设置（五个小场顺序、名单人数） |
| 02-team-manager-created | 1280×900 | 队伍与负责人：开通负责人账号，初始口令只显示一次（已遮挡） |
| 03-force-password-mobile | 390×844 | 负责人首次登录被引导修改初始口令 |
| 04-roster-submitted-mobile | 390×844 | 负责人在手机上提交 6 人名单（3 男 3 女），得到回执 |
| 05-review-team-roster | 1280×900 | 报名审核：团体名单显示队伍、人数、学号与性别 |
| 06-draw-draft | 1280×900 | 抽签草稿：8 个学院分 2 组、淘汰对阵引用「某组第几名」、回避全部满足 |
| 07-draw-published | 1280×900 | 手动调签后正式发布：16 场对抗、80 场小场比赛，名单冻结 |
| 08-draw-published-mobile | 390×844 | 同上，手机宽度（版本表横向滚动，无根级横向溢出） |
| 09-manager-locked-mobile | 390×844 | 发布后负责人看到「已抽签，名单锁定」 |

校验：`cd shots && shasum -a 256 -c SHA256SUMS`。这些是浏览器模拟截图，不是真机验收。

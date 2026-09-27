# 阶段 4-D 团体对抗界面证据

由 `tests/e2e/team-ties.spec.ts` 在本机生成（Playwright Chromium，`baseURL=http://127.0.0.1:3100`，数据库 `badminton_tournament_test`）。

- 固化命令：`PHASE4D_SHOT_DIR=shots pnpm exec dotenv -e .env.test -- pnpm exec playwright test tests/e2e/team-ties.spec.ts`
- 普通测试运行默认写入未提交的 `local-run/`，不会改写本目录的 `shots/`。
- 截图时只隐藏 `.skip-link`（Playwright `fullPage` 会把它重排进画面）；产品样式未改。
- 数据全部是测试运行中现场创建的模拟赛事、4 个模拟学院与「学院简称＋性别＋序号」占位姓名，测试结束后删除该赛事与负责人账号；邮箱为保留域名 `example.invalid`，不含真实个人信息。
- 30 个小场结果通过真实计分接口录入：主裁判记录「弃权」并提交，裁判长接管后复核锁定。因此积分榜的局数、分数为 0—0；按局分计分的正常比赛路径由阶段 3 的计分测试覆盖。裁判员/裁判长角色与小场指派由测试直接写库（裁判排班属于 4-C，未实现）。

## 文件（`shots/`）

| 文件 | 视口 | 内容 |
|---|---|---|
| 01-roster-events-mobile | 390×844 | 负责人提交名单：每名队员按性别勾选报项；报「男双」人数不够时先被逐条拒绝，补勾后提交成功 |
| 02-manager-ties-mobile | 390×844 | 抽签发布后「我的队伍」列出本队 3 场对抗与名单状态 |
| 03-lineup-submitted-mobile | 390×844 | 盲交出场名单：每个位置只列报了该项的队员，兼项提示；提交后对方一列只显示「未提交」 |
| 04-admin-blind-status | 1280×900 | 后台单场对抗：交齐前只显示「已提交（第 1 版）」与「已提交，未公开」，不显示名单内容 |
| 05-lineups-revealed | 1280×900 | 管理员代交另一方后，双方名单同时公开并锁定；裁判长调整上场队员面板 |
| 06-officiating-rubber | 1280×900 | 裁判长从小场编号进入执裁台：标题为「学院团体赛 · 第 5 场混双」，两侧为学院，展开后显示上场队员 |
| 07-standings-lots | 1280×900 | 全部对抗结束：三队循环相克且各项相同，积分榜标「须抽签」，确认面板只允许调整这三队 |
| 08-standings-confirmed | 1280×900 | 裁判长按抽签结果调整顺序、写明抽签情况后确认名次 |
| 09-manager-tie-result-mobile | 390×844 | 负责人查看已结束的对抗：大比分、每个小场的双方队员与结果 |

校验：`cd shots && shasum -a 256 -c SHA256SUMS`。这些是浏览器模拟截图，不是真机验收，也不是真实负责人或裁判的试用。

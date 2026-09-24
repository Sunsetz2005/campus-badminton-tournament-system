# 阶段 4-A 赛事创建与报名界面证据

由 `tests/e2e/registration.spec.ts` 在本机生成（Playwright Chromium，`baseURL=http://127.0.0.1:3100`，数据库 `badminton_tournament_test`）。

- 固化命令：`PHASE4A_SHOT_DIR=shots pnpm exec dotenv -e .env.test -- pnpm exec playwright test tests/e2e/registration.spec.ts`
- 普通测试运行默认写入未提交的 `local-run/`，不会改写本目录的 `shots/`。
- 截图时只隐藏 `.skip-link`：Playwright `fullPage` 会把 `position: fixed` 的「跳到主要内容」重排进画面（未获焦点时实际位于视口外），产品样式未改。
- 数据全部是测试运行中现场创建的模拟赛事与模拟姓名，测试结束后删除该赛事；不含真实个人信息。

## 文件（`shots/`）

| 文件 | 视口 | 内容 |
|---|---|---|
| 01-wizard-basics | 1280×900 | 新建赛事向导·基本信息 |
| 02-wizard-competitions | 1280×900 | 向导·比赛项目（男单、女单、男双） |
| 03-wizard-confirm | 1280×900 | 向导·确认页 |
| 04-overview-invite | 1280×900 | 赛事后台：开放报名后生成邀请链接（明文只显示一次） |
| 05-invite-form-mobile | 390×844 | 匿名邀请报名表单（手机） |
| 06-invite-receipt-mobile | 390×844 | 提交后的待审核回执（手机） |
| 07-review-identity-ambiguous | 1280×900 | 同名无学号：必须人工确认身份，「通过」按钮禁用 |
| 08-review-approved | 1280×900 | 已通过 3 份，人员名单中两名「李华」为不同人员 |
| 09-import-errors | 1280×900 | CSV 预览：第 3、4 行错误，整份不可导入 |
| 10-import-committed | 1280×900 | 修正后导入 2 份待审核报名 |

校验：`cd shots && shasum -a 256 -c SHA256SUMS`。这些是浏览器模拟截图，不是真机验收。

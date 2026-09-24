# 阶段 4-0 赛事门户界面证据

本目录记录阶段 4-0「赛事门户」的只读界面证据，由 `tests/e2e/public-portal.spec.ts` 在本机运行时生成。

## 来源与条件

- 生成命令：`pnpm run test:e2e`（Playwright Chromium，`baseURL=http://127.0.0.1:3100`）。
- 数据来源：**真实 `badminton_tournament_test` 数据库**经公开投影渲染，不是虚构夹具。
  这与 `artifacts/ui-01/project-preview/` 不同，后者是 UI-01-B 的隔离模拟预览。
- 赛事数据仍是模拟种子（`prisma/seed.ts`）：阶段 1 匿名模拟赛 17 场，另加两个只有赛事级信息、
  没有任何比赛的模拟赛事，用于检查首页的「即将开始」与「已结束」分组。

## 文件

- `home-{375x812,390x844,768x1024,1024x768,1440x1000}.png`：首页赛事列表。
- `schedule-{同上}.png`：`/public/phase-1-demo/schedule?date=2026-09-21` 每日赛程。
- `detail-{390x844,1440x1000}.png`：`/public/phase-1-demo/matches/MS-DONE-001` 比赛详情。

## 断言范围

每张截图对应的用例都断言 `document.documentElement.scrollWidth <= clientWidth`，
即这些 **Chromium 模拟视口**下没有根级横向溢出。

## 这些证据不包含

- 真机手机、平板、读屏软件或真实用户的可访问性验收。
- 对比度、触摸目标尺寸的量测。
- 生产部署验收：截图来自本机 `_test` 库，不是公网演示站。
- 任何真实学生资料；页面中的姓名、代表队与比分全部来自模拟种子。

文件 SHA-256 记录在同目录 `SHA256SUMS`。

# 阶段 4-0 赛事门户界面证据

本目录记录阶段 4-0「赛事门户」的只读界面证据，由 `tests/e2e/public-portal.spec.ts` 在本机运行时生成。

## 来源与条件

- 固化命令：`PHASE4_PORTAL_SHOT_DIR=. pnpm exec dotenv -e .env.test -- pnpm exec playwright test tests/e2e/public-portal.spec.ts`（Playwright Chromium，`baseURL=http://127.0.0.1:3100`）。
- 2026-09-24 起，普通测试运行（含 `pnpm run test:e2e`）默认写入未提交的 `local-run/`，不再改写本目录已记账的截图。
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

文件 SHA-256 记录在同目录 `SHA256SUMS`，校验：`shasum -a 256 -c SHA256SUMS`。

## 2026-09-24 校验清单更正

在已提交的 `299b029` 中，本目录的截图字节与清单不一致：`shasum -a 256 -c SHA256SUMS` 为 10 项 OK、2 项 FAILED（`detail-1440x1000.png`、`detail-390x844.png`，退出码 1）。原因是本 spec 当时直接写入本目录，清单生成后又有测试运行改写了这两张图；无法从现有记录判断是哪一次运行，已提交的图也不是清单记录的那一版。

处理方式（与阶段 3 的 DOC-004 相同）：

- 没有重新截图，也没有改动任何 PNG：12 张图保持 `299b029` 的字节。
- 原清单改名保留为 `SHA256SUMS.superseded-2026-09-24`（其中两条 `detail-*` 记录对应的字节在仓库历史中不存在，无法复现）。
- 按已提交字节重算 `SHA256SUMS`，自校验 12/12 OK。与旧清单相比只有两条 `detail-*` 不同，其余 10 条完全一致：

| 文件 | 旧清单 | 新清单（已提交字节） |
|---|---|---|
| `detail-1440x1000.png` | `f7f9d8442d4a7f957033fe5350fc28c5f7610260ca526c13de171895f4e5b081` | `1a38b6d37261ce4840a22e9f53adb4e3c971c7b9fa138bddaa8e13168f727ee9` |
| `detail-390x844.png` | `1a7ab7fb8d7e5ad7a47ef7cbd68ae5d36959c03b1c58830c57aaddae47bffb15` | `6732a548bf196a97ba4f2b53a43ab7b690eeb60057aff569c60251077bd8748c` |

重算只是让清单与现存文件对齐，不能证明这两张图就是 4-0 验收当时看到的那一版。

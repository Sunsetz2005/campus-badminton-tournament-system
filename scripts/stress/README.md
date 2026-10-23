# 全赛制并发仿真（scripts/stress）

依据：`docs/knowledge-base/05-测试验收/全赛制并发仿真-测试方案.md`（§12 实现计划、§13 批准时追加的要求）。

## 边界

- **所有写入只经 HTTP 接口**，与浏览器用同一批路由。仿真进程自己的数据库会话被设成 `default_transaction_read_only=on`
  （`core/readonly-env.ts`，必须是入口的第一个 import），任何经 Prisma 的写入都会被数据库拒绝。
- 只连接库名含 `stress` 且以 `_test` 结尾的库（`assertTestDatabaseUrl` + 额外检查）。不碰开发库、演示库、`.env`。
- 只读查询分两类：①「页面同源数据」——管理页、我的执裁、赛程排班页显示但没有 GET 接口的内容（项目/报名/对阵编号、
  警告摘要、我的执裁列表），按页面会显示的范围读取；② 判定阶段读取事件、快照、签位。
- 不改业务代码；遇到系统缺口时记录「发现」（接口、请求、响应、状态）并跳过该分支。

## 准备

```bash
cp .env.stress.example .env.stress   # 填写本机用户、测试密钥与种子账号（与 .env.test 同一套即可）
pnpm run stress:prepare              # 建库 + migrate deploy + 种子（只增不删）
pnpm run stress:build                # 生产构建（与阶段 8 相同参数）
```

## 运行

```bash
pnpm run stress -- --level L1 --clock C8 --seed 20261023
pnpm run stress -- --level L0 --clock C32 --seed 1 --max-minutes 15   # 开发冒烟
```

| 参数 | 含义 |
|---|---|
| `--level L0\|L1\|L3` | 规模（`config/levels.ts`）。L0 只用于调通流程 |
| `--clock C8\|C3\|R1\|C32` | 时间档（`core/clock.ts`）。C32 只用于开发冒烟，不作判定口径 |
| `--seed` | 总种子；名单、抽签设种、走向、注入点各自派生子流 |
| `--same-ip` | 所有模拟客户端共用一个来源（§13.2 同出口场景）；缺省每个客户端一个 `x-forwarded-for` |
| `--public-rate` | 覆盖公开接口每分钟额度 |
| `--external` | 不自起服务，连接 `BETTER_AUTH_URL` 上已在运行的实例 |
| `--max-minutes` / `--stall-minutes` | 总时限 / 无进展判定卡住的时长 |

被测服务以生产模式 `next start` 起在 `BETTER_AUTH_URL` 的端口（默认 3200）。生产模式下 `assertRuntimeSecurity` 禁止
`ENABLE_TEST_FAULT_INJECTION`，因此依赖 `x-test-response-delay-ms` 的注入要单独起非生产实例（M4）。

## 产物

`artifacts/stress/<seed>-<时间>/`（已被 .gitignore 忽略）：

- `params.json` 参数与环境；`run.log` 运行日志；`server.log` 被测服务输出；
- `requests.jsonl` 逐条请求（脱敏：不含 Cookie、令牌、口令、请求体）；
- `result.json` 每场执裁结果、复核与名单记录、发现、指标汇总。

运行时生成的口令写到 `.local/stress/<runId>.json`（权限 600，未提交），不进任何产物。

## 结构

```
run.ts                入口：准备 → 起服务 → 建赛/报名/抽签/赛程 → 现场 → 榜单 → 产物
config/levels.ts      规模档
core/                 rng 可复现随机 · clock 压缩时钟 · http 客户端 · metrics 指标 · server 被测服务 · db 只读查询 · time 时区
scenario/             roster 名单生成 · setup 建赛与裁判长 · registration 报名与审核 · draw 抽签 · schedule 赛程 · lineup 出场名单
live/                 narrative 比赛走向 · referee 单场执裁 · venue 场地调度 · chief 复核与小组名次 · officiating 我的执裁缓存
```

判定（oracle/verify）与报告在 M2 加入。

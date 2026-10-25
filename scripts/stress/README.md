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
| `--referee-mode SHARED_ACCOUNT\|PER_MATCH` | 主赛事 M 的裁判模式（卫星赛事固定共用账号，§13.9） |
| `--scenarios ties,delays,inject` | 强制同分 / 延误七情形 / 异常注入（M4） |
| `--only <组,…>` | 只跑指定注入组，见下 |

被测服务以生产模式 `next start` 起在 `BETTER_AUTH_URL` 的端口（默认 3200）。端口上已有服务（例如上一轮被强杀后遗留）时
拒绝启动，免得就绪检查打到连着别的库的旧实例；仿真进程收到 SIGTERM/SIGINT 时先关掉被测服务再退出。生产模式下
`assertRuntimeSecurity` 禁止 `ENABLE_TEST_FAULT_INJECTION`，因此「响应超时」类注入用客户端超时实现，不依赖测试头。

### 异常注入（M4，`--scenarios inject`）

每项注入记一条「期望 / 实际 / 结论」（符合、不符、设计未定义、未触发、脚本错误），写进 `result.json` 的 `probes`
和报告「异常注入」一节。注入借用一场比赛，由注入协程执裁，结束时把命令并入本场结果，判定照常逐条核对。

| 组 | 内容 | 模式 |
|---|---|---|
| `commands` | §7.1—7.4、7.8、7.10—7.12：重复/冲突 commandId、过期版本、超时对账、乱序、撤销并发、结束瞬间 | 共用账号 |
| `sessions` | §7.5—7.7、7.9：两会话抢控制、同设备复用、裁判长接管、心跳中断；共用账号中途换人 | 共用账号 |
| `handover` / `pending` | §13.9 裁判带设备离场三种方式；交接时有待办（间歇、换边、待提交） | 共用账号 |
| `browser` | §13.3 无头 Chromium 驱动真实工作台：误关标签页、复制标签页、冻结（调试器暂停脚本）/ 页面被杀、在途命令断网 | 共用账号 |
| `restart` | §7.13 命令在途时停、启被测服务 | 共用账号 |
| `dbfaults` | §13.4 断开被测服务的库连接、60 个读客户端占满应用池；设 `STRESS_DB_CONTAINER` 时再做库重启与 max_connections 占满 | 共用账号 |
| `lineup` / `confirm` / `reopen` | §7.14—7.16 名单截止与版本、§7.18 两名裁判长并发复核、§7.19 结果重开（下一轮未开赛 / 已开赛）；§7.17 赛后汇总 | 共用账号 |
| `swap-before` / `swap-busy` / `swap-mid` / `swap-mid-other` / `overrun` | §13.9 换人（赛前、换上正在执裁的人、中途同设备/换设备）、裁判上一场拖长；指派冲突发布检查总是执行 | 逐场指派 |

库重启与 max_connections 只能在独立容器上做：`STRESS_DB_CONTAINER` 指向的容器名必须以 `badminton-stress-` 开头，否则拒绝操作；
连接串放在未提交的 `.env.stress-container`（同样要求库名含 `stress` 且以 `_test` 结尾）。停库期间仿真进程若退出，会在退出前把容器启动回来。
仿真自己的只读查询遇到连接类错误（库重启、连接被断开、连接数占满）时等待恢复后重试，最多 90 秒。

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
                      injections / team-injections / referee-injections / browser / db-injections 异常注入（M4）
```

判定在 `verify.ts` 与 `verify/`，报告在 `report/`。

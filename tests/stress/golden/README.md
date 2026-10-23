# oracle 黄金用例

`scripts/stress/oracle/` 是仿真判定用的独立实现（不引用 `src/domain`）。它本身先要被证明是对的：

- `manual/`：**人工核对用例**，按竞赛规程手算 `expected` 后放入。仿真进入排名类判定前先跑这些用例，有一条失败就停止判定；
  没有 `expected` 的（含各目录的 `TEMPLATE.json`）记为「待填写」，报告开头会注明「oracle 尚未经人工用例核对」。
  - `same-points-ranking/` 同分排名 · `tied-placements/` 并列名次 · `byes/` 轮空
- `auto/`：仿真作者写的用例，与人工用例分开。

格式（三种 `kind`）：

| kind | input | expected |
|---|---|---|
| `ranking` | `entryKind`（INDIVIDUAL/TEAM）、`entries`、`matches`（个人 `games: [[a,b],…]`；团体 `rubbers: [[[a,b],…],…]`，A 方在前） | `order`（名次顺序）、`unresolved`（须抽签的并列块；块内顺序不比较） |
| `placements` | `thirdPlaceMatch`、`fixtures`（code/kind/round/sideA/sideB/winner） | `[{ entryId, place, tied }]` |
| `byes` | `qualifierRanks`（全部出线者的小组名次） | `{ bracketSize, byes, byeRanks }` |

运行：`pnpm exec vitest run tests/stress/oracle.test.ts`（纯计算，不连数据库）。

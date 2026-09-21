# R3-002 / R3-003 浏览器注入证据（本机实测）

命令：`pnpm exec dotenv -e .env.test -- pnpm exec playwright test tests/e2e/scoring-reliability-injection.spec.ts`
数据库：`badminton_tournament_test`（隔离测试库）。日期：2026-09-21。

「修复前」= 本机 `git show HEAD:src/components/scoring-workbench.tsx`（commit 70fff5e，即审查基线之后的本机版本），
临时写回工作区运行后立即还原，未提交、未改动其他文件。

| 用例 | 修复前实际 | 修复后实际 |
|---|---|---|
| R3-002 已取得 v(n) 后按原 commandId 找回旧回执 | 比分从 2 倒退为 1 并停留（采样 30 次：`["2","2","2","2","2","2","1",…,"1"]`） | 采样 30 次全为 `"2"`，命令仍被正确核销，提示「界面继续显示更新的服务器权威状态」 |
| R3-003 服务器已落库、网关返回 502 | 未出现待确认恢复面板；pending 被直接删除 | 保留原 commandId，恢复面板出现，加分按钮禁用，事件表该 commandId 恰好 1 条 |
| R3-003 200 但响应缺少 state | 未出现待确认恢复面板 | 保留 pending、同步状态显示「响应待确认」 |
| R3-003 本机 pending 记录 JSON 损坏 | 页面抛出未捕获异常 `unhandledRejection: SyntaxError: Expected property name or '}' in JSON at position 1`，并把损坏记录当作普通待确认命令 | 进入受控恢复，提示「本机待确认命令记录无法解析」，记录未被清空，加分按钮禁用 |

注：修复前 R3-002 的倒退会被 2 秒轮询掩盖，因此用例在采样窗口内延迟 `/state` 响应，直接观察倒退本身。

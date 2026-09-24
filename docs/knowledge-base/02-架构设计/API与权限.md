---
title: API 与权限
stage: 4
status: current
updated: 2026-09-24
tags:
  - 羽毛球赛事管理系统
  - API
  - 权限
---

# API 与权限

阶段 3 已将纯规则引擎接入真实 PostgreSQL 事务和裁判工作台。当前实现为轻量轮询，不使用 WebSocket/SSE；断网禁止写入，不支持离线合并记分。

## 已实现接口

| 路由 | 方法 | 权限与返回 |
|---|---|---|
| `/api/auth/[...all]` | GET/POST | Better Auth；公开注册不受模拟种子开关影响并始终关闭，登录建立数据库会话 |
| `/api/health` | GET | 只返回服务状态、数据库连通状态和服务端时间 |
| `/api/public/tournaments/[slug]` | GET | 只读白名单 DTO，不返回账号、内部 ID 或审计字段 |
| `/api/matches/[matchCode]/control` | POST | 必须登录、账号启用、拥有赛事 `REFEREE` 角色且被指派为该场主裁判；建立最小活动控制会话；已登录用户的 403 拒绝写入脱敏审计 |
| `/api/matches/[matchCode]/state` | GET | 获指派主裁判或该赛事裁判长读取权威快照；`afterVersion` 未变时返回轻量 `unchanged` |
| `/api/matches/[matchCode]/control` | POST/DELETE | 取得/同设备恢复或主动释放写租约 |
| `/api/matches/[matchCode]/control/heartbeat` | PUT | 当前 token、会话和代次一致时按服务器时间续租 120 秒 |
| `/api/matches/[matchCode]/control/takeover` | POST | `CHIEF_REFEREE` 填写原因后原子撤销旧会话、提高代次并建立新会话 |
| `/api/matches/[matchCode]/commands` | POST | 单事务执行授权、租约、幂等、版本、纯引擎、事件、快照、局分投影和审计 |
| `/api/matches/[matchCode]/commands/preview` | POST | 使用同一引擎返回更正前后差异，不落库 |
| `/api/matches/[matchCode]/commands/[commandId]` | GET | 响应未知或刷新后查询原命令结果 |
| `/api/admin/tournaments` | POST | 阶段 4-A：新建赛事，需平台级 `SYSTEM_ADMIN`；创建者自动获该赛事 `ADMIN` |
| `/api/admin/tournaments/[slug]/settings` | PATCH | 赛事 `ADMIN`：报名窗口（按赛事时区）与规程说明；开赛后拒绝 |
| `/api/admin/tournaments/[slug]/phase` | POST | 赛事 `ADMIN`：筹备→报名中→截止，截止→重开须原因；RUNNING/FINISHED 不在 4-A |
| `/api/admin/tournaments/[slug]/publish` | POST | 赛事 `ADMIN`：DRAFT→PUBLISHED，需日期与至少一个项目，不可撤回 |
| `/api/admin/tournaments/[slug]/competitions` | POST | 赛事 `ADMIN`：新增项目或组别 |
| `/api/admin/tournaments/[slug]/registrations` | POST | 赛事 `ADMIN`/`ORGANIZER`：手工录入，只生成待审核报名 |
| `/api/admin/tournaments/[slug]/registrations/[id]/review` | POST | 赛事 `ADMIN`/`ORGANIZER`：`APPROVE`（可带逐成员身份决定）/`REJECT`/`WITHDRAW`，必须带 `expectedVersion`；驳回与撤回须原因；身份需确认时 409 并在 `error.details.candidates` 返回候选人 |
| `/api/admin/tournaments/[slug]/registrations/batch-approve` | POST | 同上角色：逐份独立事务，最多 100 份，需人工确认的保持待审核 |
| `/api/admin/tournaments/[slug]/participants/[publicCode]/rename` | POST | 同上角色：同一人姓名更正，须原因并审计；不是换人 |
| `/api/admin/tournaments/[slug]/imports/template` | GET | 同上角色：CSV 模板（UTF-8 BOM） |
| `/api/admin/tournaments/[slug]/imports/preview` | POST | 同上角色：multipart 上传，逐行返回新增/重复/错误，联系方式打码，原文件不保存 |
| `/api/admin/tournaments/[slug]/imports/commit` | POST | 同上角色：重新上传同一文件并带预览的摘要与计数；不一致 409，有错误 422，整份单事务 |
| `/api/admin/tournaments/[slug]/invites` | POST | 同上角色：生成邀请链接，明文令牌只在本响应中出现一次 |
| `/api/admin/tournaments/[slug]/invites/[inviteId]/revoke` | POST | 同上角色：停用邀请链接 |
| `/api/register/[token]` | POST | **匿名**：邀请报名提交；不登录、不建账号；令牌无效统一 404；报名窗口外 409；限流 429；需同意声明 |

`requireAssignedReferee` 仍只允许拥有 `REFEREE` 且被指派的主裁判正常取得租约。裁判长不绕过流程普通取权，而是使用专用 takeover 接口；现有管理员模拟账号同时获授 `CHIEF_REFEREE`，每次敏感操作审计实际使用的裁判长角色，不依赖 `ADMIN`。

## 状态变更命令信封

```json
{
  "commandId": "uuid",
  "expectedVersion": 42,
  "scoringSessionId": "session-id",
  "takeoverGeneration": 3,
  "type": "RALLY_WON",
  "payload": {
    "side": "A"
  }
}
```

控制 token 放在 `Authorization: Bearer ...` header，不写入响应、事件或审计元数据。

操作者、角色和赛事范围必须从服务器认证会话取得，不能相信客户端提交的 `actorId`。服务端为规范化后的命令类型与载荷计算摘要，并在一个数据库事务内完成授权、并发检查、幂等处理、事件追加和快照更新。

## 响应语义

| 状态 | 含义 | 客户端动作 |
|---|---|---|
| `accepted` | 命令首次成功应用 | 采用返回的权威快照和版本 |
| `duplicate` | 同 ID、同内容已成功处理 | 不重复加分，采用原处理结果 |
| `conflict` | `expectedVersion` 已过期 | 停止写入，获取权威状态并提示处理 |
| `not_controller` | 租约无效或已被接管 | 切换只读，显示当前控制设备 |
| `rejected` | 状态、权限或参数不合法 | 显示明确原因，不做乐观成功 |

网络超时不是上述任何成功状态。客户端将命令保持为 `unknown`，用同一 `commandId` 查询或重试；不得生成新 ID 再加一次分。

## 服务端授权顺序

1. 验证登录会话、账号启用状态和 CSRF/请求来源策略。
2. 读取赛事和比赛，检查操作者角色及 `OfficialAssignment`。
3. 验证比赛生命周期是否允许该命令。
4. 验证有效 `MatchLease`、设备会话和 `takeoverGeneration`。
5. 检查已存在的 `commandId` 与载荷摘要。
6. 检查 `expectedVersion`。
7. 执行业务 reducer，追加审计并提交事务。

即使某个步骤可在客户端预检，服务端仍必须重复执行。

## 租约和接管

- 一场比赛同一时刻只允许一个有效写租约。
- 心跳只能延长当前代号的租约，不能复活旧代号。
- 裁判长接管时递增 `takeoverGeneration`；旧设备的后续请求即使持有旧 token 也要拒绝。
- 租约过期不等于自动把比赛交给任意设备；重新取得控制必须走明确流程。
- 所有观察设备可读取权威状态，但无租约时只读。

## 角色权限矩阵补充

| 操作 | 主裁判 | 裁判长 | 管理员/编排员 |
|---|---|---|---|
| 名单、分组、场地、赛程 | 查看本人任务 | 审核特殊安排 | 维护授权范围 |
| 进行中记分、最近误点撤销 | 仅本人指派且有租约 | 明确接管后允许 | 不因管理员身份自动允许 |
| 发接发/左右状态纠正 | 可以，必须留原因 | 接管后处理 | 不能直接执裁 |
| WO/RET/DSQ | 记录事实、提交请求 | 最终确认 | 不能替代裁决 |
| 强制接管/更换主裁判 | 不得抢占 | 允许，记录原因 | 仅技术协助 |
| 成绩复核、解锁、追溯修订 | 提交/申请 | 批准处理 | 不得直接改分 |
| 发布成绩册 | 查看已发布版 | 审核锁定数据 | 发布已复核快照 |

同一使用者可以兼任角色，但每次敏感操作记录实际身份和所用角色；不能伪造两人独立复核。管理员授予角色、撤销角色和紧急访问也要审计。

## 录入、公开与导出接口

- 导入（阶段 4-A 已实现）：预览不落库，确认时重新上传同一文件并携带预览的内容摘要与新增/重复计数，服务端在赛事行锁内重算，一致才整份写入；`RegistrationImportBatch` 按内容摘要唯一，重复导入被拒；导入只生成待审核报名，人员在审核通过时才建立，因此不会重复建人。
- 排程冲突接口以运动员内部 ID 展开组合，跨 MS/WS/MD/WD/XD 返回冲突成员和时间原因。
- 公开查询只返回服务端白名单 DTO；没有姓名发布决定时使用公开编号/别名。
- PDF/Excel 任务只接受授权赛事和锁定快照 ID，不接受任意 URL；生成记录保存快照、模板、哈希、版本和替代关系。

## 数据安全

- 密码只保存强哈希，密钥只在本地/部署环境变量中，不进入 Git 或 Vault。
- 导入文本按不可信输入处理：单元格只当文本，以 `= + - @` 开头（联系方式允许 `+86…`）、含换行或控制字符的内容拒绝入库；导出 CSV/XLSX 时仍需中和公式载荷。
- 邀请令牌只存 SHA-256 摘要；来源地址只以带密钥的 HMAC 指纹保存。无反向代理时 `x-forwarded-for` 可伪造，按来源限流只是尽力而为，真正上限是按邀请的总量与每分钟窗口。
- 报名页 `noindex` 且 `referrer: no-referrer`，避免带令牌的地址被收录或经 Referer 外泄。
- 公开 API 使用白名单 DTO，不返回学号、电话、邮箱、登录字段和内部审计信息。
- 错误响应不泄露 SQL、堆栈、token 或其他参赛者私密数据。

## 权限测试门禁

阶段 3 已在真实 `_test` 数据库与 HTTP 路由覆盖过期版本、幂等重试、异载荷复用、两命令并发、心跳、裁判长接管、旧设备拒写、响应超时查询原 ID、快照篡改拒写和整事务回滚。测试范围见[黄金用例与回归清单](../05-测试验收/黄金用例与回归清单.md)。

# 使用说明：基于真实源码的裁判工作台修复与优化 V3

审查基线：`main` / `84a159218b300de333e101da5af6ea8d51d3bacb`。审查日期：2026-09-21。

本次已通过 GitHub 连接读取源码，不再是此前“无法读取仓库、请 Claude 自行确认全部假设”的状态。
但本次不是完整项目运行验收：没有启动 Next.js、PostgreSQL 或真实裁判界面，没有运行仓库的全量测试；仅运行了一份明确标注的阈值逻辑提取复现。仓库 README 中旧的测试通过数不是本次测试结果。

## 怎样使用

把本文件夹放在当前项目根目录下：

```text
requirements/badminton-source-review-v3/
```

让 Codex 停止修改同一工作区，再在同一个项目中打开 Claude Code。将 `01-Claude修复与界面优化提示词.md` 的全部内容交给 Claude，或让其直接读取执行。

先读审查报告和验收用例，再在原项目重现问题。若本机比上述提交更新，比较差异后处理仍然存在的问题，不回滚到审查版本，也不重复修复已经解决的问题。

## 文件

- `00-源码审查报告.md`：证据、影响、范围限制及建议。
- `01-Claude修复与界面优化提示词.md`：直接执行的开发任务。
- `02-回归验收用例.md`：行为验收清单。
- `evidence/threshold-extract-repro.mjs`：从阈值相关源码提取的最小复现，不是整个原项目。
- `evidence/threshold-extract-result.json`：本轮实际运行输出，Node v22.16.0。

旧的 V2 图片仍可作为视觉意向，但不能要求 Claude 从零重建已经存在的场地图和计分服务。以当前代码、用户确认需求及已核实规则为准。

## Obsidian 特别注意

当前仓库 `scripts/sync-knowledge-base.mjs` 的允许目录是：

```text
/Users/a10954/Documents/Documents - Sunsetz的MacBook Pro/Obsidian Vault/羽毛球赛事管理系统
```

没有中间的 `项目/`。不要按早期聊天建议另外创建一份知识库，不更改同步安全策略来绕过路径检查。

本包只提供审查与执行指令，未修改远程仓库、用户本机、数据库或 Obsidian。

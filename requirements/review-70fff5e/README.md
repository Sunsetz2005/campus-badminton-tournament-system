# 最新源码审查与 Claude 修复任务

审查基线：`Sunsetz2005/campus-badminton-tournament-system`，`main`，提交 `70fff5e87c9252e0bd6cbd13060d6d870dd4cd37`（2026-09-21）。

## 这是什么

- `01-最新源码审查.md`：基于实际读取的 GitHub 源码，区分已确认代码路径、条件性风险及修复建议。
- `02-Claude修复提示词.md`：可以交给本机 Claude Code 的完整任务。
- `tests/referee-boundary-regressions.review.test.ts`：针对规则引擎的新增回归测试草案，需在项目实际依赖环境中执行。

## 使用

将本文件夹放到现有项目 `requirements/review-70fff5e/`，先让 Codex 停止修改，再让 Claude 读取前两份 Markdown。

测试文件不要直接视为已通过的证据。让 Claude 审阅后复制到项目 `tests/domain/`，先记录旧实现真实结果，再修复。读取测试脚本与数据库安全设置后运行。不要把新测试内容复制到旧测试里覆盖原断言。

## 边界

本轮通过 GitHub 连接成功读取源码和提交信息，但没有在当前环境完整克隆、安装或启动仓库，没有运行项目 Vitest、Playwright、数据库迁移、构建及真机测试。仓库提交说明中的本地通过数不属于本轮独立执行结果。附带测试仅做了语法检查，业务结果未运行。

本包没有修改 GitHub、你的 Mac、现有代码或 Obsidian；没有包含密钥、真实学生数据、完整源码或字体文件。

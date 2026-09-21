# 阶段 3 浏览器模拟截图证据

## 清单为什么被重算（2026-09-21）

`SHA256SUMS` 原有 6 条记录与仓库里这 6 张 PNG 的实际字节不一致：
`git checkout` 还原到 HEAD 提交的字节后 `shasum -a 256 -c SHA256SUMS` 仍然 6/6 FAILED。
原因是 `tests/e2e/phase-3.spec.ts` 过去每次运行都无条件重写这个目录却不更新清单，
早于本轮的某次运行覆盖了截图而清单停留在更早的字节上。旧清单记录的那些字节已经不存在于任何提交中。

本轮做了两件事：

1. `tests/e2e/phase-3.spec.ts` 与 `tests/e2e/referee-court-shots.spec.ts` 默认改写到未提交的
   `*-local-run` 目录（已加入 `.gitignore`）。只有显式设置 `PHASE3_SHOT_DIR` / `REFEREE_SHOT_DIR`
   才会写入已记账的证据目录，普通测试运行不再覆盖证据。
2. `SHA256SUMS` 按当前已提交的字节重算，使清单与目录内容自洽、可复验。
   原清单原样保留为 `SHA256SUMS.superseded-2026-09-21`，没有删除。

**这次重算只是让清单与现存文件对齐，并不是复现了旧清单的那些字节。**
这些是 Chromium 设备模拟截图，不是真机测试证据。

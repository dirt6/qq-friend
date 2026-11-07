# D1-3b-B3 报告：MemoryStore 删除备份与路径安全

> 时间：2026-11-04
> Commit：见下（独立提交）

## 实现

- `removeMember` / `removeChat` 现在在同一把 `withMemoryPortLock` 锁内完成：
  读最新数据 → 路径校验 → 备份 → 逐文件 SHA256 校验 → 删除 → 审计 → 返回结果；
- 备份目录：`data/memory/backups/<chatDir>/<stamp>-<opId>/`，含 `manifest.json`（opId、目标、文件清单、SHA256、时间）；
- 备份目标唯一（stamp+opId），**不覆盖历史备份**；
- 审计：`data/memory/backups/audit.jsonl`（opId、op、chatKey、backupDir、文件数、结果）；
- 路径安全：`realish()` 解析真实路径 + 大小写归一，目标必须严格位于 `MEMORY_DIR` 内；拒绝根目录/空路径/`..`/符号链接越界；
- `removeChat` 对**未识别文件**（非 `.json`）拒绝删除并报告文件名；
- `restoreMemoryBackup()`（内部函数，未暴露路由）：校验备份 hash、原目标已存在则拒绝覆盖、失败保留备份；
- 返回对象：`{ok, opId, target, backupDir, files, verified, removed, error?}`；路由已适配并返回 `result`。

## 专项测试

`test/diary-memory-delete-test.mjs`（统一启动器，17 项）：

- removeMember / removeChat 正常备份+校验+删除；
- 备份失败拒绝删除；删除失败保留备份与源文件；
- 恢复成功 / 原目标已存在拒绝 / 备份损坏拒绝；
- 未识别文件保护；空参数；junction 越界拒绝（实测）；
- 审计记录、备份目录唯一；双进程并发删除只有一个成功、不覆盖。

**17/17 通过。**

## 回归

- memory 相关：`memory-hub-impression-key`、`memory-port-lock`、`memory-store-lock`、`companion-core-integration` 全过；
- `coverage-http`：112 通过 / 4 失败（与既有基线一致；该测试进程结束后不自动退出，需人工终止，属既有环境问题）；
- 全量：**69 项，66 PASS / 3 FAIL**（`selftest`、`tools-skill-audit`、`gallery-test`，均为既有基线失败；本次 `setup-qq-version` 通过）。

## 生产保护

- 生产 `data/memory` 聚合 hash 前后一致（`5D4B8C9E…77C56`）；
- 生产 `learned.json` hash 前后一致（`230EA2D6…01570B`）；
- 生产目录无新增备份/临时文件；未在生产演练删除或恢复。

## 边界

- 本批只改 `removeMember` / `removeChat`；
- 未改数据格式、未建恢复 UI；
- 生产应用已重新启动（管理员快捷方式，3210 正常）。

# D1-2c-2g 故障矩阵报告

> 时间：2026-11-04
> 环境：Windows 11 / Node 24.21.0 / NTFS（本地盘 + 系统临时目录）
> 测试：`test/diary-fault-matrix-test.mjs`（21 项，全部经 `test/run-diary-test.mjs` 隔离启动器）
> 结论：故障后数据可解释、可恢复、不误判；**不宣称所有故障都能自动恢复**

## 一、故障矩阵（A–N）

| 点 | 注入方式 | 真实崩溃/模拟 | 故障后状态 | 旧文件 hash | tmp | 恢复结果 |
|---|---|---|---|---|---|---|
| A 登记前崩溃 | `DIARY_FAULT=before-prepare` + SIGKILL | 真实进程崩溃 | 正文旧、pending 无、meta 无 | 保持 | 无 | 无需恢复 |
| B 登记后崩溃 | `after-prepare` + SIGKILL | 真实 | pending=prepared、正文旧 | 保持 | 无 | 下次 `recover` 判 `not_executed`（人工） |
| C 正文 tmp 写失败 | `writeFileAtomic` 注入 `writeFileSync` 抛 EPERM | 模拟 | 正文旧 | 保持 | finally 清理 | 调用方得到失败 |
| D tmp 成功、rename 前崩溃（tmp 丢失） | 注入 `renameSync` 抛 ENOENT | 模拟 | 正文旧 | 保持 | finally 清理 | 立即失败（不重试 ENOENT） |
| E 正文 rename 持续 EPERM | 注入 `renameSync` 一直 EPERM | 模拟 | 正文旧 | 保持 | finally 清理 | 13 次尝试后失败、错误码保留 |
| F 正文完成、body_done 前崩溃 | `after-body` + SIGKILL | 真实 | 正文新、pending=prepared | 正文已变（预期） | 无 | `already_appended`，不重放 |
| G body_done 后、meta 前崩溃 | `after-body` + SIGKILL（meta 关） | 真实 | 正文新、pending=body_done、meta 无 | 正文已变 | 无 | 保留 pending（meta 关时不补） |
| H meta tmp 写失败 | 对 meta 文件注入 `writeFileSync` 抛 EPERM | 模拟 | 旧 meta 完整 | 保持 | 清理 | 调用方失败 |
| I meta rename 失败 | 对 meta 文件注入 `renameSync` 抛 EPERM | 模拟 | 旧 meta 完整 | 保持 | 清理 | 调用方失败 |
| J meta 完成、meta_done 前崩溃 | `after-meta` + SIGKILL | 真实 | meta 新、pending=body_done | 正文/meta 已变 | 无 | 恢复不重复创建 meta（entries 1→1） |
| K meta_done 后、completed 前崩溃 | `before-complete` + SIGKILL | 真实 | 正文/meta 新、pending=meta_done | 正文/meta hash 不变 | 无 | 只完成状态 |
| L completed 写失败 | pending.json 只读 | 模拟 | pending 仍 meta_done | 保持 | 无 | 不伪造 completed |
| M 恢复中再次失败 | pending.json 只读 → 恢复失败 → 放开后重试 | 模拟 | pending 保留 | 正文不变 | 无 | 第二次恢复成功、幂等 |
| N 重复恢复 | 三次 `recover` | 真实流程 | — | 正文/meta hash 不变 | 无 | 幂等 |

## 二、Windows 实机 rename（真实文件系统）

| 场景 | 结果 |
|---|---|
| 普通目标替换 | 成功 |
| 只读目标 | 失败，错误码 **EPERM**；旧文件 hash 不变 |
| `chmod 666` 后重试 | 成功 |
| 源文件不存在 | `ENOENT` |
| 目标路径是目录 | 失败（错误码已记录） |
| 同一目标两进程并发写 20 次 | 最终 JSON 完整、无 `.tmp` 残留 |

## 三、重试策略（现状，未改）

- 只对 `EPERM / EBUSY / EACCES` 重试；
- 12 次循环 + 最后一次，退避 `15 + i*10`ms（约 715ms 总预算）；
- `ENOENT / ENOTDIR` 及其他错误立即失败；
- 失败时 finally 清理本次唯一 tmp；不删目标、不改非原子覆盖、不无限循环。

## 四、并发与锁

- 同一目标双进程写：最终文件完整、无 tmp 残留；
- 日记追加/改级/删除的并发由 `withFileLock`（正文）+ outbox/meta 锁串行；
- 未重新引入 rename stale-lock 回收；不按 mtime 删锁。

## 五、tmp 安全

- tmp 名：`<目标>.<pid>.<时间>.<随机>.tmp`，操作唯一；
- 失败时只清本次 tmp（按变量路径，不扫描 `*.tmp`）；
- 未做"批量清理 tmp"——没有可靠归属信息的不删、不覆盖。

## 六、对账 CLI 联动

- 故障后 `buildPlan` dry-run 能报告 pending 阶段；
- 修改正文后 planHash 变化；
- 不自动完成 `not_executed`/`needs_manual`；
- 本批未对生产执行 `--confirm`。

## 七、未覆盖 / INCONCLUSIVE

- **独占句柄 EBUSY**：Node 的 `fs.open` 默认共享读写，未能稳定构造"其他进程独占打开导致 rename EBUSY"；只读目标路径能稳定触发失败（EPERM）。该项标 **INCONCLUSIVE**，未伪报 PASS。
- **磁盘写入失败（磁盘满/坏道）**：无法在测试环境稳定模拟。
- **H/I 的端到端**：通过 `writeFileAtomic` 依赖注入验证原子性，未经过 writer 的 meta 写入调用链；writer 集成路径由 J/K/L 的 SIGKILL 覆盖。
- **依赖注入 vs 实机**：C/D/E 是模拟错误码；Windows 实机只覆盖了只读/目录/源缺失/并发。

## 八、验收

- 专项 21/21；
- 日记回归 13 套 + lock/store/learned 并发 4 套通过；
- 全量回归 **67 项：62 PASS / 5 FAIL**——4 项为既有基线失败（`selftest` / `tools-skill-audit` / `setup-qq-version` / `gallery-test`）；`token-ledger-concurrent-test` 本次并发计数失败，重跑两次 5/0 通过（Windows 文件锁偶发，与 `store-concurrent`/`learned-concurrent` 同类，非本批引入）；
- 生产 pending/meta/日记三份 hash 前后一致：
  - `pending.json` `F7E23E12…B5EE3`
  - `data/diary-meta` 聚合 `77AF10E9…09BDF4`
  - 生产日记 17 文件聚合 `49F1C183…77CE1B`
- meta 开关默认关闭；未运行生产 `--confirm`。

## 九、实现改动

- `src/file-lock.js`：`writeFileAtomic(file, content, deps = {})` 增加**可选**依赖注入（默认 fs），仅用于故障模拟；生产调用路径与行为不变。
- 新增 `test/diary-fault-matrix-test.mjs`（21 项）、预检与本报告。


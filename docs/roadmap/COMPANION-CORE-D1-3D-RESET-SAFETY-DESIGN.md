# D1-3d 设计：Reset 安全专项验证（隔离）

> 时间：2026-11-04
> 性质：设计与验收矩阵；**全部在隔离目录执行**，不碰生产 data/、不执行生产 reset
> 关联：B4 专项 58 项、C3 隔离验收 17 项

## 一、目标

把「reset 的安全性」从“有备份/有校验”验证到“**真实执行隔离恢复并逐文件核对**”，并覆盖任务书列出的 12 类故障：preflight 拒绝、manifest/hash、junction/symlink/越界、Windows 句柄、磁盘/权限失败、写入屏障/并发、删除中途崩溃、完整恢复、损坏备份、目标冲突、恢复中途失败。

## 二、方法

- 每个场景独立临时目录（`os.tmpdir()`），`data/` 与日记根均为临时目录；`backupRoot` 在 data 外；
- 使用真实文件系统与真实 `src/reset-data.js`，不 mock 删除/复制；
- 故障注入只通过**受守卫**的测试钩子：`DIARY_TEST_GUARD=1` 时允许 `hooks.failFileRel` / `hooks.failCopyRel` / `afterDataBackup`，生产拒绝；
- 崩溃用真实子进程（`QQ_RESET_TEST_STOP_AFTER` + `process.exit(97)`），不用“跳过删除分支”冒充；
- 恢复后**逐文件 SHA256** 与原始清单比对；失败返回 `needsManual`/`partial` 并保留备份，不谎报成功。

## 三、场景矩阵与判定

| # | 场景 | 注入方式 | 期望 |
|---|---|---|---|
| 1 | preflight 拒绝：未完成 pending | 写 pending prepared | `canReset=false`，含“未完成日记操作” |
| 2 | preflight 拒绝：pending 损坏 | 写坏 JSON | `canReset=false`，含“损坏” |
| 3 | preflight 拒绝：幂等 pending | 写 idem pending | `canReset=false`，含“幂等键” |
| 4 | preflight 拒绝：日记根在 data 内 / 备份根在 data 内 | 参数指向 | `canReset=false`，原因明确 |
| 5 | manifest v2 + 逐文件 hash | 正常 reset | `manifestChecksum` 自校验；每个源文件在备份中 hash/大小一致；totals/sourceRoots 一致 |
| 6 | junction 不跟随 | data 内 junction → 外部目录 | 备份仅记录 link；删除只删链接；目标文件仍在 |
| 7 | symlink 不跟随 | 文件/目录 symlink（若创建失败 → INCONCLUSIVE） | 同 junction；不得递归/删除目标 |
| 8 | Windows 文件句柄占用 | 子进程 cwd= data 子目录 | 删除失败 → `failed/needs_manual_recovery`，备份保留；释放后可 resume 完成 |
| 9 | 磁盘/权限类失败 | `hooks.failFileRel`（模拟 I/O/权限），真实磁盘满标 UNKNOWN | 备份失败 → **不删除**、data 完整 |
| 10 | 写入屏障 | begin barrier → 写 store/state | 写入被拒绝（ERESETBARRIER）；end 后恢复；reset 完成后屏障释放 |
| 11 | 备份后并发写入 | `hooks.afterDataBackup` 写新文件 | 删除前复核发现 → 拒绝删除、data 完整 |
| 12 | 删除中途崩溃 | 子进程 `delete_first` | status=`delete_in_progress`，部分删除；resume 续删完成 |
| 13 | 完整恢复 | reset 后 `restore scope=data` | **逐文件 hash 全部等于原始**；空目录重建；日记正文不变；审计写入 |
| 14 | 损坏备份拒绝恢复 | 篡改备份文件 | `ok=false`，含“备份不完整”；不写入目标 |
| 15 | 目标冲突拒绝覆盖 | 恢复后再次 restore | `ok=false`，含“已存在新数据” |
| 16 | 恢复中途失败 | `hooks.failCopyRel` 指定第 N 个文件 | `ok=false`、`needsManual=true`、`partial=true`；已复制文件保留、备份保留；再次恢复因冲突拒绝（需人工清理/重建） |

## 四、边界与诚实标记

- **磁盘真满**无法在不影响宿主的前提下可靠制造 → 用注入 I/O 失败验证 fail-closed 路径，报告中明确标注“模拟”；
- **symlink 创建权限**在 Windows 上可能不足 → 创建失败时标 INCONCLUSIVE，不伪造通过（junction 始终可测）；
- **恢复不重建 junction/symlink**：manifest 记录 links，但当前 `restore` 只恢复普通文件与目录；演练验证目标未被破坏，并在报告标注“链接恢复未实现”；
- **恢复中途失败不做自动回滚**：返回 needsManual，已恢复文件保留，由人工决定清理或补齐；不把部分恢复称为成功；
- 不执行生产 reset/恢复，不修改生产数据。

## 五、交付

- `test/reset-safety-drill-test.mjs`（隔离，覆盖上表）；
- `src/reset-data.js` 增加受守卫的 `hooks.failCopyRel`（仅测试）；
- 本设计 + 验收报告（含逐文件 hash 证据摘要、全量回归、生产 hash 前后一致）。

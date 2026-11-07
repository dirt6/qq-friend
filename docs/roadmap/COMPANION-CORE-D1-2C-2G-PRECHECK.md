# D1-2c-2g 预检：日记写入阶段的故障面

> 时间：2026-11-04
> 性质：只读预检；本批先验证，再按需修复

## 1. 写入顺序（真实代码）

### append（writer.write）
1. 锁内 `beginOp` → `prepareDiaryOp` 写 pending（outbox 锁 + 原子写）
2. `appendLine`：`fs.writeFileSync` 整文件重写正文（锁内）
3. 回读确认 → `bodyDone`（pending → body_done）
4. `syncAppendMeta`：`appendDiaryEntry` → meta 锁 + `writeFileAtomic`（tmp + rename）
5. `metaDone`（pending → meta_done）
6. `finishOp` → `completeDiaryOp`（pending → completed，prune）

### remove / relevel
1. `beginOp`（pending prepared）
2. 备份 `.trash/*.bak`
3. `writeFileAtomic` 正文（tmp + rename）
4. `bodyDone`
5. `syncRemoveMeta` / `syncRelevelMeta`（meta 锁 + 原子写）
6. `metaDone` / `finishOp`

## 2. 各阶段可能的磁盘状态

| 阶段 | 正文 | meta | pending |
|---|---|---|---|
| 登记前崩溃 | 旧 | 旧 | 无 |
| 登记后崩溃 | 旧 | 旧 | prepared |
| 正文 tmp 写失败 | 旧 | 旧 | prepared |
| 正文 rename 前崩溃 | 旧 | 旧 | prepared + tmp 残留 |
| 正文 rename 失败 | 旧 | 旧 | prepared + tmp（finally 清理） |
| 正文完成、body_done 前崩溃 | 新 | 旧 | prepared（hash 已变） |
| body_done 后、meta 前崩溃 | 新 | 旧 | body_done |
| meta tmp/rename 失败 | 新 | 旧 | body_done |
| meta 完成、meta_done 前崩溃 | 新 | 新 | body_done |
| meta_done 后、completed 前崩溃 | 新 | 新 | meta_done |
| completed 写失败 | 新 | 新 | meta_done（未完成） |

## 3. 现有故障注入点

- `DIARY_FAULT=before-prepare | after-prepare | before-body | after-body | after-meta | before-complete`（SIGKILL）。
- 恢复判定：`recoverDiaryOps`（expectedSourceHash + 目标态唯一匹配）。

## 4. 尚未覆盖的点

- tmp 写失败 / rename 失败（EPERM/EBUSY/EACCES/ENOENT/ENOTDIR/未知）；
- 正文 rename 前崩溃留下的 tmp 归属与清理；
- meta 写失败后 pending 保留与 CLI 联动；
- completed 写失败（不得伪造完成）；
- 恢复中再次崩溃、重复恢复；
- 并发：双进程追加/改级/删除、持锁崩溃、锁超时。

## 5. 环境

- Windows 11（本机），Node 24.21.0，NTFS（本地盘 `E:\dsh`、临时目录 `C:\Users\...\Temp`）。
- `writeFileAtomic` 现状：唯一 tmp 名（pid+时间+随机）；rename 仅对 `EPERM/EBUSY/EACCES` 重试 12 次（退避 15+i*10ms，总预算 ≈715ms）；`ENOENT/ENOTDIR` 立即失败；失败时 finally 清理本次 tmp；不删目标、不改非原子覆盖。
- 本批会给 `writeFileAtomic` 增加**可选依赖注入**（默认 `fs`），用于精确模拟错误码；生产调用不变。

## 6. 多文件非原子性

正文、meta、pending 是三个文件，没有跨文件事务；恢复路径为 `recoverDiaryOps`（只信正文状态）+ `diary-reconcile.mjs`（dry-run / planHash / confirm）。CLI 不自动重放 `needs_manual`，不清理未完成 pending。

## 7. 本批边界

- 不启用生产 meta、不对生产目录执行 `--confirm`；
- 故障矩阵用 SIGKILL + 依赖注入；实机结果与模拟结果分开统计；
- 无法稳定复现的项标记 INCONCLUSIVE。

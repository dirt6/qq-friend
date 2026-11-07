# D1-4 P2：备份保留策略（BACKUP-RETENTION-POLICY）

> 时间：2026-11-04
> 性质：策略设计；**不清理生产备份**
> 关联：D1-3b 备份（reset/memory/sessions/chat/learned）、D1-3d 恢复演练、D1-4 生命周期

## 一、备份来源与元数据

| 类型 | 位置 | 当前元数据 | 状态判定 |
|---|---|---|---|
| reset | `data.reset-backups/<opId>/manifest.json` | manifest v2（schemaVersion、status、files rel+sha256+size、totals、manifestChecksum） | manifest 可读 + checksum 通过 + 逐文件 hash（深检）→ `verified`；status=`needs_manual_recovery` → `needs_manual_recovery`；checksum/hash 失败 → `corrupted`；恢复审计失败 → `restore_failed` |
| memory | `data/memory/backups/<chat>/<op>/manifest.json` | manifest（files hash）+ audit.jsonl | 同上（无 manifestChecksum 时按文件 hash） |
| chat | `data/backups/chats/<chat>/<op>/manifest.json` | manifest（file sha256/size）+ audit | 同上 |
| learned | `data/backups/learned/<op>/manifest.json` | manifest + audit | 同上 |
| sessions | `data/backups/sessions-*` | 目录内会话文件（**无 manifest**） | 无 hash 元数据 → `unknown`（fail-closed，不自动清理）；保留规则仅在 manifest 化后启用 |
| diary `.trash` | `<日记根>/.trash/*.bak` | 原始文件（无 manifest） | `unknown`（无 hash 元数据，不可自证） |

**恢复审计**：`<resetRoot>/restore-audit.jsonl`（B4）记录 `result: ok|failed`；失败对应备份标 `restore_failed`；存在 `<resetRoot>/.restore.lock` 或恢复进行中标记时，全部备份视为 `restore_in_progress`。

## 二、状态与保护规则

| 状态 | 可清理 | 说明 |
|---|---|---|
| `verified` / `completed` | 仅满足保留规则且**再次验证通过**后可清理 | 默认安全集合 |
| `corrupted` | **否** | 保留现场供诊断 |
| `needs_manual_recovery` | **否** | 重置删除失败/残留 |
| `restore_in_progress` | **否** | 有恢复锁/进行中 |
| `restore_failed` | **否** | 恢复失败，需人工 |
| `unknown` | **否** | 无法自证（diary `.trash`、无 manifest 的 sessions） |

硬规则：
- **不得自动清理未完成、恢复中、恢复失败或状态未知的备份**；
- 清理前必须重新验证（深检 hash/文件存在），验证失败即跳过并记为 `corrupted`；
- 恢复期间（锁存在）禁止任何清理；
- 清理失败保留源，不得半删除；
- 所有清理/归档写审计。

## 三、保留规则（默认值，可按类型覆盖）

| 类型 | 最低完整备份 | 时间上限 | 数量上限 | 容量上限 | 归档后删除期 |
|---|---|---|---|---|---|
| reset | 2 | 30 天 | 10 | 20 GB | 30 天 |
| memory | 每会话 1 | 30 天 | 200 | 2 GB | 30 天 |
| chat | 每会话 1 | 30 天 | 200 | 2 GB | 30 天 |
| learned | 1 | 30 天 | 50 | 500 MB | 30 天 |
| sessions | 2 | 14 天 | 30 | 5 GB | 30 天（**仅 manifest 化后启用**；当前无 manifest → unknown 保护） |
| diary `.trash` | — | **永不自动清理** | — | — | — |

“最低完整备份”按**最新且 verified** 计数保留；超出部分才进入 archive 候选。归档后的副本超过 `deleteAfterDays` 才进入 delete 候选；delete 前再次验证。

## 四、两种动作

1. **archive**：把备份目录移入 `<data>/backups/archive/<type>/<name>`（同卷 rename，失败不复制/不删除），保留 manifest 与审计；可人工移回；
2. **delete**：只对**已归档且超过删除期**、或已验证且超出保留的副本；删除前深检；逐个删除，失败保留并记录；不做“先删后验”。

> 不提供“无边界通用文件删除”；工具只处理已识别的备份目录 + manifest 类型。

## 五、审计与失败恢复

- 审计：`<data>/backups/retention-audit.jsonl`，字段 `at/action/type/id/path/status/planHash/result/error`；
- 归档失败：源目录保留，记录 failed；
- 删除失败：文件保留，记录 failed；
- 计划过期：apply 前重新 inspect/planHash 比对，不一致则拒绝（不按旧计划删）；
- 恢复失败：备份保留，标 `restore_failed`/`needs_manual_recovery`，不进入清理候选。

## 六、本阶段边界

- 只实现 **inspect（只读）** + 隔离目录的 archive/delete/恢复演练；
- **不清理生产备份**；生产 `--apply` 需独立授权（且需 `--confirm <planHash>`）；
- diary `.trash` 永久保护（unknown），不纳入自动清理；
- 不改变任何备份格式；事件/审计只追加。

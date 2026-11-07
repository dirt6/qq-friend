# D1-5B：旧备份恢复与 manifest 补录设计

> 时间：2026-11-04
> 性质：设计 + 隔离实现/测试；**未恢复/删除生产备份**
> 关联：`scripts/legacy-backup-recovery.mjs`、`test/legacy-backup-recovery-test.mjs`（8/8）

## 一、恢复流程

```
inspect（只读：文件/hash/日期/正文对照/唯一行/分类）
  → 人工选择备份 + 确认目标（日期/是否覆盖）
  → buildLegacyManifest（补录 sidecar，不改备份）
  → restoreLegacyBackup(dryRun=true)（计划）
  → restoreLegacyBackup(dryRun=false, expectedSha256)
      · 目标已存在 → 拒绝（不覆盖）
      · 备份 hash 不符 → 拒绝（损坏）
      · 复制到临时文件 → 校验 hash → rename
      · 中断/异常 → 删除临时文件、目标不存在、审计 failed
  → 恢复后 hash 校验 + 审计
```

- 目标路径：`<targetDiaryRoot>/每日/<dateKey>.md`（promises 为 `<targetDiaryRoot>/promises.md`）；
- 只做单文件恢复；不批量、不覆盖、不改幂等表；
- 生产恢复需独立授权；本批只在临时目标目录演练。

## 二、manifest 补录方案（不伪造历史）

旧 `.trash` 无 manifest。补录 sidecar（例如 `manifest.legacy.json`，**不改备份文件**）：

```json
{
  "schemaVersion": 1,
  "kind": "legacy-trash",
  "file": "2026-11-01.md.1793505408016.bak",
  "dateKey": "2026-11-01",
  "sha256": "<当前实测>",
  "size": 1393,
  "op": "removeLine/relevel",
  "backupCreatedAt": "<文件名时间戳>",
  "backupCreatedAtSource": "filename-timestamp",
  "recordedAt": "<补录时间>",
  "historical": true,
  "sourceUncertain": true
}
```

原则：

1. `sha256/size` 是**当前实测**，不冒充历史 hash；
2. `backupCreatedAt` 只能来自文件名时间戳或 mtime，并标注来源；
3. `recordedAt` 是补录时间，明确不是历史创建时间；
4. `historical/sourceUncertain` 标记来源不确定；
5. 补录只新增 sidecar，不改写/移动备份；生产补录需授权。

## 三、隔离演练结果（8/8）

| 场景 | 结果 |
|---|---|
| 清单分类（recoverable/superseded/historical_unknown） | PASS |
| 补录 manifest 字段/历史标记/不改备份 | PASS |
| dryRun 不写目标 | PASS |
| 单备份恢复 + 恢复后 hash 一致 | PASS |
| 重复恢复/目标冲突 → 拒绝覆盖 | PASS |
| 备份损坏（expected hash 不符）→ 拒绝 | PASS |
| 恢复中断 → 目标不存在、临时文件清理、审计 failed | PASS |
| 非法 dateKey → 拒绝 | PASS |

## 四、限制与风险

- hash 只能证明备份完整，**不能证明删除是否有意**；恢复前需人工确认；
- 旧备份无历史 manifest，`backupCreatedAt` 依赖文件名时间戳（可能被改名）；
- 恢复只恢复单文件，不恢复被删行所属的幂等/pending 状态；
- `promises.md` 为迁移备份，当前无同名正文，恢复语义需人工定义；
- 生产未执行任何恢复；13 个备份保持原样。

# D1-2c-2f 预检：对账 CLI 的输入与可修复边界

> 时间：2026-11-04
> 性质：只读预检；本批不修改写入流程、不改 meta 开关

## 1. 三方路径与数据结构

| 数据 | 路径 | 结构要点 |
|---|---|---|
| 正文 | `<diaryRoot>/每日/YYYY-MM-DD.md` | Markdown；`## 记录` 下每行 `- 心情：…｜[标记] 正文` |
| meta | `<DATA_DIR>/diary-meta/<dateKey>.json` | `{version, dateKey, sourceFile, sourceHash, entries:[{paragraphIndex, quoteHash, quote, contentType, epistemicType, origin, roundId, stale, staleReason, sourceHashAfter, operationId}]}` |
| pending | `<DATA_DIR>/diary-meta/pending.json` | `{version, items:{id:{id, op, dateKey, match, importance, expectedSourceHash, paragraphIndex, stage, createdAt, updatedAt, attempts, lastError, lastAttemptAt, metaState, completedAt}}}` |

## 2. 现有接口（CLI 必须复用）

- `meta.js`：`splitParagraphs`、`readDiaryMeta(dateKey, root)`、`checkDiaryMeta(dateKey, root)`、`locateEntry`、`writeDiaryMeta(dateKey, meta, root)`（锁 + 原子写）。
- `outbox.js`：`listUnfinishedDiaryOps`、`listDiaryOps`、`completeDiaryOp(id, {metaState})`、`outboxStats`。
- `op.js`：`recoverDiaryOps({dryRun, root})`——只信正文状态，判定 `already_appended/already_releveled/already_removed` 或 `needs_manual`。
- `paths.js`：`dayFileOf(diaryRoot, dateKey)`。

**结论**：CLI 可以完全复用领域接口，不直接写 JSON、不绕过锁。

## 3. 可确定性修复 vs 必须人工

### 可自动修复（保守，仅两类）

1. **stale 但当前段落 hash 已匹配**：`entry.stale === true` 且 `paras[entry.paragraphIndex].hash === entry.quoteHash`——说明正文已验证该位置，可以清 `stale`/`staleReason`（通过 `writeDiaryMeta` 加锁写回）。
2. **pending 的目标状态已达成**：`recoverDiaryOps(dryRun)` 判定为 `already_appended / already_releveled / already_removed`——只调用 `completeDiaryOp(id, {metaState:'reconciled'})` 标记完成，**不重放正文、不推断新位置**。

### 必须人工（CLI 只报告，不修）

- meta 缺失（正文有、meta 无）——无法确定是否需要 meta；
- `paragraphIndex` 越界 / 索引前移导致的 stale（删除后旧索引不再指向原段落）；
- quoteHash 不匹配且无法唯一匹配（外部编辑、改级后未同步）；
- 同内容多段 / 短文本重复（身份不唯一）；
- 旧格式 meta（无 `entries` 或缺少身份字段）；
- 孤立 meta（指向的段落不存在，且无删除操作可确认）；
- 重复 meta/pending 记录；
- `needs_manual_replay` 及任何正文变化无法归因的情况。

## 4. 对账结论的判定依据

所有分段/哈希一律用 `splitParagraphs` 的 `paragraphIndex + quoteHash`；不做文本相似度推断，不读 `correction` 状态，不自动重排索引、不合并同文本、不删 stale、不清理未完成 pending。

## 5. CLI 设计约束

- 默认 dry-run：只读（不建目录、不建锁、不写任何文件、不更新 mtime/统计）。
- `--confirm <planHash>`：重新扫描、重新计算 planHash；与参数不一致 → 拒绝（计划过期或输入变化）。
- planHash 绑定：schema 版本、日期过滤、所有正文/meta/pending 文件的实际内容 sha256、计划操作列表。
- 修复只执行计划里列出的 auto 操作；每条执行前再次校验目标段落身份与正文 hash。
- 输出脱敏：正文摘要最多 50 字，不打印完整日记。

## 6. 本批边界

- 不改 writer/meta/outbox 的写入流程；
- 不改 meta 开关（保持默认关闭）；
- 不运行生产 `--confirm`；
- 故障矩阵（Windows rename/EPERM/EBUSY）留 D1-2c-2g。

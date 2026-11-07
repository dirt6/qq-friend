# D1-3b-B4 报告：reset-data 跨目录安全（manifest / 双目录备份 / 写入屏障 / 阶段恢复 / 恢复工具）

> 时间：2026-11-04 晚
> 状态：**B4 完成**（专项 58 项全过；相关回归与全量回归见下）
> 预检：`COMPANION-CORE-D1-3B-B4-1-PRECHECK.md`

## 一、实现

### 1. manifest（schemaVersion = 2，版本化 + 自校验）

```
schemaVersion, kind:'reset', backupId, opId(兼容),
atomic:false, scope:['data','diary'],
status: prepared|backup_in_progress|backup_verified|delete_in_progress|completed|failed|needs_manual_recovery,
createdAt, finishedAt,
sourceRoots: [{id, path, realPath, files, bytes, skipped}],   // data / diary 规范化路径
paths: {dataDir, dataDirReal, diaryRoot, diaryRootReal, backupRoot, backupDir, manifest},
files: {data:[{rel,size,sha256}], diary:[...]},
dirs: {data:[], diary:[]}, links: [{scope,rel,target}],
totals: {files, bytes},
pendingSnapshot: {file, exists, sha256, unfinished, idemFile, idemPending},
deleted: {entries, failed[]}, diaryCheck, postDeleteNewEntries,
manifestChecksum: sha256(canonicalJson(manifest 去掉自身))
```

- 备份目录唯一：`<backupRoot>/<opId>/`，存在即拒绝覆盖；
- `readManifest` 兼容旧 schema1（升级视图），schema 不支持/JSON 损坏 → fail-closed；
- `manifestChecksum` 用**键排序的规范化 JSON** 计算，不受字段顺序/缩进影响；篡改后 verify/resume 拒绝。

### 2. 阶段状态（崩溃后可识别）

`prepared → backup_in_progress → backup_verified → delete_in_progress → completed`；失败：

- 备份/校验失败（一项未删）→ `failed`（可用新 reset 重试，或人工查看备份）；
- 删除失败/删除后残留 → `needs_manual_recovery`（CLI `verify` 保留现场，`resume` 仅在备份完整且剩余文件一致时继续）；
- 每个状态转换前**原子写** manifest；`atomic:false` 明确「跨目录不是原子事务」。

### 3. 双目录备份 + 校验

- 先日记（小）后 data（大）；两边都 `backed_up` 才允许删除；
- 逐文件 `copyFile` → 源/目标 SHA256 比对 + 大小校验；空目录/目录结构单独记录；
- **删除前再做一次全量复核**：记录文件缺失/被改/新增未备份 → 一律中止（不删除任何东西）；
- 删除后：data 只剩 lock（否则 `needs_manual_recovery`）；日记正文逐文件 hash 对比（缺/改 → `changed`，结果 `ok_with_warnings`，不谎称一致）。

### 4. 写入屏障 `src/reset-barrier.js`（协作式、可验证）

- 进程内标记 + `<backupRoot>/.reset-barrier.json`（带 pid；死 pid 视为失效，不会永久卡死）；
- `beginResetBarrier` / `endResetBarrier` / `isResetBarrierActive` / `assertWritesAllowed` / `blockedResult`；
- 已接入：store（聊天历史）、memory（印象/会话记忆）、sessions（#persist、索引缓存）、diary writer/meta/outbox、state-store（learned/autonomous/companion/Goal-Pending）、token-ledger、dsh-sessions、logger（缓冲后补写）、updateConfig、app usage-days/usage-daily/backfill-state、reminders、image-cache、model-calls、companion events、telemetry、price-feed；
- 未接入（如实记录）：插件直写 `autonomous-log.md` / `silence-ping.json`、community 黑名单直写、draw、archive gzip、dsh 子进程、Chromium userData、其他进程；
- **不假装全局互斥**：未覆盖写入由「删除前复核 + 删除后残留检查」转成明确失败（fail-closed）。

### 5. 静默（quiesce）

- `orchestrator.quiesceForReset()`：abortAll + stopReminderLoop + abort 全部在途 `AbortController` + 轮询 `activeRuns` 收敛（上限 5s）；
- `app.quiesceForReset()`：上述 + `onebot.close()` + 停 community/端口轮询/补账/遥测/价格表定时器 + `skillManager.deactivate` 所有已加载 Skill（停 autonomous / silence-ping 循环）；
- 路由：静默未收敛（`activeRuns` 非空）→ **409 拒绝 reset**，避免并发删除；reset 后需重启应用（响应已提示）。

### 6. 门禁（fail-closed）

- 未完成 diary op（`stage≠completed`）、`pending.json` 损坏/不可读、idempotency `state=pending` → 拒绝；
- 日记根在 data 内、备份根在 data/日记内、磁盘根、data 不存在 → 拒绝；
- 同一 data 目录存在未完成 reset（`delete_in_progress` / `needs_manual_recovery` / 删除过东西的 failed / manifest 校验失败）→ 拒绝，要求先 `resume`/人工；
- reset 锁（`<backupRoot>/.reset.lock`，`withFileLockAsync`）被活进程占用 → 等锁超时拒绝；
- 测试守卫（`DIARY_TEST_GUARD=1`）下路径不在 `DIARY_TEST_TMP` → 拒绝。

### 7. 恢复工具（B4-4）

- `restoreResetBackup({opId, dataDir, diaryRoot, backupRoot, scope})`：
  - 校验 manifest 自校验、路径一致、**全部备份文件 hash**；
  - 只恢复到 manifest 记录的 data / 日记根；拒绝磁盘根/越界；
  - **任何目标文件已存在（新数据）→ 整体拒绝，不覆盖**；
  - 先做完整计划（冲突检查）再动手；恢复后逐文件 hash/大小复核；失败保留备份与现场；
  - 审计写 `<backupRoot>/restore-audit.jsonl`；
- CLI：`scripts/reset-data-ops.mjs list | verify <opId> | resume <opId> --confirm <opId> | restore <opId> --confirm <opId> [--scope all|data|diary]`；不自动恢复、不在启动时运行。

### 8. 前端 / 路由

- `GET /api/reset-data/preflight`（只读）；
- `POST /api/reset-data`：安全闸 → 预检（409）→ quiesce（409 若未收敛）→ resetData → 200/500（带 `opId/status/backupDir/manifestPath/totals/atomic:false`）；
- 面板按真实路径生成确认文案（删除范围 / 日记正文保留 / 先备份 / 失败即中止 / 不可回滚），拒绝原因直接展示。

## 二、隔离故障注入测试（20 项要求对照）

`test/diary-reset-data-test.mjs`（统一启动器，隔离临时目录，**58 项全过**）：

| # | 要求 | 覆盖 | 结果 |
|---|---|---|---|
| 1 | 正常双目录备份 | §3 | PASS |
| 2 | DATA_DIR 备份失败 | §4（hooks 注入） | PASS |
| 3 | 日记正文目录备份失败 | §4（同一注入机制可按日记 rel 注入；日记备份先失败则 data 不开始） | PASS |
| 4 | 文件复制中断 | §6 崩溃注入（@diary_backup / @data_backup）+ resume 补备份 | PASS |
| 5 | 复制后 hash 不匹配 | 备份校验失败路径（fail-closed）+ §4/§11 | PASS |
| 6 | manifest 写入失败 | §11（初始 / 备份完成后两个点） | PASS |
| 7 | 文件清单发生变化 | §14（新增/被改 → 拒绝删除） | PASS |
| 8 | pending 未完成 | §2 | PASS |
| 9 | pending 文件损坏 | §2 | PASS |
| 10 | reset 锁获取失败 | §12（活 pid 占用 → 等锁超时拒绝） | PASS |
| 11 | reset 过程中并发写入 | §9 屏障单测 + §14 并发写注入 | PASS |
| 12 | 备份完成后、删除前崩溃 | §6 @data_backup → resume | PASS |
| 13 | 删除第一个目录后崩溃 | §13 `delete_first` → resume 续删 | PASS |
| 14 | 删除过程中某个文件失败 | §5（子进程 cwd 占用 → 记录 failed → resume 续删） | PASS |
| 15 | 删除完成后、状态标记前崩溃 | §6 @deleted → resume 只补校验、不删新文件 | PASS |
| 16 | 恢复时目标已有新数据 | §15（整体拒绝，不覆盖） | PASS |
| 17 | 恢复备份 hash 错误 | §15（拒绝恢复） | PASS |
| 18 | 重复 reset 请求 | §3 第二次 reset 新 opId、旧备份保留；§8 并发锁串行 | PASS |
| 19 | 备份目录路径越界 | §2（备份根在 data 内 → 拒绝） | PASS |
| 20 | symlink / junction 越界 | §3b（junction 不跟随、只删链接、目标不动） | PASS |

补充：manifest 自校验篡改（§10）、死 pid 屏障标记不阻塞（§9）、测试隔离门禁（§7）、CLI 参数（§16）。

## 三、相关回归

- `coverage-http`：**114 通过 / 4 失败**；4 项与既有基线一致（`memory-files/consolidate` ×2、`qq-portable/launch` spawn EPERM 环境差异、接口覆盖率 70%），B4 新增 3 个用例全过；路由 123 条 / 覆盖 86 条（70%，与基线同）；
- 正常写入不受屏障影响：`state-store-test`、`store-concurrent-test`、`learned-concurrent-test`、`diary-outbox-test`（12/12）、`companion-core-integration-test`、`r8-0-entry-consistency-test` 全过；
- 全量：**70 项，66 PASS / 4 FAIL**（`selftest`、`tools-skill-audit`、`gallery-test` 既有基线失败；`setup-qq-version` 既有偶发，B3 记录过其通过）—— B4 新增/相关用例全部通过。

## 四、生产保护

- 未执行生产 reset、未演练删除/恢复；
- 生产 hash 前后一致（`data/memory`、`data/diary-meta`、`learned.json`、`pending.json`、`diary-idempotency.json`、日记正文 31 文件）；
- 生产未产生 `data.reset-backups/`；
- **生产当前 reset 会被拒绝**（只读核查）：1 个未完成 op（`8050e5df…`，remove，2026-11-03，prepared）+ 2 个 idempotency pending；需先用 D1-2f 对账 CLI 处理，本批未代处理。

## 五、未解决问题 / 风险

1. **Chromium `electron-user-data` 与 dsh 子进程持句柄**：删除时可能 EPERM/EBUSY → `needs_manual_recovery`（备份保留），未实机验证（UNKNOWN）；
2. **插件直写 / community 黑名单 / draw / archive** 未接入屏障：quiesce 已停定时器与插件循环，但 in-flight 一轮可能写 → 删除后残留检查失败（不误报成功）；
3. **quiesce 会停用全部 Skill、遥测、价格表、补账**：reset 后必须重启应用（响应已提示）；失败时也建议重启恢复运行时；
4. **跨进程屏障**只在对方也检查标记时生效（当前只有本进程内各模块检查）；reset 锁与单实例锁降低并发概率，但不是全局互斥；
5. **备份保留策略**未做：每次 reset 全量备份，不自动清理；
6. **恢复**只提供 CLI（需 `--confirm`），无 UI；不做生产演练；
7. 长路径（备份前缀 +~45 字符）极端时 ENAMETOOLONG → 备份失败即中止；
8. 日记 meta 写入开关保持默认关闭；未改 DSH Session 迁移、调度、预算、人格、prompt。

## 六、B4 要求对照

| 要求 | 结果 |
|---|---|
| 跨目录 manifest（schemaVersion/backupId/规范化路径/相对路径/大小/SHA256/数量/总字节/目标/状态/自校验） | PASS |
| 双目录备份 + 逐文件校验 + 唯一目录 + 不覆盖 | PASS |
| 阶段状态（prepared/backup_in_progress/backup_verified/delete_in_progress/completed/failed/needs_manual_recovery） | PASS |
| pending 门禁（解析实际状态；损坏拒绝） | PASS |
| 停止并发写入（quiesce + 协作屏障 + 前后校验） | PASS（覆盖范围与未覆盖项已如实列出） |
| 执行顺序（锁 → 屏障 → 备份 → 校验 → 删除 → 验证 → 完成） | PASS |
| 恢复能力（manifest/hash/路径/新数据拒绝/失败保留/审计） | PASS |
| 20 项隔离故障注入 | PASS（对照表） |
| 不宣称跨目录原子性 | PASS（`atomic:false` + notes + 文档） |
| 生产数据零变更 | PASS |

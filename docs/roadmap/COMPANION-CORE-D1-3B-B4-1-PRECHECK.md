# D1-3b-B4-1 预检：reset-data 调用链、并发写入与跨目录安全

> 时间：2026-11-04 晚
> 性质：**只读预检**（代码/只读命令）；未修改任何文件、未执行 reset、未写生产
> 上游：D1-3a reset 审计、B1 清理语义、B2/B3 备份先例
> 关联实现：`src/reset-data.js`、`src/reset-barrier.js`、`scripts/reset-data-ops.mjs`

---

## 1. 完整调用链

| 层 | 位置 | 行为 |
|---|---|---|
| 面板按钮 | `ui/app/06-settings-render.js:1004` | 「重置为初始形态」 |
| 面板事件 | `ui/app/07-settings-events.js:965` | 先 `GET /api/reset-data/preflight` → 按真实路径生成确认文案 → 两次 `uiConfirm` → `POST /api/reset-data` |
| 后端路由 | `src/routes.js:1548`（preflight）/ `:1563`（reset） | 安全闸 → 预检（拒绝 409）→ `deps.quiesceForReset()`（停业务/等在跑会话/停定时器/停插件）→ `resetData()` |
| 领域模块 | `src/reset-data.js` | 预检 → 备份锁 → 写入屏障 → 双目录备份+校验 → 删除 data → 删除后校验 → manifest 终态 |
| 备份位置 | `DATA_DIR + '.reset-backups'`（可用 `QQ_AGENT_RESET_BACKUP_DIR` 覆盖） | 与 data **同级**，不会被 reset 删除 |

## 2. reset 实际删除 / 保留 / 跳过

- **删除**：`DATA_DIR` 的全部子项（递归），**跳过 `qq-agent.lock`**；目录本身保留。
- **保留（不删除）**：日记正文（`config.skills.diary.root`，生产为 `E:\dsh\日记`）；备份根；应用代码；`qq-agent.lock`。
- **备份但不删除**：日记正文整棵树。
- **backup 内**：`data/`（全部 data 子项副本，跳过 lock）、`diary/`（日记副本）、`manifest.json`。

## 3. 所有相关数据路径

| 数据 | 路径 | reset 影响 |
|---|---|---|
| 配置 | `DATA_DIR/config.json` | 删；reset 成功后由 `updateConfig(loadConfig())` 重建默认配置（既有产品行为） |
| 聊天历史 | `DATA_DIR/messages/*.json` | 删 |
| 长期记忆/印象 | `DATA_DIR/memory/**` | 删 |
| 会话留档 | `DATA_DIR/sessions/*.json` + `session-index-cache.json` | 删 |
| 日记 meta | `DATA_DIR/diary-meta/*.json` | 删 |
| 日记 pending outbox | `DATA_DIR/diary-meta/pending.json` | 删（**仅当无未完成项**，否则拒绝） |
| 幂等键 | `DATA_DIR/diary-idempotency.json` | 删（存在 pending 时拒绝） |
| 经验 | `DATA_DIR/learned.json` | 删 |
| 自主活动 | `DATA_DIR/autonomous.json`、`autonomous-log.md`、`token-usage.json` | 删 |
| 伴生状态 | `DATA_DIR/companion-state.json`、`companion-events/` | 删 |
| 用量 | `DATA_DIR/usage-days/`、`usage-today.json`、`usage-daily.json`、`token-ledger` 文件 | 删 |
| 图片/表情/画 | `DATA_DIR/image-cache/`、`sticker-images/`、`drawings/`、`social-images/` | 删 |
| DSH | `DATA_DIR/dsh-sessions.json`、`dsh-home/`、`dsh-outbox/` | 删（备份内可恢复） |
| 日志 | `DATA_DIR/logs/`、`boot-diag.log` 等 | 删 |
| Electron userData | `DATA_DIR/electron-user-data/` | 删（Chromium 持句柄，EPERM 风险见 §8） |
| 日记正文 | `E:\dsh\日记` | **不删**，只备份 + 删除后 hash 对比 |

**核心矛盾（B4 要解决的）**：日记正文在 DATA_DIR 外，而 meta/pending 在 DATA_DIR 内。旧 reset 会删 meta/pending 但保留正文 → 正文/meta/待补偿失配。B4 的处理：有未完成 pending 时拒绝；无 pending 时把正文纳入备份与删除后校验；在响应/manifest 里明确“正文保留”。

## 4. 日记写入 / 修改 / 删除 / 恢复的调用方

- 写：`src/diary/writer.js:159 write()`（技能、工具、DSH 回复落日记）→ `op.js` 登记 outbox → `meta.js` 同步；
- 改级/删除：`writer.js:377 removeLine()`、`:457 relevelLine()`；
- meta：`src/diary/meta.js:135 writeDiaryMeta()`；
- outbox：`prepareDiaryOp / markDiaryOpStage / completeDiaryOp / failDiaryOp`（`src/diary/outbox.js`）；
- 恢复：`recoverDiaryOps`（`src/diary/op.js:169`）与对账 CLI `scripts/diary-reconcile.mjs`（dry-run + planHash + confirm）。

## 5. reset 期间可能继续运行的后台任务（只读盘点）

| 任务 | 周期/触发 | 写什么 | abortAll/close 是否停 |
|---|---|---|---|
| autonomous tick | 每 5min（`plugins/autonomous/index.js:2171`） | autonomous.json / log / token-usage / drawings / 发消息 | ❌ 不在 orchestrator 视野 |
| silence-ping | 随机分钟（`plugins/silence-ping`） | silence-ping.json（`mkdirSync(DATA_DIR)`）/ debug log / 发私信 | ❌ |
| 在跑聊天会话收尾 | 事件 | sessions / usage-today / telemetry-totals / memory / store / model-calls | ⚠️ abortAll 不清在途请求 |
| 提醒循环 | 定时 | reminders.json | ⚠️ 下一次 tick 自灭，in-flight 仍落盘 |
| app 补账 | 启动 30s / 00:05 | usage-days / usage-backfill-state / logs | ❌ |
| 遥测 | 90s / 6h | telemetry-totals / telemetry.json | ❌ |
| 价格表 | 每小时 | price-feed-cache.json | ❌ |
| 社区黑名单 | 5min | cloud-global-blocklist.json + config.json | ❌ |
| DSH 子进程 | 每轮 | dsh-home / dsh-outbox | ❌（只超时 kill） |
| Electron Chromium | 持续 | electron-user-data | ❌ |

## 6. abortAll / close 的真实能力（结论）

- `orchestrator.abortAll()`：纯同步清表（wakeTimers / unreadFallbackTimers / pendingWake / pendingSessions + stopProactiveLoop），**不等在跑会话、不 abort 在途 LLM 请求**；
- `onebot.close()`：只关 WS 与重连定时器，**不等在途事件/发送**；silence-ping 走 OneBot HTTP 直调，绕开它；
- 因此 **B4 增加 `orchestrator.quiesceForReset()`**：abortAll + stopReminderLoop + abort 全部 `sessionAbortControllers` + 轮询 `activeRuns` 直到收敛（上限 5s）；仍不收敛 → 路由拒绝 reset（409）；
- **app 级 `quiesceForReset()`**：quiesce + `onebot.close()` + 停 community / 端口轮询 / 补账 / 遥测 / 价格表定时器 + `skillManager.deactivate` 所有已加载 Skill（停 autonomous / silence-ping 循环）；
- 仍不能证明的：Chromium、dsh 子进程、其他进程（见 §9）。

## 7. 现有备份实现与失败处理（改造前 → 现在）

- 改造前：`fs.cpSync` 全量 + 无 hash、无 manifest、无阶段、备份失败才中止；
- 现在：唯一备份目录 + manifest v2（`schemaVersion=2`、`backupId`、`sourceRoots` 规范化路径/计数/字节、逐文件 `rel+size+sha256`、`totals`、`status`、`manifestChecksum` 自校验）+ 逐文件复制后校验 + **删除前全量复核源文件** + 删除后残留/日记 hash 复核；
- 失败语义：备份/校验失败 → **不删除**、`status=failed`、保留现场；删除失败 → `needs_manual_recovery`；删除后残留 → 同上；任何失败都不删备份、不谎报成功。

## 8. reset 与 outbox / MemoryStore / sessions / Goal-Pending 的交互

- outbox：预检严格解析 `pending.json`（损坏/不可读拒绝），未完成项拒绝；completed 记录随 data 删除（有备份）；
- MemoryStore：reset 走文件删除，不经 `removeMember/removeChat`；删除时 junction 不跟随、只删链接；
- sessions：删除前 quiesce 等 `activeRuns` 收敛；屏障期间 `#persist` / 索引缓存不落盘；
- Goal/Pending：`companion-state.json` 走 `withState`，屏障期间被拒绝；启动时 `tidyPending` 会保留未结算项（B5 另修 `slice(-MAX_PENDING)` 的截断风险）。

## 9. 当前 API 返回值与前端依赖

- preflight：`{ok, canReset, refusals[], paths{dataDir,diaryRoot,backupRoot}, data{files,bytes}, diary{...}, pending{count}, idem{count}, unfinishedResets[]}`；
- reset 成功：`{ok, opId, backupId, status, backupDir, manifestPath, result, totals, atomic:false, stages, diaryCheck, diaryKept, message}`；
- reset 拒绝：409 `{ok:false, refused:true, error, refusals[], pending, idem, unfinishedResets[]}`；静默失败（会话未收尾）同样 409 + `running[]`；
- reset 失败：500 `{ok:false, error, opId, status, backupDir, manifestPath, stages}`；
- 面板：按 preflight 真实路径生成文案；成功展示备份/manifest/正文位置；失败展示原因。

## 10. 写入屏障覆盖表（诚实版）

| 写入点 | 是否被屏障挡住 |
|---|---|
| chat store（messages） | ✅ `assertWritesAllowed` |
| memory（印象/会话记忆） | ✅ |
| sessions（#persist / 索引缓存） | ✅（跳过落盘） |
| diary writer / remove / relevel | ✅（返回 ok:false + ERESETBARRIER） |
| diary meta / outbox | ✅ |
| learned / autonomous state / companion state（withState） | ✅ |
| token-ledger 用量账本 | ✅ |
| dsh-sessions.json | ✅ |
| logger | ✅（缓冲，屏障后补写） |
| config.json（updateConfig） | ✅（屏障期间不落盘） |
| app usage-days / usage-daily / backfill-state | ✅ |
| reminders / image-cache / model-calls / companion events / telemetry / price-feed | ✅ |
| autonomous-log.md、silence-ping.json 直写 | ❌（插件已 deactivate，in-flight 一轮仍可能写；会被删除后残留检查判失败） |
| community 黑名单直写 / draw / archive gzip | ❌（定时器已停；in-flight 可能写） |
| dsh 子进程写 dsh-home / dsh-outbox | ❌（无法协作；EPERM 时删除失败 → needs_manual_recovery） |
| Chromium `electron-user-data` | ❌（持句柄；EPERM 时同上） |
| 其他进程 | ❌（`.reset-barrier.json` 只在同样调用 `isResetBarrierActive(backupRoot)` 的进程生效） |

**原则**：屏障是协作式的，**未覆盖的写入不会被假装挡住**；删除前全量复核 + 删除后残留检查会把它变成一次明确的失败（fail-closed），而不是一次“看起来成功”的重置。

## 11. 风险清单

1. Chromium / dsh 子进程持句柄导致删除 EPERM —— 机制上可疑，未实机验证（UNKNOWN）；结果是 `needs_manual_recovery`，备份保留；
2. 插件 in-flight 一轮可能在屏障开始后写 `autonomous-log.md` / `silence-ping.json` → 删除后残留检查失败（同上，不会误报成功）；
3. quiesce 会 deactivate 所有 Skill、停遥测/价格表/补账 —— **reset 后必须重启应用**（响应已提示）；失败时同样建议重启恢复运行时；
4. 跨进程屏障只在对方也检查标记时生效；单实例锁 + reset 锁降低并发概率，但不等于全局互斥；
5. 备份占双份空间；不自动清理（保留策略后续）；
6. 删除不可回滚；恢复只提供 CLI（`restore`），不做生产演练；
7. 长路径（备份前缀 +~45 字符）极端时可能 ENAMETOOLONG → 备份失败即中止，不删除。

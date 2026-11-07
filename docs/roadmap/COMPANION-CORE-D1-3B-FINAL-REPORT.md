# D1-3b 阶段最终报告（B1–B6）

> 时间：2026-11-04 晚
> 阶段：D1-3b「清理语义与跨目录安全」
> 结论：**建议 D1-3b 通过**（附未解决风险清单；不自动进入 D1-3c）

---

## 一、工作包与 commit

| 包 | 内容 | commit |
|---|---|---|
| B1 | 清理五类语义 + 入口策略表 | `925b13b` |
| B2 | `autonomous.delete` 领域入口、`sessions.clearFinished` 备份/终态确认 | `1b10304` |
| B3 | MemoryStore `removeMember/removeChat` 备份 + 路径安全（junction/越界） | `87f104a` |
| B3-fix | 修复 B3 测试 junction 清理（unlink→rmdir；HEAD 同样复现） | `e36fe29` |
| B4 | reset-data 跨目录 manifest、双目录备份、阶段恢复（初版） | `012d341` + `477d105` |
| B4-1 | reset 调用链 / 并发写入 / 屏障覆盖只读预检 | `5b74c51` |
| B4-2/3 | manifest v2 + 状态机 + 写入屏障 + quiesce + restore | `c285687` |
| B4-5 | 20 项故障矩阵（实际 58 项）+ B4 报告 | `840d036` |
| B5-1/2/3 | chat clear/delete、learned 删除备份；自动清理保护 | `d964a76` |
| B5 汇总 | B5 专项 9 项 + DSH Session 审查 + B5 报告 | `9f725c8` |
| B6 | 本报告 + `sessions.#pruneFiles` 状态保护 | 见下 |

基线：`87f104a`（B3 完成）。工作区在本轮结束时干净。

## 二、删除与清理入口清单（最终）

| 入口 | 最终语义 | 锁 | 备份 | 删除范围 | 恢复 |
|---|---|---|---|---|---|
| `POST /api/reset-data` | **reset**（data 全量；日记正文**保留**） | reset 锁 + 写入屏障 + quiesce | data + 日记双目录，manifest v2 + 逐文件 hash + 自校验 | DATA_DIR 子项（跳过 lock） | CLI `restore`（隔离演练过） |
| `POST /api/chats/:key/clear` | **clear**（清空 messages，保留容器） | `#update`（文件锁内读改写） | 锁内单文件备份 + manifest + audit | 该会话 messages | 人工（备份可核验） |
| `POST /api/chats/:key/delete-messages` | **truncate**（指定 id） | 同上 | 同上 | 指定消息 | 同上 |
| `POST /api/sessions/clear-finished` | **delete**（仅终态） | 逐文件锁 + 状态白名单 | `data/backups/sessions-*` + hash | done/error/aborted | 备份目录 |
| `DELETE /api/sessions/:id` | **delete**（用户主动；running 拒绝） | 无 | 无（产品决定） | 单条 session | 无 |
| `sessions.discard` | **delete**（仅 waiting） | 无 | 无 | 单条 waiting | 无 |
| `sessions.finish` keepFiles / `#pruneFiles` | **truncate**（自动，仅已结束） | 无 | 无 | 超保留数的最旧已结束 | 无 |
| `POST /api/autonomous/delete` | **delete**（单轮） | `withState` | 无 | 该轮 history | 无 |
| `POST /api/learned/delete` | **delete**（单条，不可恢复） | `withState` | `data/backups/learned/*` + manifest + audit | 该 id | 人工 |
| `PUT/DELETE /api/memory-files/*` | **delete/clear**（成员/整会话） | 端口锁 + 进程队列 | `data/memory/backups/*` + hash + audit | 成员/会话记忆目录 | 内部 `restoreMemoryBackup` |
| `diary/outbox` prune | **truncate**（仅 completed） | 文件锁 | 无 | 7 天/200 条 completed | 无 |
| `image-cache` 淘汰/孤儿 | **truncate**（缓存） | 文件级 | 无（可重建） | 缓存图片 | 重新抓取 |
| `logger.prune` | **truncate**（日志） | 文件级 | 无 | 超期日志/超大截尾 | 无 |
| `companion` 事件归档 | **archive**（保留原文，gz） | 文件锁 | 归档文件即原文 | active→archive | 归档可读 |
| `companion tidyPending` | **truncate**（仅已结算） | `withState` | 无 | 结算超 7 天/超容量 | 无 |
| 初始化 `mkdir` | —（只建） | — | — | 无 | — |

## 三、B1 五类语义核验

- **clear**：chat clear 只清 messages；容器/身份（chatKey、nextLocalId、conflicts、companion 事件摘要）保留 —— 语义单一，边界已写明；
- **delete**：learned 单条（真删，有备份，不可恢复）、sessions remove（无备份，产品决定）、memory remove（有备份）、autonomous 单轮（无备份）—— 每个入口只承担 delete；
- **archive**：companion 事件归档保留原文（gz），未伪装成 delete；
- **reset**：只有 reset-data，显式 `atomic:false`、双目录备份、日记正文不删、跨目录非原子已声明；
- **truncate**：delete-messages、outbox prune、sessions keepFiles、image-cache/logger prune —— 范围明确；outbox 只删 completed。

未发现「一个接口隐式承担多个语义」的新增；`reset-data` 的“备份”是安全机制不是第二种语义。

## 四、B6-1 全仓扫描结论（按类别）

| 类别 | 代表位置 | 结论 |
|---|---|---|
| 正常业务写入 | store/learned/memory/sessions/diary/state-store/token-ledger/telemetry | 走领域维护者；锁与原子写既有 |
| 重要数据删除 | memory（B3）、chat clear/delete（B5）、learned（B5）、sessions.clearFinished（B2）、reset（B4） | 均有备份或明确不可恢复；失败不返回成功 |
| 自动清理 | sessions keepFiles/prune、outbox、image-cache、logger、reminders、companion tidyPending | 只清允许状态；running/waiting/未知保留；未结算 pending 不丢；失败记日志 |
| 临时/派生文件删除 | gif-to-video、image-compress、video-reader、safe-fetch、prompt-version、speech-to-text、dsh tmp、routes pid 文件 | 临时产物/进程管理，不属业务数据 |
| 锁/标记文件删除 | file-lock、instance-lock、companion events lock、reset lock | 锁协议自身，按 owner/token 校验 |
| 备份 | memory、sessions、chat、learned、reset | 唯一目录 + hash；不覆盖历史 |
| 恢复 | memory（内部）、reset（CLI） | 未在生产演练；目标冲突拒绝 |
| 测试代码 | test/** | 隔离目录，不计入生产 |

**未发现**：绕过领域维护者的重要数据直写、无锁删除重要数据、无备份的重要删除、失败仍报成功、删除范围不明、路径越界、未完成 pending 被清除、锁外读旧值后锁内盲删（learned 的合并复活窗口除外，见 §十）。

## 五、锁与并发审查

- chat/memory/reset/sessions/outbox 都明确了锁：文件锁 / 端口锁 / `withState` / reset 锁 + 写入屏障；
- reset 额外做 `quiesceForReset`：abort 在途请求、等 `activeRuns` 收敛（5s），未收敛直接拒绝；
- 屏障为**协作式**：明确列出已覆盖/未覆盖写入点；未覆盖写入由「删除前全量复核 + 删除后残留检查」转成明确失败；
- `abortAll` 不等待在跑会话（已实测确认），因此不再假设它足够。

## 六、备份与恢复能力

| 数据 | 备份 | 校验 | 恢复 |
|---|---|---|---|
| reset（data+日记） | 唯一目录 + manifest v2 + 自校验 | 逐文件 SHA256 + 删除前复核 + 删除后残留检查 | CLI `restore`（`--confirm`，目标冲突拒绝，审计） |
| memory | 唯一目录 + manifest | 逐文件 SHA256 | 内部函数（无 UI） |
| sessions | 唯一目录 | 逐文件 SHA256 | 人工 |
| chat | 唯一目录 + manifest + audit | SHA256 + 大小 | 人工 |
| learned | 唯一目录 + manifest + audit | SHA256 + 大小 | 人工 |

## 七、测试与回归

- **B4 专项**：`test/diary-reset-data-test.mjs` **58/58**（20 项故障矩阵 + manifest 自校验/篡改/写失败/锁占用/删除中途崩溃/备份后并发写/屏障/恢复/并发）；
- **B5 专项**：`test/b5-cleanup-test.mjs` **9/9**（备份/失败/屏障/keepFiles/discard/tidyPending）；
- **coverage-http**：**115 通过 / 4 失败**（4 项与既有基线一致：consolidate×2、qq-portable spawn EPERM 环境差异、覆盖率 70%；B4/B5 新增用例全过）；
- **全量**：**71 项，67 PASS / 4 FAIL**（`selftest`、`tools-skill-audit`、`gallery-test` 既有失败；`setup-qq-version` 既有偶发）。B1–B5 新增/相关用例全部通过；
- 并发/故障/路径安全：store-concurrent、learned-concurrent、memory-port-lock、diary-fault-matrix、diary-op-fault、diary-meta-fault、reset 故障矩阵均通过。

## 八、Windows 实机验证要点

- **junction**：`lstat().isSymbolicLink()` 为 false（会被当普通目录）→ B4 用 realpath 识别；备份只记录、删除只删链接本身；实测目标文件不被删；
- **EPERM**：删除被占用目录（子进程 cwd）实测 EPERM → reset 记录失败并保留现场，resume 环境释放后继续；
- **锁**：活 pid 占用 reset 锁 → 等锁 3s 后拒绝；死 pid 旧标记自动失效；
- **rename EPERM/EBUSY**：既有原子写重试机制未改动；
- **spawn EPERM**：沙箱/环境限制导致的既有 qq-portable 用例失败，与本轮无关；
- 未在生产执行任何删除/恢复/演练。

## 九、生产保护

| 目标 | 基线（19:2x） | 最终（20:0x） |
|---|---|---|
| `data/memory` 聚合 | `ee772eb3…` | 一致 |
| `data/diary-meta` 聚合 | `054157ab…` | 一致 |
| `learned.json` | `af040667…` | 一致 |
| `pending.json` | `e046e067…` | 一致 |
| `diary-idempotency.json` | `d254aaec…` | 一致 |
| 日记正文（31 文件） | `fb5cfac7…` | 一致 |

- 生产未产生 `data.reset-backups/`、`data/backups/chats/`、`data/backups/learned/`；
- 生产 reset 当前会被拒绝（1 个 prepared remove + 2 个 idempotency pending，只读核查），需先对账；
- **生产运行的 Electron 仍是旧代码**（本会话非管理员，未擅自重启）；需机主用管理员快捷方式重启后 B4/B5 生效。注意：新 UI + 旧后端时，重置按钮会显示“预检失败”（fail-closed，不会误删）。

## 十、未解决风险（如实）

1. **learned 删除跨进程复活窗口**：`readStore` 在锁外、`__deleted` 只覆盖本进程一次写；另一进程持旧快照再 `writeStore` 理论上可复活。需把删除整体移入 `withState` 或持久 tombstone（独立包）；
2. **DSH Session**：无可验证删除接口；clear/delete 不联动（清空后仍复用旧 session）；reset 连带删 `dsh-home` 但有备份；孤儿 session 无回收策略；
3. **Chromium `electron-user-data` / dsh 子进程持句柄**：reset 删除可能 EPERM → `needs_manual_recovery`（未实机验证，UNKNOWN）；
4. **插件直写**（autonomous-log / silence-ping state）、community 黑名单、draw、archive gzip 未接入屏障：quiesce 已停循环，in-flight 一轮可能写 → 残留检查失败（不误报成功）；
5. **备份保留策略缺失**：reset/chat/learned/sessions 备份无限增长；
6. **恢复无 UI**：reset 有 CLI，chat/learned/sessions 备份需人工恢复；
7. **chat clear 不清** `conflicts` 与 companion 事件摘要（语义边界，UI 未说明“不是全清”）；
8. `pruneCompletedDiaryOps` 仍是无调用者的死代码；
9. 既有基线失败（selftest / tools-skill-audit / gallery-test / setup-qq-version 偶发）未修，不属 D1-3b；
10. 生产代码未重启生效。

## 十一、建议

**D1-3b 阶段：建议通过。** 删除/清理入口已具备：明确对象、锁、备份、校验、恢复边界、审计结果；不能证明安全的场景全部 fail-closed（拒绝/needs_manual_recovery），未发现“删除失败仍报成功”或“未完成 pending 被清除”。

后续独立工作包（不在本阶段）：learned 删除锁内化/tombstone、DSH Session 显式清理与孤儿策略、备份保留策略、chat/learned 恢复 CLI、UI 文案（清空范围/DSH 联动说明）、Chromium/dsh 子进程持句柄的 reset 可行性。

**不自动进入 D1-3c**，等待机主确认。

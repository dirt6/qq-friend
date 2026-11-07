# D1-3b-B5 报告：剩余清理入口收口

> 时间：2026-11-04 晚
> 范围：chat clear / delete-messages、learned 单条删除、sessions/outbox 自动清理、DSH Session 只读审查
> 上游：B1 语义表、D1-3a 审计、B2/B3/B4 备份先例

## 一、入口总表（原始语义 → 最终语义）

| 入口 | 原始语义 | 最终语义 | 锁 | 备份 | 删除范围 | 恢复 | 失败 |
|---|---|---|---|---|---|---|---|
| `POST /api/chats/:key/clear` | clear | **clear**（清空 messages，保留会话文件/nextLocalId/conflicts/companion 事件摘要） | `#update`：`withFileLockAsync` 锁内重读→备份→改→原子写 | `data/backups/chats/<chat>/<stamp>-<rand>/messages.json` + `manifest.json`（sha256/大小）+ `audit.jsonl` | 该会话 `messages[]` | 人工（按备份复制；manifest 可核验） | 备份失败抛错→500，不删除；加 `guardWrite`（本机+JSON） |
| `POST /api/chats/:key/delete-messages` | truncate | **truncate**（只删指定本地 id） | 同上 | 同上（同一次锁内） | 指定 id 消息 | 同上 | 同上；无命中不产生备份 |
| `POST /api/learned/delete` | delete | **delete**（真删单条，`__deleted` 防合并复活） | `withState`（learned.js 锁内合并写）+ 路由 confirm/存在性校验 | `data/backups/learned/<stamp>-<rand>/learned.json` + manifest + audit | 该 id | 人工；返回 `backupDir` | 备份失败 → `ok:false`（不删、不抛错）；写失败 → `ok:false` + 备份保留；路由审计含结果 |
| `sessions.clearFinished`（B2） | delete（批量终态） | 不变（state 白名单 + 备份 + 逐文件 hash 校验） | 逐文件 `withFileLock` | `data/backups/sessions-*` | done/error/aborted | 备份目录 | 失败中止、不删 |
| `sessions.finish` 的 keepFiles | truncate（自动） | **保留规则修正**：只清已结束、保护 `current`/磁盘 running-waiting/坏文件；失败记日志 | 无（文件级） | 无（产品决定：自动清理不备份） | 超出保留数的最旧已结束会话 | 无 | 记录 `console.warn`，不静默 |
| `sessions.discard` | delete（等待中） | **状态收紧**：内存/磁盘都必须 waiting；读不出 → 拒绝；返回值反映是否真删 | 无 | 无 | 单个 waiting 会话 | 无 | fail-closed |
| `companion` `tidyPending` | 时间/容量清理 | **只清已结算**；未结算永不因容量丢弃（超上限告警保留） | `withState` | 无（只清结算记录） | 结算超 7 天/超容量 | 无 | 保留未结算 |
| `diary/outbox` prune | archive/truncate | 不变：只删 `completed`，未完成永不删；`pruneCompletedDiaryOps` 仍无调用者（死代码，记录不接线） | `withFileLock` | 无 | completed 记录（7 天/200 条） | 无 | 已有 |
| `image-cache` 淘汰/孤儿清理 | truncate | 不变（配额 + 孤儿安全阀）；B4 起 reset 屏障期间不重建 | 文件级 | 无 | 缓存图片 | 可从源重新取 | 失败忽略（缓存可重建） |

## 二、每项改动

### B5-1 chat clear / delete-messages

- 路由补 `guardWrite`（本机来源 + JSON），与 learned/stickers 口径一致；被拒绝时 403 并写审计；
- **锁内**先备份再删除（同一 `#update` 临界区，避免 TOCTOU）；备份唯一目录、sha256+大小校验、manifest、`audit.jsonl`；
- 备份失败 → 抛错（HTTP 500），消息原样保留；
- 返回 `{ok, removed, backupDir, backedUp}`（向后兼容新增字段）；
- 语义边界：`clear` **只清 messages**；`conflicts` 诊断与 companion 事件摘要保留（不是“全清”）；`nextLocalId` 不重置（既有测试保持）；
- 不联动 DSH Session（见 B5-4）。

### B5-2 learned 单条删除

- `removeItem` 删前备份 `learned.json`（唯一目录 + manifest + hash + 审计）；
- 备份失败 / 写入失败 → 返回 `{ok:false, reason, backupDir?}`，不再抛 500；路由审计记录失败原因与备份路径；
- 身份判定不变（id + 存在性二次校验 + confirm）；
- **残留风险（如实记录）**：`readStore` 在锁外、删除合并依赖 `__deleted` 只覆盖本进程那一次写；另一个进程若持有删除前快照并在之后 `writeStore`，理论上可把条目合并回来。修复需把「存在性+删除」整体移入 `withState` 或引入持久 tombstone，属独立工作包（B5 未做，避免改动合并协议）。

### B5-3 自动清理 / prune

- `sessions.finish` 的 keepFiles：排除 `current` 中的会话；候选文件先读磁盘 status，`running/waiting/未知` 一律保留；unlink 失败 `console.warn`（原为静默）；
- `sessions.discard`：不在内存时也校验磁盘 status（只允许 waiting，读不出拒绝）；返回值改为“确实删了文件或索引”；
- `tidyPending`：容量超限时**只截已结算**，未结算全部保留并告警（原 `slice(-MAX_PENDING)` 会丢未结算）；
- `clearFinished` 保持 B2 行为（已备份 + 白名单 + 逐文件锁）；
- `pruneCompletedDiaryOps` 无调用者（死代码）：记录，不新增定时器/不接线；
- 未按时间删除任何重要日记或长期记忆。

### B5-4 DSH Session（只读）

见 `COMPANION-CORE-D1-3B-B5-4-DSH-SESSION-REVIEW.md`。结论：没有可验证的 DSH Session 删除接口；clear/delete-messages 不联动 DSH（清空后仍复用旧 session）；reset 会删 `dsh-home` 但 `abortAll` 不 kill 在跑子进程（失败进 `needs_manual_recovery`）。未伪造清理成功、未调用未验证接口。

## 三、测试

- `test/b5-cleanup-test.mjs`（隔离数据目录，**9/9**）：clear/delete-messages 备份 hash/大小/审计/其他会话不受影响；备份失败抛错不删；屏障期间拒绝；learned 备份/失败返回/原样保留；keepFiles 保护运行中与坏文件；discard 磁盘状态矩阵；tidyPending 未结算全保留；
- `coverage-http`：**115 通过 / 4 失败**（4 项与既有基线一致：consolidate×2、qq-portable spawn EPERM 环境差异、覆盖率 70%）；新增 clear 备份断言 + 非 JSON 403 用例全过；
- `store-mutation` / `store-concurrent` / `store-cache` / `learned-concurrent` / `companion-core-integration` / `diary-outbox` 全过；
- 全量：**71 项，67 PASS / 4 FAIL**（`selftest`、`tools-skill-audit`、`gallery-test` 既有基线失败；`setup-qq-version` 既有偶发）—— B5 新增 `b5-cleanup-test` 通过，其余相关用例全过；
- 备注：`r7a-learned-write-test` 不在回归清单，且因 2026-11 删除 `scripts/web-panel-server.mjs`（commit `6efe036`）已陈旧失败（找不到该文件），与 B5 无关，未修改。

## 四、残留风险

1. learned 删除的跨进程“复活窗口”（上文），需独立工作包；
2. chat 备份无自动保留策略（每次删除一份，长期增长）；
3. chat 备份无 CLI 恢复工具（人工按 manifest 复制；`backupDir` 已返回）；
4. clear 不清 `conflicts`/companion 事件摘要（语义边界，已在报告写明；改文案需 UI 工作包）；
5. `pruneCompletedDiaryOps` 死代码；`image-cache` 失败忽略（缓存可重建）；
6. DSH 孤儿 Session / 清空后复用旧 session（B5-4 已记录，未修）。

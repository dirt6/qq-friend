# D1-4 设计：数据资产生命周期与只读一致性审计

> 时间：2026-11-04
> 性质：只读审计 + 工具设计；**不自动修复生产数据**
> 目标：为每类数据明确唯一维护者、读写入口、锁、备份、保留策略、恢复方式、reset 行为与隐私风险；定义 expire / archive / delete 三种独立语义；提供只读一致性审计工具。

## 一、数据资产清单（唯一维护者 / 入口 / 锁 / 备份 / 保留 / 恢复 / reset / 隐私）

| # | 资产 | 唯一维护者 | 读写入口 | 锁 | 备份 | 保留策略 | 恢复 | reset 行为 | 隐私 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | learned 经验 | `src/learned.js` | save/list/remove/archive/status；`withState` | 文件锁（state-store） | 删除单条时 B5 备份 | `archiveStale` 归档（status=archived，不删） | 备份目录/归档 | 随 data 删除（reset 备份） | 高（纠正规则） |
| 2 | impression 印象 | `src/memory.js` | `#withChatLock` 内读写 | 端口锁 + 进程队列 | `data/memory/backups` | 无自动过期 | `restoreMemoryBackup`（内部） | 随 data 删除（reset 备份） | 高（群友画像） |
| 3 | 日记正文 | `src/diary/writer.js` | write/removeLine/relevelLine；文件锁 | 日记文件锁 | `.trash`（改删前）+ reset 备份 | **永不按时间删除** | `.trash` / reset restore | **不删除**（只备份/校验） | 极高 |
| 4 | diary-meta | `src/diary/meta.js` | writeDiaryMeta / readDiaryMeta；文件锁 | 同上 | reset 备份 | 无自动清理 | reset restore | 随 data 删除 | 中 |
| 5 | pending outbox | `src/diary/outbox.js` | prepare/complete/fail；文件锁 | 文件锁 | reset 备份 | 只清 completed（7 天/200）；**未完成永不删** | `recoverDiaryOps` / reconcile | 有未完成则拒绝 reset | 中 |
| 6 | idempotency | `src/diary/writer.js` | loadIdem/saveIdem（日记锁内） | 日记文件锁 | reset 备份 | save 时清 30 天前键 | 以正文为准回查 | 随 data 删除 | 低（含正文片段） |
| 7 | autonomous history | `plugins/autonomous/lib/state.js` | withState | 文件锁 | 手动/迁移备份 | 有界历史（插件内） | 人工 | 随 data 删除（reset 备份） | 高（活动/对话） |
| 8 | Goal/Pending/Action/Activity | `src/companion/state.js` | updateCompanion；withState | 文件锁 | companion 快照 | 结算项 7 天；**未结算不丢**；终态 Goal 不默认删 | 快照/人工 | 随 data 删除（reset 备份） | 高 |
| 9 | sessions | `src/sessions.js` | create/finish/clearFinished/remove；文件锁 + 索引缓存 | 逐文件锁 | clearFinished 备份 | keepFiles（仅已结束；保护运行中/未知） | 备份 | 随 data 删除 | 高（提示词/消息） |
| 10 | chat history | `src/store.js` | `#update` 锁内读改写 | 逐会话文件锁 | clear/delete-messages（B5） | `maxMessagesPerChat` 截断（产品配置） | 备份人工 | 随 data 删除 | 高 |
| 11 | token ledger | `src/token-ledger.js` | record*/save；自定义文件锁 | 文件锁 | reset 备份 | 按日/月聚合，无自动删除 | 重算 | 随 data 删除 | 中 |
| 12 | image cache | `src/image-cache.js` | archiveImage/prune/cleanupOrphans | 无（文件级） | 无 | 配额淘汰 + 启动孤儿清理（安全阀） | 重新抓取 | 随 data 删除 | 中（图片） |
| 13 | 操作审计 | `data/logs/ops-audit.jsonl`、`memory-write-audit` | 追加写 | 无 | reset 备份 | 无轮转策略（待治理） | 只读 | 随 data 删除 | 中（id/路径） |
| 14 | reset backups | `src/reset-data.js` | 备份/verify/resume/restore | reset 锁 + 屏障 | —（自身） | **不自动清理**（待保留策略） | CLI restore | 不受 reset 删除 | 极高（全量副本） |

## 二、三种语义（互不混用）

1. **expire（过期）**：不删除内容，只把“不再活跃/不再可信”的状态标出来，保留可读与可恢复；
   - 例：diary-meta 定位失败标 `stale`；idempotency 超 30 天键在下次 save 时清理（只清账本，不删正文）；image-cache 配额淘汰属于“缓存过期（可重建）”，不是业务数据删除；
2. **archive（归档）**：移出活动视图，保留原文与可检索性；
   - 例：learned 的 `archiveStale`（status=archived）；companion 事件按 90 天转 gzip；sessions 留档文件本身不清；
3. **delete（删除）**：明确对象、锁、备份、校验、恢复边界、审计；无备份的删除必须是产品明确决定（如用户主动删会话）。
   - 例：chat clear/delete、learned 单条、memory remove、sessions 用户删除、reset（有跨目录 manifest）。

**硬规则**：
- 重要日记**不得因时间久自动删除**；
- 未完成事项（pending/outbox/Goal pending）**不得自动清理**；
- 终态 Goal **不默认删除**；
- 任何自动清理只能处理明确允许的状态（终态/已结算/缓存），并记录 removed/kept/failed。

## 三、只读一致性审计工具

`scripts/data-consistency-audit.mjs`（新增，只读）：

- 输入：`--data-dir`、`--diary-root`、`--json`、`--deep-backup`（可选全量校验备份 hash）；
- 检查：
  1. 正文/meta：有正文无 meta（预期 17 条，info）；meta 无正文（warn）；meta 条目 stale/quoteHash 与正文不符（warn）；
  2. pending：未完成数量/阶段/最老年龄（超阈值 warn）；文件损坏（critical）；
  3. 幂等键：`pending` 键、`done` 但正文无对应行（warn）、`pending` 但正文已有行（info）、day 文件缺失（warn）；
  4. sessions：运行中/等待中但超期的“僵尸”（warn）；索引缓存缺失/未收录文件（info）；文件损坏（warn）；
  5. DSH：`dsh-sessions.json` 中 sessionId 在 `dsh-home/sessions` 下找不到（warn）；映射的 chatKey 无本地聊天文件（info）；
  6. 备份：reset manifest 缺失/自校验失败（critical）；`--deep-backup` 时逐文件 hash（critical）；sessions/chat/learned 备份目录/清单缺失（warn）；
  7. 审计文件存在性（info）。
- 输出：`{schema, generatedAt, counts:{critical,warn,info}, findings:[{level,code,path,message}]}`；默认退出码 0，`--fail-on critical|warn` 用于 CI；
- **绝不写盘、绝不修复**；`expire/archive/restore/delete/reconcile` 的业务实现仍由各领域模块负责，工具只做 inspect。

## 四、本阶段边界

- 不批量处理 17 条 meta_missing；不删除/迁移/修复任何生产数据；
- 不新增通用文件操作接口；后续 expire/archive/restore/delete 必须落在领域模块；
- 工具与测试均可在隔离 fixture 上运行；对生产只做一次只读审计并记录结果。

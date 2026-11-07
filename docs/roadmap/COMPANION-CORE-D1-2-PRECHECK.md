# D1-2 只读预检：日记正文与 diary-meta 协调

> 时间：2026-11-03
> 性质：**只读预检**；未修改任何代码/数据
> 结论：正文写入口唯一（`diary/writer.js`），但**正文删除/改级存在无锁旁路**；meta 当前默认关闭且无业务调用。"两者失配"目前不是风险，因为根本没接线；接线前必须先收口旁路。

---

## 一、五个预检问题

### 1. 正文唯一写入口

| 调用方 | 写入方式 |
|---|---|
| `skills/diary/index.js:186` | `writeDiaryEntry(...)` → `src/diary/index.js` → `writer.write` |
| `plugins/autonomous/index.js:579` | `writeDiary(...)` → `writer.write` |
| `src/companion-core/index.js:120` | `diary.write` → `writer.write` |

**普通追加**只有一个实现：`src/diary/writer.js` 的 `write()`（幂等 + 文件锁 + 写后回读 + 原子替换）。

**但正文删除/改级不是**：

- `plugins/autonomous/index.js:602 removeDiaryLine()`
- `plugins/autonomous/index.js:660 relevelDiaryLine()`

两者直接 `fs.readFileSync` → 改行 → `fs.writeFileSync` 覆盖整文件：

- **没有文件锁**（与 writer 的锁不互斥）；
- **没有幂等**；
- **没有 meta 同步**；
- 调用方是 `orchestrator.js:1100/1116`（DSH 工具 `qq_diary_remove` / 等级修改转发到主进程）。

这是 D1-2 最重要的发现：**正文存在第二个写路径**（虽然只改/删，不追加）。

### 2. diary-meta 接口与段落索引规则

`src/diary/meta.js` 是唯一实现：

- `splitParagraphs()`：按空行切、跳过标题/分隔线、trim 首尾；**规则固定**，改规则会让所有 `paragraphIndex` 失效。
- `appendDiaryEntry(dateKey, { paragraphIndex, ... })`：锁内读原文 → `splitParagraphs` → 校验 index → 幂等（`paragraphIndex + quoteHash`）→ 写 meta。
- `writeDiaryMeta` / `appendDiaryEntry` 的关系：后者内部用 `writeMetaUnlocked`（避免自锁）。
- 定位：`locateEntry` 只认 `quoteHash` 匹配；hash 不符 → `stale/hash_mismatch`；越界 → `stale/index_out_of_range`；原文没了 → `stale/source_missing`。

**规则一致**：`appendDiaryMemory` / `listDiaryParagraphs` 都复用 `splitParagraphs`，没有第二套切分。

### 3. 正文成功、meta 失败

**当前状态：不存在这条路径。**

- `writer.write()` **不写 meta**（无 `meta.js` import）；
- `src/memory-hub/diary-write.js` 的 `appendDiaryMemory()` 默认 **DISABLED**（`QQ_DIARY_META_WRITE=1` 或 `config.skills.diary.metaWrite`），且**没有任何业务调用方**（D0 已确认）。

所以当前"正文成功、meta 失败"不会发生——因为 meta 根本没写。接入时必须新设计：

- 正文写成功后**再**写 meta；
- meta 失败**不回滚正文**（正文已成功且是用户可见内容）；
- 需要记录"待补偿"（例如 `data/diary-meta/pending.json` 或 meta 内的 `reconcileNeeded`），由 `checkDiaryMeta` / 启动对账补偿；
- 不能因为 meta 失败让 `writer.write` 返回失败（否则调用方会重试，造成正文重复/幂等跳过）。

### 4. 重复 / 并发 / 修改 / 删除时的 meta 同步

| 场景 | 现状 |
|---|---|
| 重复写入 | writer 幂等键（idempotencyKey + 账本）；meta 幂等（index+hash）——**两层幂等独立** |
| 并发追加 | writer 锁正文文件；meta 锁 `metaFile`（不同文件）——**两者不同步** |
| 正文修改（改级） | `relevelDiaryLine` 直接改文件，meta **完全不知道**（quoteHash 会变 → 旧 meta 条目 stale） |
| 正文删除 | `removeDiaryLine` 直接改文件 → 后续段落 index 前移，旧 meta 的 `paragraphIndex` 指向错段 → `hash_mismatch` → stale（设计上容忍，但**没有任何标记/对账**） |

**风险**：一旦 meta 接线，改级/删除会让 meta 大面积 stale，且没有"待补偿"记录；`checkDiaryMeta` 能检测，但没有自动修复路径（设计上是"标 stale 不猜"）。

### 5. 读取接口兼容

- `writer.readDay/readLines`、`diary/index.js` 的导出不变；
- meta 读取（`readDiaryMeta/checkDiaryMeta`）是独立只读接口；
- 正文一个字节不会被 meta 写入影响（meta 只读原文）。

**兼容结论：读取接口可以保持不变。**

---

## 二、D1-2 建议拆分（先收口，再接线）

| 子批次 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **D1-2a** | 正文改/删收口：`writer.js` 增加 `removeLine` / `relevelLine`（文件锁 + 原子写 + 唯一匹配 + 备份），`autonomous.removeDiaryLine/relevelDiaryLine` 改为委托 writer；**行为不变** | 无 | 新旧结果逐字节一致；并发改/删不丢行；无锁旁路消失 |
| **D1-2b** | meta 接线：writer 成功写正文后，**可选**调用 `appendDiaryMemory`（沿用开关）；meta 失败 → 记录待补偿，不回滚正文、不影响返回 | D1-2a | 正文成功且 meta 成功；meta 失败时正文不变 + 有补偿记录 |
| **D1-2c** | 改/删的 meta 同步：改级/删除后把受影响条目标 stale（或按 quoteHash 重定位），提供对账命令；并发/重复测试 | D1-2a/b | checkDiaryMeta 结果符合预期；不猜位置 |

## 三、需要拍板的问题（D1-2b 前）

1. **meta 写失败时"待补偿"的存储**：`data/diary-meta/pending.json`（新文件）还是 meta 内字段？
2. **改级后 meta 的 quoteHash 变化**：直接标 stale（不重算）还是按新文本重算？（重算需要重新切段，可能改变 index）
3. **删除后 index 前移**：是否允许"标 stale，不重排"？（与 meta.js 现有设计一致）
4. **meta 开关默认值**：保持默认关（接线后仍由机主显式开）还是随 D1-2 默认开？

## 四、明确不做

- 不改 `writer.write` 的正文格式/幂等语义；
- 不把正文与 meta 塞进同一把文件锁（不同文件、不同锁，失败恢复独立）；
- 不在本预检中修旁路（D1-2a 才做）。

---

## 五、证据位置

- `src/diary/writer.js`（write/幂等/锁）
- `src/diary/meta.js`（splitParagraphs/appendDiaryEntry/locateEntry/checkDiaryMeta）
- `src/memory-hub/diary-write.js`（默认 DISABLED，无业务调用）
- `plugins/autonomous/index.js:602/660`（无锁旁路）
- `src/orchestrator.js:1100/1116`（调用旁路）
- `skills/diary/index.js:186`、`plugins/autonomous/index.js:579`（正文写入口）

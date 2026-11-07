# D0：统一伙伴写入路径只读审查

> 时间：2026-11-03
> 性质：**只读调查**；未修改任何代码/数据
> 范围：learned / impression / diary / activity / Goal / Pending / companion state / chat history

---

## 一、总体写入架构图

```
聊天 / 自主 / 插件 / 面板
        │
        ├─ learned 写入 ──► src/learned.js（withState + 原子替换）
        ├─ impression 写入 ─► src/memory.js（tmp+rename，**无跨进程锁**）
        ├─ 日记写入 ────────► src/diary/writer.write（withFileLock + 幂等 + 回读确认）
        │                    └─ src/memory-hub/diary-write.js（含 diary-meta，**业务未调用**）
        ├─ Goal/Pending/state ► src/companion/state.js（withState）
        ├─ 聊天历史 ────────► src/store.js（withFileLockAsync + writeFileAtomic + #update）
        └─ activity ────────► plugins/autonomous 的 ACTIVITY_LOG + src/sessions.js（withFileLock + writeFileAtomic）

Companion Core（src/companion-core）
        └─ 只读转发 + 调用领域写函数；**没有直接 fs 写路径**
```

---

## 二、八类数据写入路径矩阵

| 数据 | 存储位置 | 唯一领域维护者 | 写函数 | 主要调用方 | 锁 | 原子写 | 旁路 |
|---|---|---|---|---|---|---|---|
| learned | `data/learned.json` | `src/learned.js` | `addExperience` / `saveItem` / `setStatus` / `removeItem` | `dsh-gateway`、`orchestrator`、`routes`（面板） | `withState`（锁内读改写） | state-store 的 tmp+rename | 无 |
| impression | `data/memory/<chatDir>/<userId>.json` | `src/memory.js` | `append` / `remove` / `replaceMember` / `markConsolidated` | `tools`（memory_append/remove）、`orchestrator`（consolidate） | **无锁**（仅 tmp+rename） | 单文件 tmp+rename，**无重试** | 无 |
| diary 正文 | `E:\dsh\日记\每日\YYYY-MM-DD.md` | `src/diary/writer.js` | `write` | `skills/diary`、`plugins/autonomous`、`companion-core.diary.write` | `withFileLock`（覆盖幂等表+写入+回读） | 锁内 `fs.writeFileSync`（整文件重写） | 无（但绕开 diary-write 元数据入口） |
| diary-meta | `data/diary-meta/<date>.json` | `src/memory-hub/diary-write.js` | `writeDiaryWithMeta`（经 `diary/meta.js`） | **无业务调用**（仅测试/drill） | 经 `withState` | 原子 | **生产不存在该目录** |
| activity | `data/sessions/*.json` 的 round + `ACTIVITY_LOG`（autonomous） | `src/sessions.js`（round）+ autonomous（私有流水） | `writeSessionAtomic` / `mutateSessionAtomic` / `appendDigest` | `orchestrator`、`autonomous`、`sessions` 内部 | `withFileLock` | `writeFileAtomic`（EPERM 重试） | 自主私有流水独立 |
| Goal | `data/companion-state.json` | `src/companion/state.js` | `createGoal` / `createUserGoal` / `updateGoal` / `pauseGoal` / `resumeGoal` / `completeGoal` / `cancelGoal` / `supersedeGoal` | `orchestrator`、`routes`、`autonomous`（经 core）、`skills` | `withState` | state-store 的 tmp+rename | 无 |
| Pending | `data/companion-state.json` | `src/companion/state.js` | `addPending` / `settlePending` / `updateCompanion`（内部） | `autonomous`（经 core）、`orchestrator`、`routes` | `withState` | 同上 | 无 |
| companion state | `data/companion-state.json` | `src/companion/state.js` | `updateCompanion`（唯一写入口） | 所有 Goal/Pending 函数、`orchestrator` | `withState` | 同上 | 无 |
| chat history | `data/messages/*.json` + `data/sessions/*` | `src/store.js`（ChatStore） | `#update` → `appendIncoming` / `appendSelf` / `mark*` / `updateSession` | `app`、`routes`、`sender`、`tools`、`sessions` | `withFileLockAsync` | `writeFileAtomic` | 无（`routes` reset 有独立清理） |

---

## 三、唯一维护者结论

| 数据 | 结论 |
|---|---|
| learned | ✅ `learned.js` 唯一 |
| impression | ✅ `memory.js` 唯一（但**无锁**，见风险） |
| diary 正文 | ✅ `diary/writer.js` 唯一 |
| diary-meta | ⚠️ 设计上 `diary-write.js` 唯一，但**业务未接入**，生产无目录 |
| activity | ⚠️ round 由 `sessions.js`；自主私有流水由 autonomous。**无统一维护者**（按用途判断，建议保持） |
| Goal / Pending / companion state | ✅ `companion/state.js` 唯一（`updateCompanion` 是唯一写入口） |
| chat history | ✅ `store.js` 唯一 |

---

## 四、旁路写入清单

| 位置 | 说明 | 判定 |
|---|---|---|
| `plugins/autonomous` 直写日记（`writeDiary`） | 走的是 `diary/writer.write`，不是裸文件写 | **不算旁路**（但绕开 diary-meta 入口） |
| `plugins/autonomous` 写 `ACTIVITY_LOG` | 自主私有流水 | 设计如此，保持独立 |
| `routes.js` 的 reset/clear 分支 | 直接删文件（受确认门禁） | 管理操作，非业务写入；需 D1 确认是否纳入协调 |
| `memory-hub/diary-write.js` | 未被业务调用 | 不是旁路，是**未接线** |
| 插件直接 `fs.writeFileSync` 写伙伴文件 | 未发现（grep 未见） | 待验证 |

---

## 五、并发与原子性风险清单

### 已确认

1. **MemoryStore 无跨进程锁**（`memory.js:55`）：
   - 只有 `tmp+rename`（tmp 名含 pid），无 `withFileLock`；
   - 聊天与自主/工具并发写同一成员文件时，可能**丢更新**；
   - `rename` 无 EPERM 重试（Windows 杀软/索引器可能占用）。
   - 影响：impression 数据。
2. **diary-meta 未接线**：生产 `data/diary-meta/` 不存在；日记只有正文，没有元数据。当前不影响正文安全，但 R5 的元数据能力未生效。
3. **activity 无统一维护者**：round 与私有流水分离，二者都不经 Memory Hub。

### 待验证

- MemoryStore 并发丢更新的**实际复现**（需压测，未做）；
- `routes.js` reset 分支与 ChatStore `#update` 的竞态（W5 之后是否还有旁路）；
- 插件是否有未发现的直接文件写入（grep 只覆盖 `fs.writeFileSync`，未覆盖 `fs.appendFile`）；
- `diary/writer.write` 的锁在**跨进程**场景（父进程 + 插件子进程）是否仍成立（`withFileLock` 是文件锁，应成立，未压测）。

---

## 六、特别检查结论

| # | 检查项 | 结论 |
|---|---|---|
| 1 | correction 三态经 `resolveCorrectionState` | ✅ learned 读/写均经该解析（R8-B 测试 41 项通过） |
| 2 | `historicalUnresolved`/`unknown`/`unresolved` 不被误判 clear | ✅ R8-B 已锁定；D0 未发现新入口绕过 |
| 3 | 日记正文与 diary-meta 分离 | ✅ 文件分离；但 meta 入口未接线（见上） |
| 4 | 聊天历史不并入 Memory Hub | ✅ 仍由 `store.js` 管理；Hub 只读 `readActivities`，不接管 messages |
| 5 | Activity 私有流水是否独立 | **建议保持独立**：它是自主活动的运行流水，不是长期记忆；round 已由 sessions 管理 |
| 6 | Companion Core 是否绕过领域写文件 | ✅ 无直接 fs 写；`core.diary.write` 也走 `diary/writer.write` |
| 7 | 插件能否绕过领域模块写伙伴状态 | ⚠️ 理论上可以直接 import 领域模块（Node ESM 无沙箱）；当前代码未见；E 批次需要能力白名单 |

---

## 七、D1 建议拆分与依赖

| 批次 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **D1-1** | 给 `MemoryStore` 加跨进程锁（复用 `file-lock.js`），保留 tmp+rename；补并发测试 | 无 | 中：锁粒度/超时需调参 |
| **D1-2** | 日记写入统一走 `memory-hub/diary-write`（含 meta），`writer.write` 保留兼容 | D1-1 不依赖；需 dry-run | 中：meta 生成与正文一致性 |
| **D1-3** | `routes.js` reset/clear 分支纳入协调（或明确豁免） | D1-1 | 低 |
| **D1-4** | 插件写入口白名单（E 批次） | D1-1 完成 | 中：需定义能力表 |

**顺序**：D1-1（最高优先，真实并发风险）→ D1-2 → D1-3 → E。

---

## 八、E 批次是否具备启动条件

**部分具备**：

- ✅ Companion Core 已提供写协调入口（goals/pending/state/diary），autonomous 已接入；
- ⚠️ **D1-1（MemoryStore 锁）未完成前，不建议让插件获得 impression 写能力**——否则并发风险扩散；
- ⚠️ 聊天历史注入通道（ChatStore → 插件）尚未设计，E 的“聊天历史只读”能力需要先定接口。

**建议**：先做 D1-1，再做 E。

---

## 九、本次未做

- 未修改任何代码/数据；
- 未压测、未演练；
- 未修 MemoryStore 锁（属 D1）；
- 未生成 `data/diary-meta`。

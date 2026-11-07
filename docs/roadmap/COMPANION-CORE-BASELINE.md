# 统一伙伴核心接入 · 实施前基线（R8 批次 A 前置）

> 时间：2026-11-03
> 性质：只读检查；不代表已接入
> 决策依据：`ARCHITECTURE-UNIFIED-COMPANION.md`（`06d50a3`）

---

## 一、模块依赖图（真实 import）

```
src/config.js ──────────────► DATA_DIR / CONFIG
src/profile.js ─────────────► PROFILE / portOffset

src/memory-hub/index.js
  ├── adapters.js
  │     ├── learned.js（readStore/listAll）
  │     ├── memory.js（MemoryStore 只读）
  │     ├── diary/writer.js（readDay/readLines）
  │     ├── companion/state.js（readCompanion）
  │     └── sessions.js（readActivities? 按 round 文件）
  └── retrieval.js（relevanceOf / sortResults）

src/learned.js ─────────────► state-store.withState + data/learned.json
src/memory.js ──────────────► data/memory/<chatKey>/*.json（MemoryStore）
src/diary/writer.js ────────► data 日记目录（原子写 + 文件锁）
src/memory-hub/diary-write.js ► diary/writer.js（统一写入口，withState）
src/companion/state.js ─────► state-store.withState + companion-state.json

src/orchestrator.js
  ├── store.js（ChatStore）
  ├── memory.js（MemoryStore，传 ctx.memory）
  ├── learned.js（addExperience）
  ├── companion/state.js（promptSection）
  └── prompt.js（buildUserPrompt，读 ctx.memory / store）

plugins/autonomous/index.js
  ├── companion/state.js（readCompanion/activePending/settlePending）
  ├── diary/index.js（write）
  ├── 直接读 data/messages/private_*.json（readRecentChat / lastUserMessageAt）
  └── 直接读日记 .md（readRecentDiary）
```

---

## 二、Memory Hub 六层适配器读写能力矩阵

| 层 | 读取（adapters） | 写入 | 唯一业务维护者 | 是否经 Hub |
|---|---|---|---|---|
| learned | `readLearned` | `learned.addExperience/saveItem/setStatus/removeItem` | `learned.js` | ❌ 业务直接 import |
| impression | `readImpressions` | `MemoryStore.append/remove/replaceMember` | `memory.js` | ❌ 业务直接 `ctx.memory` |
| diary | `readDiary` | `diary/writer.write` + `memory-hub/diary-write` | `diary` 模块 | ⚠️ 写入有两处调用方 |
| activity | `readActivities` | 自主活动写 round/session | `plugins/autonomous` + sessions | ❌ 直写 |
| goal | `readCompanionItems` | `companion/state.js` | `companion/state.js` | ❌ 直接调用 |
| pending | `readCompanionItems` | `companion/state.js` | `companion/state.js` | ❌ 直接调用 |

**结论**：Hub 是只读视图；写入仍由各领域模块负责。没有"六层统一写入口"。

---

## 三、聊天 / 自主 / 插件的读写路径

### 聊天
- 读：`ctx.memory.formatForPrompt`（印象）、`store.recent/peekUnread`（聊天）、`companionPromptSection`（Goal/Pending）。
- 写：`learned.addExperience`（纠正/经验）、`store.appendIncoming/appendSelf`（聊天）。
- 不经 Hub。

### 自主活动
- 读：`readCompanion`、`readRecentDiary`（直读文件）、`data/messages/private_*.json`（直读）。
- 写：`diary.write`、`companion` 的 goal/pending、`learned`（间接）。
- 不经 Hub。

### 插件
- `ctx.store`（聊天）、`ctx.memory`（印象）直连；部分插件 import `learned`/`companion`。
- 不经 Hub。

---

## 四、锁 / 原子写入 / 事务清单

| 模块 | 机制 |
|---|---|
| `file-lock.js` | `withFileLock` / `withFileLockAsync`（`wx` + token + 陈旧回收）、`writeFileAtomic`（唯一 tmp + rename 重试） |
| `state-store.js` | `withState`：锁内读-改-写，ELOCKTIMEOUT 重试 3 次，坏文件备份 |
| `learned.js` | 经 `withState`；增量合并（hits/corrections） |
| `companion/state.js` | 经 `withState`（updateCompanion） |
| `store.js`（聊天） | 经 `withFileLockAsync` + `#update`（W1–W5） |
| `diary/writer.js` | 原子写 + 锁（R5） |
| `memory-hub/diary-write.js` | 经 `withState` |
| `token-ledger.js` / `model-calls.js` | 经 `withState` |

**风险点**：任何新的统一写入层必须复用这些机制，不能再写一套 `writeFileSync` 快照。

---

## 五、绕过 Memory Hub 的代码位置（只读检查）

| 位置 | 行为 |
|---|---|
| `src/prompt.js:879` | `ctx.memory.formatForPrompt`（印象直读） |
| `src/orchestrator.js:1080` | `import('./learned.js').addExperience`（写经验） |
| `plugins/autonomous/index.js:37-44` | `companion/state`、`diary/index` 直连 |
| `plugins/autonomous/index.js:189/910/927` | 直读 `data/messages/private_*.json` |
| `plugins/autonomous/index.js:342` | `readRecentDiary` 直读日记文件 |
| `src/tools.js:757/778/804` | `ctx.memory.append/query/remove` 直连 |
| `skills/*` | `ctx.store` / `ctx.memory` 直连 |
| `src/memory-hub/index.js` | 业务 **零调用**（仅测试） |

---

## 六、批次 A 的定位

批次 A 只建立 `src/companion-core/index.js` 门面：

- 委托 Memory Hub（search/get/stats）、companion/state（state/goals/pending）、diary（读）、activity（读）、chatStore（context）。
- **不改任何现有调用方**，因此不改变运行时行为；为 B/C/D/E 提供稳定接口。
- 初始化失败抛 `ECOMPANION_CORE_INIT`（不静默退化）。

后续批次：

| 批次 | 内容 | 风险 |
|---|---|---|
| B | 聊天读取接入核心（prompt 用 core.memory） | 中：检索结果/排序/prompt 注入可能变化，需对比测试 |
| C | 自主读取接入核心（去掉直读 JSON/.md） | 中：调度与预算不能变 |
| D | 统一写入入口（领域模块仍负责持久化） | 高：锁/事务/纠正门禁 |
| E | 插件接入与绕过治理 | 中：先 autonomous，后其他 |
| F | R8-C 记忆治理 | 高：沿用 R8-B 三态，需 dry-run |
| G | 集成验收 7 场景 | — |

---

## 七、B 批次预检发现（2026-11-03）

1. **Memory Hub `readImpressions` 的 chatKey 不匹配**：`adapters.js:90` 用 `chatKey`（`group:1`）直接与目录名（`group_1`）比较，导致带 chatKey 的检索恒为空。
   - 预检实测：`MemoryStore` 能读到 2 条印象；`hub.search({ layers:['impression'], chatKey:'group:1' })` 返回 `[]`。
   - 这是接线前必须修的 bug；当前不影响业务（Hub 未被业务调用）。
2. **两套印象读取的职责不同**：`MemoryStore.formatForPrompt` 按成员组织、输出固定段落；`Hub.readImpressions` 是跨层统一检索（按时间/relevance 排序、带 meta）。直接替换会改变 prompt 段的顺序与格式。
3. **B 的接线建议**：先修 chatKey 归一化并补对比测试；prompt 是否切到 core 需要单独确认（涉及输出顺序变化）。

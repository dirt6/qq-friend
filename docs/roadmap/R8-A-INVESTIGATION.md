# R8-A 只读调查：记忆衰减

> 时间：2026-11-03
> 状态：**只读调查，未修改任何代码/配置/生产数据**
> 方法：**直接读文件**，不 import 任何 store 模块（避免触发初始化写入）
> 结论：**现有衰减机制形同虚设，需要重新设计**

---

## 一、六层记忆的数据结构与来源

### 实测盘点

| # | 层 | 位置 | 大小 | 条目 |
|---|---|---|---|---|
| **1** | **经验库** | `data/learned.json` | **7.4 KB** | **23 条** |
| **2** | **群记忆** | `data/memory/<chatKey>/<userId>.json` | **0.3 KB** | **1 群 / 1 印象** |
| **3** | **日记** | `E:\dsh\日记\每日\YYYY-MM-DD.md` | **25 KB** | **17 天 / 128 条** |
| **4** | **DSH Session** | `data/dsh-home/sessions/` | **22.6 MB** | 12 文件 |
| **5** | **陪伴状态** | `data/companion-state.json` | **8.9 KB** | 10 个顶层键 |
| **6** | **自主状态** | `data/autonomous.json` | **225 KB** | history 49 / shares 30 |

### 各层的数据结构

#### 1. 经验库 `learned.json`

```json
{
  "version": 2,
  "items": [{
    "id": "l-mvq5ul9z-fla",
    "text": "老大纠正我说话的主语：「老大我让你学一下梗」改为「老大，我学一下梗」，别把事说到他头上",
    "status": "pending",
    "tags": [],
    "sourceDay": "",
    "createdAt": "...",
    "updatedAt": "...",
    "lastUsedAt": null,
    "hits": 655,
    "corrections": 1,
    "contentType": "fact",
    "epistemicType": "direct",
    "origin": { "kind": "...", "ref": "", "at": "...", "quote": "" },
    "correction": { "count": 1, "events": [...], "historicalUnresolved": true }
  }]
}
```

**状态分布（实测）**：
```
pending:  22
verified:  1
stable:    0    ← **关键**
archived:  0
```

**龄期分布（实测）**：
```
0-7 天:   14
8-30 天:   9
31-90 天:  0
90 天+:    0
```

**元数据使用率**：
```
有 correction 记录的:  1 / 23
有 history 版本的:     0 / 23
```

#### 2. 群记忆 `memory/<chatKey>/<userId>.json`

```json
{
  "userId": "1846383180",
  "name": "dirrrt",
  "impressions": [{
    "content": "自称是小鲸鱼的\"老爸\"（把我弄出来的人），爱叫我大肥鱼逗我炸毛，常在深夜找我说话。",
    "createdAt": 1791736174961
  }],
  "updatedAt": 1791736174962,
  "lastConsolidatedAt": 0    // ← **从没整理过**
}
```

**实测只有 1 个群、1 条印象。**

#### 3. 日记 `日记/每日/YYYY-MM-DD.md`

```markdown
# 2026-11-03 周二

- 心情：开心｜给老大画了张「小鲸鱼银行」的鲸圆券...
- 心情：被顶回来｜我给 biliguard 提的「加日志」和「掉线要提醒」被老大逐条顶回来...
- 心情：记住了｜[重要] 别再提「那条架构帖」和它的评论区，那是我编的，不存在。
```

**格式**：第一行标题，每条 `- 心情：xxx｜内容`，`[重要]` 前缀标记重要。

**实测**：17 天 / 128 条 / **28 条重要**。

#### 4. DSH Session

`data/dsh-home/sessions/--E-dsh-QQ-agent--/<session-id>/session.v4.jsonl.zstd`

**22.6 MB**，**12 个文件**。**不能直接读**（zstd 压缩 + DSH 内部格式）。

#### 5. 陪伴状态 `companion-state.json`

```json
{
  "version": ...,
  "goal": ...,
  "topic": ...,
  "pending": ...,
  "goals": ...,
  "migratedFrom": ...,
  ...
}
```

**10 个顶层键**。

#### 6. 自主状态 `autonomous.json`

**225 KB**，最大的几个数组：

```
history             49 条
shares              30 条
calibrationSamples  20 条
goalJudgeLog        10 条
digests              8 条
```

---

## 二、各层生命周期及读写调用方

| 层 | 写入方 | 读取方 | 生命周期 |
|---|---|---|---|
| **1 经验库** | `learned.addExperience`（自动合并相似文本）<br>`learned.setStatus`（唯一入口，`source` 必须 `owner`）<br>`learned.saveItem` / `removeItem` | `learned.selectForContext`（注入提示词）<br>`learned.listAll`（面板） | **无自动过期** |
| **2 群记忆** | 未找到写入方（`lastConsolidatedAt: 0` 说明整理器从没跑过） | 提示词注入 | **无** |
| **3 日记** | `diary.write`（她有 `qq_diary` 工具时）<br>orchestrator 代写（`action.type === 'diary'`） | 面板只读<br>`autonomous` 的 `diaryReview` | **永久保留** |
| **4 Session** | DSH 自己 | `dsh --session-id` 恢复<br>面板列表 | **无上限**（22.6MB 且只增） |
| **5 陪伴状态** | `companion/state.js` | 提示词注入<br>面板 | ❓ |
| **6 自主状态** | `orchestrator` / `plugins/autonomous` | 面板只读 | ❓（history 49 条可能自己截断） |

---

## 三、现有衰减、过期、归档和删除机制

### 唯一的"记忆衰减"：`learned.archiveStale`

```js
// src/learned.js:470
export function archiveStale({ days = 30, now = Date.now() } = {}) {
  const store = readStore();
  const cutoff = now - days * 86400_000;
  let n = 0;
  for (const item of store.items) {
    if (item.status !== 'stable') continue;     // ← **只处理 stable**
    const last = Date.parse(item.lastUsedAt || item.updatedAt || item.createdAt || 0) || 0;
    if (last && last < cutoff) {
      item.status = 'archived';                  // ← 只改状态，不删
      n += 1;
    }
  }
  if (n) writeStore(store);
  return { archived: n };
}
```

### 🔴 核心发现：**这个机制永远不会生效**

| 事实 | 数据 |
|---|---|
| 生产里 `stable` 的条目数 | **0** |
| `archiveStale` 只处理 | `status === 'stable'` |
| **结论** | **永远不会触发** |

**为什么没有 stable？**

状态机是 `pending → verified → stable → archived`，但：

- `setStatus` 只在**面板手动点**时才升级
- **没有任何"自动升级到 stable"的机制**
- 所以条目永远停在 `pending`

**这不是 bug，是设计断层**：**衰减机制假设有 stable，但没有任何东西会产出 stable。**

### 其他层

| 层 | 衰减机制 | 状态 |
|---|---|---|
| **2 群记忆** | 无 | ❌ |
| **3 日记** | 无（永久保留） | ✅ **这是对的**（日记不该衰减） |
| **4 Session** | 无 | ⚠️ **22.6MB 且只增** |
| **5 陪伴状态** | 未查清 | ❓ |
| **6 自主状态** | `history` 49 条可能自己截断 | ❓ |

### 另一个"归档"：`companion/archive.js`（**不是记忆衰减**）

这是**事件归档**，D5 的设计：

```
· 未处理事件永久保留，直到成功消费
· 已处理事件保留 90 天，超过按月归档（gzip）
· **归档长期保留不自动删**
· 核心原则：永久保留原始事件，不永久加载原始事件
```

**这个设计是对的**，但**它管的是事件，不是记忆**。

---

## 四、历史纠正、重要日记、长期计划的保护情况

### ✅ 已经有保护的部分

| 对象 | 保护机制 | 实测 |
|---|---|---|
| **重要日记** | `[重要]` 前缀 | **28 / 128 条**（22%） |
| **历史纠正** | `correction.events[]` + `history[]` | **只有 1 条用了** |
| **升级状态** | `setStatus` 要求 `source === 'owner'` | ✅ 代码里写死 |

### ⚠️ 保护不足的部分

| 对象 | 问题 |
|---|---|
| **`history` 数组** | 23 条里**零条**有 `history` —— 因为 `addExperience` 只在"合并相似文本"时才 push history |
| **重要日记** | 有 `[重要]` 标记，**但没有任何代码检查它** —— 衰减/归档时不会读这个标记 |
| **长期计划** | `companion-state.json` 的 `goal` / `goals` —— **没有找到任何过期逻辑** |

### 🔴 三个"保护空缺"

1. **`[重要]` 标记只存在于日记文件的文本里** —— 
   **没有任何代码路径会读它**。如果以后做衰减，必须先把这个标记解析出来。

2. **`history` 几乎没用起来** —— 
   `addExperience` 的合并逻辑会 push，但**23 条里零条触发过**（因为相似度阈值 0.28 很少命中）。

3. **长期计划没有生命周期** —— 
   `companion-state.json` 的 `goals` 字段存在，但**没找到任何过期/完成标记**。

---

## 五、生产数据统计及潜在风险

### 实测统计

| 项 | 值 |
|---|---|
| 经验库条目 | **23**（pending 22 / verified 1 / stable 0 / archived 0） |
| 经验龄期 | 0-7 天 14 / 8-30 天 9 / 31-90 天 0 / 90+ 天 0 |
| 有纠正记录 | **1** |
| 有历史版本 | **0** |
| 日记 | **17 天 / 128 条 / 28 条重要** |
| 群记忆 | **1 群 / 1 印象**（`lastConsolidatedAt: 0`） |
| DSH Session | **22.6 MB / 12 文件** |
| 自主 history | **49 条** |

### 潜在风险（按严重度排序）

| # | 风险 | 严重度 | 说明 |
|---|---|---|---|
| **1** | **衰减机制形同虚设** | 🔴 **高** | `archiveStale` 只处理 stable，而零个 stable → 永远不触发。**记忆只增不减。** |
| **2** | **Session 无限增长** | 🟡 **中** | 22.6MB 且只增。**没有归档/压缩机制。** |
| **3** | **`[重要]` 标记没被代码使用** | 🟡 **中** | 有标记但没人读。**做衰减前必须先解析它。** |
| **4** | **群记忆从没整理过** | 🟡 **中** | `lastConsolidatedAt: 0`。**印象会无限堆积**（虽然现在只有 1 条）。 |
| **5** | **长期计划无生命周期** | 🟢 **低** | `goals` 字段没找到过期逻辑。**现在条目少，不急。** |

### 一个"好消息"

**数据量现在还小**（经验 23 条、日记 128 条、群记忆 1 条）——
**没有紧急的"记忆爆炸"问题**。

**但 Session 22.6MB 是例外** —— 那个是真的大。

---

## 六、R8-A 衰减机制设计建议

### 设计原则（基于机主的约束）

> - 不能将衰减等同于删除
> - 不允许自动删除重要日记、用户明确记录或不可恢复的历史记忆

**所以衰减必须是**：**降权 / 降级 / 移出热区**，**绝不是删除**。

### 建议一：先修状态机，再谈衰减

**当前问题**：`archiveStale` 假设有 stable，但没有东西产出 stable。

**建议**：**加一个"自动晋升"规则**：

```
pending  →  （hits >= 3 且 无未解决纠正）→  verified
verified →  （hits >= 10 且 30 天无新纠正）→ stable
stable   →  （archiveStale：90 天没用到）→ archived
```

**关键**：**只自动晋升，不自动降级**（降级是衰减的职责，要单独设计）。

**为什么先修这个**：**没有 stable，衰减就永远不触发**。

### 建议二：衰减 = 降权，不是删除

**建议的衰减语义**：

| 状态 | 语义 | 是否注入提示词 |
|---|---|---|
| `stable` | 高频使用、可信 | ✅ 总是注入 |
| `archived` | 长期未用，降为冷存储 | ❌ **不注入，但可检索** |

**`archived` 不等于删除** —— 记录还在 `learned.json` 里，只是不进提示词。

**这符合机主的"衰减 ≠ 删除"。**

### 建议三：三条不可衰减的硬规则

| # | 规则 | 实现 |
|---|---|---|
| **1** | **有未解决纠正的永不衰减** | `correction.historicalUnresolved === true` → 跳过 |
| **2** | **`sourceDay` 是重要日记的永不衰减** | 需要先解析日记的 `[重要]` 标记 |
| **3** | **`epistemicType === 'direct'` 且 `contentType === 'fact'` 的，衰减更慢** | 直接事实比推断更可信 |

### 建议四：日记不衰减，但要"分层加载"

**日记是永久保留的**（这是对的）。

**但 128 条以后会变多** —— 建议：

- **最近 7 天**：全量注入
- **8-30 天**：只注入 `[重要]` 的
- **30 天以上**：不注入，但可检索

**这是"加载策略"，不是"衰减"** —— **数据一条不删**。

### 建议五：Session 要单独处理

**22.6MB 是最大的数据**，但它**不归"记忆衰减"管**。

**建议**：**单独一个批次**做 Session 归档（压缩旧的、保留最近的）。

**不要混进 R8-A**。

---

## 七、需要解决的架构问题

| # | 问题 | 影响 |
|---|---|---|
| **1** | **状态机不闭合** | 没有自动晋升 → 没有 stable → 衰减不触发 |
| **2** | **`[重要]` 标记只存在于文本** | 需要一个解析器把它变成结构化字段 |
| **3** | **`lastUsedAt` 几乎没更新** | `archiveStale` 依赖它，但它可能一直是 null |
| **4** | **群记忆没有整理器** | `lastConsolidatedAt: 0`，印象会无限堆积 |
| **5** | **六层记忆没有统一的"层级"概念** | 每层自己的生命周期，没法统一衰减 |

### 其中 #3 需要立即验证

`archiveStale` 用的是：
```js
item.lastUsedAt || item.updatedAt || item.createdAt
```

**如果 `lastUsedAt` 一直是 null**，就会退到 `updatedAt` —— 而 `updatedAt` 在每次改状态时都会变。

**这会导致**：**只要改过一次状态，就永远不会被归档**（因为 `updatedAt` 是新的）。

**需要查**：`lastUsedAt` 到底有没有被更新过。

---

## 八、下一步（等设计审查）

**这份报告只做调查，没改任何东西。**

**需要机主决定的三件事**：

| # | 决策 | 选项 |
|---|---|---|
| **1** | **先修状态机（加自动晋升）还是先做衰减** | 我建议**先修状态机** —— 否则衰减没东西可衰 |
| **2** | **`[重要]` 标记要不要结构化** | 必须做，否则"保护重要日记"无从谈起 |
| **3** | **Session 归档要不要并入 R8** | 我建议**不并入** —— 它是独立问题 |

**批准后我再实现。**

---

## 九、附：Token 替换语义的实现方案（独立整理，未动生产账本）

### 现状对比

| | DSH 的 `tokenUsage` | 我们的 `dsh-gateway` |
|---|---|---|
| 同 `(turn, step)` | `addReplacing`（**先减旧再加新**） | **忽略**（保留第一次） |
| retry 轴 | `llm/retry-started` 时 `last = null` | 无 |
| 总量 | `totals` 累计桶 | 逐 step 求和 |

### 建议的实现

**改动位置**：`src/dsh-gateway.js` 的 `applyEvent`（`status` 分支）

**当前逻辑**：
```js
// 同 (turn, step) 已存在 → 记冲突，保留第一次
if (seen.has(key)) {
  if (!sameUsage(seen.get(key), u)) conflicts.push(...);
  continue;   // 忽略
}
```

**改成**：
```js
// 同 (turn, step) 已存在 → 用新值替换
if (seen.has(key)) {
  const prev = seen.get(key);
  if (!sameUsage(prev, u)) {
    conflicts.push(...);        // 仍然记录，便于诊断
    seen.set(key, u);           // **但用新的**
  }
  continue;
}
```

**为什么这样改**：
- **DSH 官方就是这么干的**（`addReplacing`）
- **流式补全场景下，后到的才是最终值**
- **保留 `conflicts` 记录，便于诊断**

### retry 轴

**建议**：**先不做**。

**理由**：S8-B 确认 `llm/retry-started` 在 headless `--json` 里**可能根本不存在**（R6-A 23 项实测没见过）。

**没有事件支持，做 retry 轴是空转。**

**如果以后发现确实有**，再加。

### 验证方法

**隔离测试**：用 `test/r6c-usage-test.mjs` 的现有框架，加两个用例：

1. **同 `(turn, step)` 报两次不同 usage** → 最终值应该是**后者**
2. **同 `(turn, step)` 报两次相同 usage** → 不重复累计

**生产数据**：**不改**。当前 `total=802131` 和 DSH 自算对得上，说明现场没出问题。

### 这个方案能不能达到 R9-B 的准入条件

**R9-B 的准入条件**（从 R8 报告推）：**Token 账本必须能准确反映"这个会话花了多少"**。

**对齐后**：
- ✅ 同 step 多次上报 → 用最终值
- ✅ 重复事件 → 幂等
- ⚠️ retry 轴 → 没做（但没有证据表明 headless 会发 retry 事件）

**我的判断**：**对齐"替换语义"就够了**，retry 轴可以等有证据再说。

---

## 十、补充验证（2026-11-03 05:55）

### 我之前猜的 #3 不成立：`lastUsedAt` 是正常更新的

**报告第七节写的**：
> `archiveStale` 依赖 `lastUsedAt`，但它可能一直是 null

**实测推翻了这个猜测**：

```
有 lastUsedAt 的: 23 / 23（全部有值）
样本:
  l-mvq5ul9z-fla  lastUsedAt=2026-11-03T08:54:32.205Z  hits=655
  createdAt=2026-10-27T04:03:28.439Z
  updatedAt=2026-10-27T05:12:12.683Z
```

**`lastUsedAt` 是最新的，`hits` 有 655** —— 说明它被正常使用和更新
（`src/learned.js:533`：`t.lastUsedAt = iso`）。

### 但这反而印证了另一个结论

`archiveStale` 的判断是：

```js
const last = Date.parse(item.lastUsedAt || item.updatedAt || item.createdAt || 0) || 0;
if (last && last < cutoff) { item.status = 'archived'; }
```

**`lastUsedAt` 是"最近一次被使用的时间"，不是"创建时间"。**

**所以**：**只要条目还在被用，`lastUsedAt` 就会刷新，永远不会被归档。**

**这是正确的设计**（"长期没用到才归档"）——

**但前提是"有条目进入 stable 状态"，而生产里零个 stable，所以机制空转。**

### 修正后的核心结论

| 我之前的判断 | 修正后 |
|---|---|
| ~~`lastUsedAt` 可能一直是 null~~ | **错** —— 23/23 都有值且是最新的 |
| **衰减不触发因为零个 stable** | ✅ **对** |

**所以 R8-A 的核心问题只有一个**：

> **状态机不闭合 —— 没有"自动晋升到 stable"的机制，导致 `archiveStale` 永远没有输入。**

**其他都是次要的。**

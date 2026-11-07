# 记忆数据模型规范（3.0 基线）

> 版本：v1.0（R0 设计稿）
> 时间：2026-11-02 23:20
> 状态：**设计文档，未实施**
> 范围：五层记忆的元数据规范、来源与纠正结构、生命周期、兼容策略
> **适用范围（v1.1，2026-11-03）**：本规范只服务**一个默认 PROFILE 的单个 AI 伙伴**。PROFILE 是运行隔离配置，不是伙伴身份；跨 PROFILE 记忆共享、多 AI 伙伴同步不在本规范范围（见 `ARCHITECTURE-UNIFIED-COMPANION.md`）。

---

## 一、五层数据模型（现状实测）

### 1.1 总览

| 层 | 位置 | 规模 | 格式 | 可控性 |
|---|---|---|---|---|
| **L1 经验** | `data/learned.json` | 22 条 | JSON（结构化） | ✅ 全套 CRUD |
| **L2 聊天记忆** | `data/memory/<chatKey>/*.json` | 1 个文件 | JSON（`MemoryStore`） | ✅ |
| **L3 日记** | `E:\dsh\日记\每日\YYYY-MM-DD.md` | 多个 .md | **纯文本** | ❌ 只能读文件 |
| **L4 DSH 会话** | `data/dsh-home/sessions/` | 670+ | zstd JSONL | ❌ 只能读 |
| **L5 Companion State** | `data/companion-state.json` | 4 goals / 12 pending | JSON（状态机） | ✅ |

### 1.2 各层真实字段

#### L1 经验（`learned.json`）

```json
{
  "id": "l-mvq5ul9z-fla",
  "text": "老大纠正我说话的主语：...",
  "status": "pending",          // pending | verified | archived
  "tags": [],
  "sourceDay": "2026-10-27",
  "createdAt": "2026-10-27T04:03:28.439Z",
  "updatedAt": "2026-10-27T05:12:12.683Z",
  "lastUsedAt": "2026-11-02T13:22:22.573Z",
  "hits": 616,
  "corrections": 1
}
```

**已有的**：`status`（含 `archived` = 过时标记）✅
**缺的**：`epistemicType`、`origin`、`correction.events`

#### L2 聊天记忆（`MemoryStore`）

```js
// src/memory.js 的公共方法
append(chatKey, category, content, extra)
query(chatKey, category)
members(chatKey)
getMember(chatKey, userId)
editMemberImpression(chatKey, { userId, name, note, impressions })
replaceMember(chatKey, userId, name, contents)
removeMember(chatKey, userId)
removeChat(chatKey)
remove(chatKey, category, { userId, target, content })
clear(chatKey)
formatForPrompt(chatKey, { userIds })
```

**已有的**：`impressions`（半推测性质）✅
**缺的**：`impressions` 没有明确标注是推测

#### L3 日记

**纯 markdown**，路径 `E:\dsh\日记\每日\YYYY-MM-DD.md`。

**写入**：`src/diary/writer.js`（280 行）
**幂等**：`data/diary-idempotency.json`（9.2 KB）

**缺的**：任何结构化元数据

#### L4 DSH 会话

**用途**：模型轨迹（`session.v4.jsonl.zstd`）

**机主明确**：

> DSH 会话继续保留原始会话语义，不要求每条消息都变成 fact/inference 记忆。

**所以**：**L4 不参与 3.0 的元数据改造。**

#### L5 Companion State

```json
{
  "id", "text", "source", "status",
  "since", "updatedAt", "statusSince",
  "reason", "completion", "history": [], "sourceHistory": []
}
```

**已有的**：完整状态机 + `history`（状态变化轨迹）✅
**缺的**：`origin`（但 `source` + `history` 已经够追溯）

**机主明确**：

> 不把 Companion State 变成普通记忆。

**所以**：**L5 不套用 3.0 的元数据**，它有自己的语义。

---

## 二、统一元数据规范

### 2.1 适用范围

| 层 | 是否套用 | 理由 |
|---|---|---|
| **L1 经验** | ✅ 全部套用 | 最结构化，最容易改 |
| **L2 聊天记忆** | ⚠️ **部分**（成员印象） | 内容字段太多，不强求 |
| **L3 日记** | ✅ **只加元数据，原文不动** | |
| **L4 DSH 会话** | ❌ **不套用** | 机主明确：保留原始会话语义 |
| **L5 Companion** | ❌ **不套用** | 机主明确：不变成普通记忆 |

### 2.2 三个核心字段

#### ① `contentType`（内容类别）

**这条记忆在说什么**（不是「可信不可信」）：

```js
type ContentType =
  | 'fact'        // 事实陈述（老大住在 X / 她有 3 个 Goal）
  | 'preference'  // 偏好（老大不喜欢被 @）
  | 'event'       // 发生过的事（11-02 那轮分享了一篇架构帖）
  | 'plan'        // 计划/意图（下次想翻评论区）
  | 'other';      // 其他 / 未分类
```

**为什么 `preference` 在内容类别里，不在性质里**：

- 偏好**本身**可能就是事实（"老大明确说过不喜欢被 @"是事实）
- 偏好也可能是**推测**（"她可能不喜欢"是推断）
- **所以「是不是偏好」和「可不可信」是两个维度**

#### ② `epistemicType`（认知性质）

**这条记忆是怎么来的、有多可信**：

```js
type EpistemicType =
  | 'direct'    // 直接得知（用户说的 / 亲眼看到的）
  | 'inferred'  // 推断出来的（模型总结、从行为推测）
  | 'unknown';  // 未知（旧数据默认）
```

**关键区别（机主 2026-11-02 明确）**：

| 维度 | 回答什么 | 取值 |
|---|---|---|
| `contentType` | **说了什么** | fact / preference / event / plan / other |
| `epistemicType` | **怎么知道的** | direct / inferred / unknown |

**两者正交**：

- `fact + direct` = "老大说他住在 X"（他说的事实）
- `fact + inferred` = "老大可能住在 X"（推出来的，**不能当真**）
- `preference + direct` = "老大明确说不喜欢被 @"
- `preference + inferred` = "我觉得老大可能不喜欢被 @"

#### ③ `origin`（来源）

```js
interface Origin {
  kind: 'chat' | 'autonomous' | 'diary' | 'user_stated' | 'inferred' | 'unknown';
  ref: string;      // chatKey / roundId / dateKey
  at: string;       // ISO
  quote?: string;   // 原话片段（可选，≤ 200 字，脱敏）
}
```

**注意**：`origin.kind` 和 `epistemicType` **有重叠但不重复**：

- `origin.kind = 'user_stated'` → 通常 `epistemicType = 'direct'`
- `origin.kind = 'inferred'` → 通常 `epistemicType = 'inferred'`
- **但**：`origin` 记录"从哪来"，`epistemicType` 记录"可信度判断"
- 两者**可以不一致**（比如：用户说的，但我不确定他是不是认真的）

#### ④ `correction`（纠正事件）

**机主明确：correction 是独立的纠正事件结构，不能和上面三个混为一谈。**

```js
interface Correction {
  count: number;                  // 被纠正的次数（已有字段）
  events: CorrectionEvent[];      // 每次纠正的详情（新增）
  historicalUnresolved: boolean;  // 历史纠正无法还原时为 true
}

interface CorrectionEvent {
  at: string;                     // ISO
  correctedFrom: string;          // 原来错的
  correctedTo: string;            // 纠正后的
  by: 'user_directed' | 'autonomous';
  quote?: string;                 // 机主原话（脱敏）
}
```

**为什么独立**：

- `contentType` 回答「**说的是什么类型的事**」
- `epistemicType` 回答「**怎么知道的**」
- `correction` 回答「**被改过什么**」
- **三者正交**：一条 `fact + direct` 的记忆也可能被纠正过

### 2.3 历史 `corrections` 计数的处理（2026-11-02 实测修正）

**⚠️ 先纠正一个我在初稿里的错误假设。**

我在初稿里以为 `corrections: 1` 表示「被纠正过 1 次」。
**实测生产数据后发现：22 条全部是 `corrections: 1`，`history` 全部为空。**

**这说明 `corrections` 的真实语义是「修订次数（含首次）」**，不是「被纠正次数」：

```js
// src/learned.js 的 addExperience
const item = {
  // ...
  corrections: 1,      // ← **新建就是 1**，不是 0
};
```

而 `addExperience` 的合并分支（相似度 ≥ 0.28 且 hit ≥ 3）会把旧文本存进
`merged.history` —— 但那 22 条**没有一条走过合并分支**，所以 `history` 全空。

**结论**：

| 问题 | 答案 |
|---|---|
| 有真实纠正历史可恢复吗？ | **没有** —— `history` 全空 |
| `corrections: 1` 是什么？ | **新建默认值**，不是被纠正次数 |
| 那条「老大纠正我说话的主语…」呢？ | **纠正内容写在 `text` 里**，不是 `correction` 结构 |

**所以 22 条的 `correction` 都应该是**：

```json
{
  "count": 1,
  "events": [],
  "historicalUnresolved": true
}
```

**`historicalUnresolved: true` 的含义要写清楚**：

> 不是「数据丢了」，而是**当时就没有结构化记录**。
> 原始信息在 `text` 里（人可读），但程序无法可靠地拆成 `correctedFrom` / `correctedTo`。

**禁止**：为了「看起来有数据」而从 `text` 里启发式拆解并标成 `direct`。

**正确做法**：

- `correction.events` 保持空
- `historicalUnresolved: true`
- 如果机主要补，**人工逐条确认后再写**（那是 `user_directed`，不是自动提取）

### 2.4 未来纠正事件的写入规则

**从 R2 之后**，任何新的纠正都要写 `correction.events`：

```js
item.correction = {
  count: (item.correction?.count || 0) + 1,
  events: [...(item.correction?.events || []), {
    at: nowIso(),
    correctedFrom: oldText,
    correctedTo: newText,
    by: 'user_directed',
    quote: '机主原话（脱敏）',
  }],
  historicalUnresolved: false,
};
item.corrections = item.correction.count;   // 同步旧字段
```

---|---|
| ✅ 能从 `text` 里可靠读出纠正内容 | 恢复 `correctedFrom` / `correctedTo` |
| ⚠️ 读得出但不确定 | **人工确认后再写** |
| ❌ 读不出 | **`historicalUnresolved: true` + 保留 `count`** |
| ❌ **禁止** | **推测 `correctedFrom` / `correctedTo`** |

**上面这条的具体判断**：

- `text` 里有 `“X”改为「Y」` 的结构 → **可以提取**（`X` → `correctedFrom`，`Y` → `correctedTo`）
- **但**：这是**启发式提取**，必须人工确认
- **如果机主不确认** → `historicalUnresolved: true`

---

## 三、逐层改造方案

### 3.1 L1 经验（`learned.json`）

**改造方式**：只加字段，**不重命名现有字段**。

```json
{
  "id": "l-mvq5ul9z-fla",
  "text": "...",
  "status": "pending",
  "tags": [],
  "sourceDay": "2026-10-27",

  "contentType": "preference",          // 新增：内容类别
  "epistemicType": "direct",            // 新增：认知性质（用户直接说的）
  "origin": {                           // 新增
    "kind": "user_stated",
    "ref": "2026-10-27",
    "at": "2026-10-27T04:03:28.439Z",
    "quote": "老大纠正我说话的主语..."
  },
  "correction": {                       // 新增（保留原有 corrections 计数）
    "count": 1,
    "events": [],
    "historicalUnresolved": true
  },

  "createdAt": "...",
  "updatedAt": "...",
  "lastUsedAt": "...",
  "hits": 616,
  "corrections": 1                      // ⚠️ 保留，兼容旧代码
}
```

**兼容规则**：

- 读：`correction?.count ?? corrections ?? 0`
- 写：**同时写** `corrections`（旧）和 `correction.count`（新）
- **不删 `corrections`**

### 3.2 L2 聊天记忆（成员印象）

**⚠️ 实测修正（2026-11-02）**：初稿假设 `impressions` 是字符串数组、需要外挂 `impressionMeta`。
**实际生产数据里它已经是对象数组**：

```json
{
  "impressions": [
    {
      "content": "自称是小鲸鱼的\"老爸\"...",
      "createdAt": 1791736174961
    }
  ]
}
```

**所以不需要外挂 `impressionMeta`** —— 直接在每条上加字段就行，比初稿方案简单得多。

**改造后的结构**：

```json
{
  "impressions": [
    {
      "id": "imp-a1b2c3",
      "content": "自称是小鲸鱼的老爸...",
      "createdAt": 1791736174961,
      "contentType": "fact",
      "epistemicType": "direct",
      "origin": { "kind": "chat", "ref": "private_1846383180", "at": "...", "quote": "" }
    }
  ]
}
```

**ID 的生成与保持**：

- 新增：`imp-` + sha1(content).slice(0, 6)（基于内容 hash，天然幂等）
- **编辑时不丢 ID**：`editMemberImpression` 会整体重建数组 —— 按 `content` 匹配旧条目，
  保留原来的 `id` / `contentType` / `epistemicType` / `origin`
- 匹配不上的（内容改了）→ **新 ID + 元数据重置为默认**（因为内容变了，旧判断不再成立）

**兼容**：

- 旧数据没有 `id` → 读时按 content 算一个（**只读，不写盘**）
- 旧数据没有元数据 → `other` / `unknown` / `origin.kind = 'unknown'`

**不做的事**：

- 不从 `content` 里猜「这是事实还是推测」
- 不静默删除没有 ID 的条目

### 3.3 L3 日记（结构化与原文保留）

**机主明确**：**原文不动**。

**方案**：元数据单独存，用 **`paragraphIndex` + `sourceHash` + `quoteHash`** 三重定位。

```
E:\dsh\日记\每日\2026-11-02.md       ← 原文，一个字节不改
data/diary-meta/2026-11-02.json      ← 新增，元数据
```

**元数据格式**：

```json
{
  "dateKey": "2026-11-02",
  "sourceFile": "E:\\dsh\\日记\\每日\\2026-11-02.md",
  "sourceHash": "sha256:...",
  "entries": [
    {
      "paragraphIndex": 0,
      "quoteHash": "sha1:...",
      "quote": "这一段的开头（≤ 60 字）",
      "contentType": "event",
      "epistemicType": "direct",
      "origin": { "kind": "autonomous", "ref": "round-8f8ddcca", "at": "..." },
      "roundId": "round-8f8ddcca",
      "stale": false
    }
  ]
}
```

**三重定位的作用**：

| 字段 | 作用 |
|---|---|
| `paragraphIndex` | 快速定位（第几段） |
| `quoteHash` | **校验**这一段内容对不对 |
| `quote` | 人可读的提示（脱敏，≤ 60 字） |

**定位失败的处理（机主明确）**：

> **文件变化后定位失败必须标记 `stale`，不允许静默指向其他段落。**

```js
function locateEntry(paragraphIndex, quoteHash, currentParagraphs) {
  const p = currentParagraphs[paragraphIndex];
  // ① 段还在，hash 对得上 → 正常
  if (p && sha1(p) === quoteHash) return { ok: true, text: p };
  // ② 段还在，hash 对不上 → **stale**（内容变了）
  if (p) return { ok: false, stale: true, reason: 'hash_mismatch' };
  // ③ 段不在了 → **stale**
  return { ok: false, stale: true, reason: 'index_out_of_range' };
}
```

**关键**：

- **绝不**用"内容相似"去猜新位置（那会静默指错）
- `stale` 的条目**保留元数据**，标记出来让人看
- **不自动重新定位**

**`sourceHash` 的作用**：

- 检测**整个文件**是否被改过
- 变了 → 标记所有条目"需要复核"，但**不自动修**

### 3.4 L4 DSH 会话：**不改造**

**机主明确**：保留原始会话语义。

**3.0 不做任何字段添加。**

### 3.5 L5 Companion State：**不改造**

**机主明确**：不把 Companion State 变成普通记忆。

**它的 `source` + `history` 已经够追溯。**

---

## 四、生命周期

### 4.1 各层的生命周期（现状）

| 层 | 创建 | 使用 | 过时 | 删除 |
|---|---|---|---|---|
| **L1** | `addExperience` | `selectForContext` | `status: archived` | `removeItem` |
| **L2** | `append` | `formatForPrompt` | ❌ 无 | `remove` |
| **L3** | `writeDiary` | 她翻日记 | ❌ 无 | ❌ 无接口 |
| **L4** | DSH 自己管 | DSH | 7 天归档 | 归档 |
| **L5** | `createGoal` | `promptSection` | 终态 | 终态保留 |

### 4.2 3.0 要让「过时」变成可表达的状态

**现状**：只有 L1 有 `archived`。

**目标**：**统一用 `epistemicType: 'unknown'` + `status` 表达**，不新增状态枚举。

**为什么**：

- 各层的 `status` 语义不同（L1 是 pending/verified/archived，L5 是五态状态机）
- **强行统一会破坏语义**

### 4.3 记忆的**衰减**（5.0 才做）

**3.0 不做衰减**。**只做标注。**

---

## 五、兼容策略

### 5.1 三原则

1. **只加字段，不改现有字段的类型或含义**
2. **旧数据读取不产生写入**（惰性迁移）
3. **默认值 `unknown`，不猜**

### 5.2 双读规则

```js
// 读
const epi = item.epistemicType ?? 'unknown';
const corr = item.correction ?? { count: item.corrections ?? 0, events: [], historicalUnresolved: true };
const corrCount = corr.count;

// 写（只在真正修改时才写新字段）
item.epistemicType = ...;
item.correction = { ... };
item.corrections = item.correction.count;   // 同时维护旧字段
```

### 5.3 版本号

**不需要升级 `learned.json` 的 version**：

- 新增字段是可选的
- 旧版本读新文件不会崩（多余字段被忽略）
- 新版本读旧文件走默认值

**但**：如果将来需要**区分"迁移过"和"没迁移过"**，可以加 `metaVersion: 3`。

**3.0 暂不加。**

---

## 六、不做什么（明确边界）

| ❌ 不做 | 理由 |
|---|---|
| 把五层合并成一层 | 生命周期完全不同（机主明确） |
| 给 L4 / L5 加元数据 | 机主明确：保留会话语义 / 不变成普通记忆 |
| 推测历史 `correctedFrom` | 机主明确禁止 |
| 改日记原文 | 机主明确：原文保留 |
| 引入新存储 | Memory Hub 是门面，不是第六层 |
| 自动删除旧记忆 | 删除必须人工确认 |
| 用向量数据库 | 3.0 不做检索基础设施升级 |

---

## 七、待确认

### ① `preference` 是否独立于 `fact`

我按机主的原话设为独立一类。**确认吗？**

### ③ L3 日记的元数据用 `index` 引用

**风险**：日记被手动编辑后错位。

**接受吗？**

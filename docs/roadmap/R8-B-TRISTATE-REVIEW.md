# R8-B 三态语义：只读调用链审查

> ⚠️ **本文档的第三、四节矩阵（`false/true/unknown`）已被 `R8-B-TRISTATE-DESIGN.md`（v2：`clear/unresolved/unknown`）取代，不再作为实现依据。** 本文保留为历史审查记录。
>
> 时间：2026-11-03
> 状态：**只读审查，未修改任何生产数据 / 未运行迁移**
> 前置：机主否决选项 C，选定 **B（三态语义）**
> 已回滚：`d164e46`（C 的实现）→ `ad7b7b7`

---

## 一、`correction` 的所有写入点（全量清点）

### 1.1 `src/learned.js`

| 行 | 位置 | 写入的值 | 场景 |
|---|---|---|---|
| **261** | `DEFAULT_META` | `{ count: 0, events: [], historicalUnresolved: true }` | 缺省兜底 |
| **285–295** | `withMeta` | 从 `item.correction` 读；缺省时 `events.length > 0 ? false : true` | 每次读取时规范化 |
| **353** | `addExperience`（合并分支） | `{ count: ..., events: [], historicalUnresolved: true }` | 合并时若原来没有 correction 对象 |
| **354–362** | 同上 | `events.push({...})`（上限 20 条） | 追加纠正事件 |
| **364** | 同上 | **`historicalUnresolved = false`**（注释："现在有结构化记录了"） | 合并后 |
| **367** | 同上 | `corrections = (原值 \|\| 1) + 1` | 合并计数 |
| **389–394** | `addExperience`（新建） | `corrections: 1`，`correction: { count: 1, events: [], historicalUnresolved: true }` | **新建** |
| **466** | `saveItem` | `corrections: 1` | 改文本 |

**关键两处**：

```js
// 行 261 —— DEFAULT_META
correction: { count: 0, events: [], historicalUnresolved: true }

// 行 394 —— addExperience 新建
correction: { count: 1, events: [], historicalUnresolved: true }
```

**新建条目一律 `historicalUnresolved: true`。**

### 1.2 `src/memory.js`

| 行 | 位置 | 写入的值 |
|---|---|---|
| **436** | 缺省 | `{ count: 0, events: [], historicalUnresolved: true }` |
| **441–444** | 读 `prevCorrection` | `prev.correction` 或上面的缺省 |
| **481–484** | 写回 | `historicalUnresolved: events.length > 0 ? false : Boolean(prevCorrection.historicalUnresolved)` |

**🔴 注意这里和 `learned.js` 口径不同**：

| 模块 | 缺字段时 |
|---|---|
| `learned.js` `withMeta` | `events.length > 0 ? false : **true**` |
| `memory.js` | `events.length > 0 ? false : **保持原值**` |

### 1.3 `src/memory-hub/adapters.js`

```js
// 行 61
historicalUnresolved: Boolean(it.correction?.historicalUnresolved)
```

**🔴 第三种口径**：**缺字段时 `Boolean(undefined)` = `false`**。

### 1.4 保护判断的读取点

| 文件 | 行 | 判断 |
|---|---|---|
| `learned.js` | **532** | `const unresolved = c.historicalUnresolved === true;`（`suggestPromotion`） |
| `learned.js` | **648** | `if (item.correction?.historicalUnresolved === true)`（`archiveStale`） |

**两处都只认 `=== true`** —— `unknown` 和 `undefined` 都会被当成"没有未解决纠正"。

---

## 二、三种口径的实际差异（这是核心问题）

| 场景 | `learned.js` | `memory.js` | `adapters.js` |
|---|---|---|---|
| **新建条目** | `true` | `true` | `Boolean(true)`=`true` |
| **缺 `correction` 字段** | `true` | 保持原值（若无则 `undefined`） | `false` |
| **有 events 且已解决** | `false` | `false` | `Boolean(false)`=`false` |
| **有 events 且未解决** | `true` | 保持 `true` | `true` |

**结论**：**三个模块对"缺字段"的解释完全不同** ——
一个当 `true`（永久保护）、一个保持原值、一个当 `false`（不保护）。

**机主要的三态语义，现状是"三态没有一个模块实现了"。**

---

## 三、三态迁移矩阵

### 3.1 目标语义（机主定义）

| 值 | 含义 | 晋升 | 归档 |
|---|---|---|---|
| **`false`** | 明确知道**没有**未解决的历史纠正 | ✅ 允许 | ✅ 允许 |
| **`true`** | 存在**无法恢复**的历史纠正 | ❌ 禁止 | ❌ 禁止 |
| **`unknown`** | 历史信息不足，**无法判断** | ❌ 禁止 | ❌ 禁止 |

### 3.2 迁移矩阵：什么情况写入什么值

| # | 场景 | 现状 | **目标** | 依据 |
|---|---|---|---|---|
| **1** | `addExperience` 新建 | `true` | **`false`** | 新条目没有任何纠正历史 |
| **2** | `addExperience` 新建（带 `corrections`） | `true` | **`false`** | 同上（新条目无纠正） |
| **3** | `saveItem` 改文本 | 保留原值 | **保留原值** | 改文本不改变纠正历史 |
| **4** | 合并（相似文本） | `false` | **`false`** | 合并时有结构化 events |
| **5** | 合并时原无 `correction` | `true` | **`true`** | 合并意味着"有旧版本被替换"，属于无法恢复的历史 |
| **6** | 老数据缺 `correction` 字段 | 三个模块各不同 | **`unknown`** | 无法判断历史 |
| **7** | 老数据有 `correction` 但无 `events` | `true` | **`unknown`** | 有标记但没明细，无法判断 |
| **8** | 老数据有 `events` 且 `unresolved=true` | `true` | **`true`** | 明确未解决 |
| **9** | 老数据有 `events` 且 `unresolved=false` | `false` | **`false`** | 明确已解决 |
| **10** | `memory.js` 缺字段 | 保持原值 | **`unknown`** | 同 #6 |

### 3.3 关键区分：**新建 vs 历史**

**机主的第 5 条要求**：

> 区分新建条目与历史条目，不得仅根据 `events=[]` 批量推断

**所以迁移不能只看 `events`**，还要看**条目是什么时候创建的**、**有没有走过 `addExperience`**。

**三个可用的区分信号**：

| 信号 | 含义 | 可靠性 |
|---|---|---|
| **`correction` 字段不存在** | 老数据（`withMeta` 引入前） | **高** |
| **`correction.count === 0`** | `DEFAULT_META` 的产物 | **高** |
| **`createdAt` 早于 `withMeta` 引入时间** | 老数据 | 需要确定引入时间 |

**建议**：**用前两个信号**（字段缺失 / `count === 0`），**不依赖时间**。

---

## 四、测试矩阵

| # | 场景 | 期望 |
|---|---|---|
| **1** | `addExperience` 新建 → 读回 | `historicalUnresolved === false` |
| **2** | 新建 → `suggestPromotion` | 能产生候选（不被 `true` 拦） |
| **3** | 新建 → 推到 stable → `archiveStale` | **能归档**（`false` 不拦） |
| **4** | 老数据缺 `correction` → `withMeta` | `historicalUnresolved === 'unknown'` |
| **5** | 老数据缺 `correction` → `suggestPromotion` | **不产生候选**（`unknown` 禁止晋升） |
| **6** | 老数据缺 `correction` → `archiveStale` | **不归档**（`unknown` 禁止归档） |
| **7** | 老数据 `count:0, events:[]` | `unknown`（不是 `true`） |
| **8** | 有 events 且 `true` | 保持 `true`，禁止晋升/归档 |
| **9** | 有 events 且 `false` | 保持 `false`，允许晋升/归档 |
| **10** | `memory.js` 缺字段 | `unknown` |
| **11** | `adapters.js` 缺字段 | **不能当 `false`** —— 要带出 `unknown` |
| **12** | 三态的外来值（比如 `null` / `'yes'`） | 归一成 `unknown`，不崩 |
| **13** | `false` / `true` / `unknown` 三种值的晋升决策 | 只有 `false` 允许 |
| **14** | 三种值的归档决策 | 只有 `false` 允许 |
| **15** | 生产数据未被迁移 | 跑完测试后生产 hash 不变 |

---

## 五、需要机主确认的五个设计点

| # | 问题 | 我的建议 |
|---|---|---|
| **1** | **`unknown` 存成字符串还是 `null`？** | **字符串 `'unknown'`** —— 显式、不会被 `Boolean()` 误判 |
| **2** | **老数据迁移要不要自动跑？** | **不自动**。只在新代码里把"缺字段"读成 `unknown`，**磁盘上的旧值一个字节不改** |
| **3** | **`memory.js` 要不要同步改成三态？** | **要** —— 否则两个模块口径还是不一致 |
| **4** | **`adapters.js` 的 `Boolean(...)` 怎么改？** | 改成三态透传：`unknown` 原样带出，`true`/`false` 保持 |
| **5** | **`archiveStale` 的 `skipped` 理由要不要区分 `true` 和 `unknown`？** | **要** —— 一个说"有未解决纠正"，一个说"历史不明，保守跳过" |

---

## 六、实施顺序（等批准后）

```
① 定义三态常量 + 归一函数（唯一入口）
   normalizeCorrectionState(v) → 'true' | 'false' | 'unknown'

② learned.js
   · DEFAULT_META.correction 改成不写 historicalUnresolved（undefined = unknown）
   · addExperience 新建时显式写 false
   · withMeta 用归一函数：缺字段 → unknown
   · suggestPromotion / archiveStale 只认 false 为"放行"

③ memory.js
   · 缺省改成不写（unknown）
   · 新建时显式写 false

④ adapters.js
   · Boolean(...) 改成三态透传

⑤ 测试
   · 按上面 15 条矩阵
   · **生产数据 hash 前后核对**
```

---

## 七、这次审查没做的事

| # | 没做 | 原因 |
|---|---|---|
| **1** | 没改任何代码 | 机主要求先审查 |
| **2** | 没改 DEFAULT_META | 同上 |
| **3** | 没迁移任何老数据 | 机主明确"不运行生产迁移" |
| **4** | 没改 `memory.js` / `adapters.js` | 同上 |
| **5** | 只回滚了 C | 因为 C 被明确否决，留着是错误的代码 |

---

## 八、一个必须说清楚的边界

**机主说「不得仅根据 events=[] 批量推断」。**

**我的迁移矩阵里 #7 是「老数据 `count:0, events:[]` → `unknown`」** ——
这**不是**根据 `events=[]` 推断，**而是根据 `count:0`**（`DEFAULT_META` 的特征）。

**但这两者在数据上很难区分**：

```js
DEFAULT_META 产物:  { count: 0, events: [] }
真实的"没纠正":     { count: 0, events: [] }   ← 如果真的有这种
```

**所以是否能用 `count:0` 作为"老数据"的判据，需要机主确认。**

**更保守的做法**：**只要 `correction` 字段存在但 `events` 为空，一律 `unknown`** ——
**包括新建条目**。

**但那样新建条目永远无法晋升。**

**所以必须有一个"新建 = 明确无纠正"的信号** ——
**这就是为什么 `addExperience` 要显式写 `false`**。

**而"显式写 `false`"这件事本身，要求我们能区分"新写的"和"旧的"。**

**磁盘上的数据没有版本标记**，**所以只能靠 `addExperience` 从现在开始写 `false`**，
**已有的全部当 `unknown`** —— **这需要机主确认。**

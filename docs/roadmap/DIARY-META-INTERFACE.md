# 日记结构化接口设计（3.0-R2 前置）

> 时间：2026-11-02 22:50
> 状态：**接口设计，未实现**
> 目的：R2 阶段先把接口定下来，避免 R3 实现时返工

---

## 一、为什么单独设计

机主 2026-11-02：

> 日记结构化也应提前设计好接口，避免后面返工。

**日记和其他四层的区别**：

- **原文不可动**（机主明确）
- **内容形态最自由**（markdown 段落）
- **没有结构**（现在连段落边界都要自己推断）

**所以**：接口设计必须先定，否则实现时容易把"原文"和"元数据"搅在一起。

---

## 二、现有日记的形态

**路径**：`E:\dsh\日记\每日\YYYY-MM-DD.md`

**写入**：`src/diary/writer.js`（280 行）

**幂等**：`data/diary-idempotency.json`（9.2 KB）

**内容**：markdown，按段落组织（`## 标题` / 空行分隔）

---

## 三、接口设计

### 3.1 模块位置

```
src/diary/meta.js        ← 新增（元数据读写）
src/diary/writer.js      ← 现有（原文写入，**不改**）
```

**关键**：**元数据完全旁路**，`writer.js` 一个字节不改。

### 3.2 元数据结构

**文件**：`data/diary-meta/YYYY-MM-DD.json`

```json
{
  "version": 1,
  "dateKey": "2026-11-02",
  "sourceFile": "E:\\dsh\\日记\\每日\\2026-11-02.md",
  "sourceHash": "sha256:abc123...",
  "sourceMtime": "2026-11-02T23:50:00.000Z",
  "entries": [
    {
      "paragraphIndex": 0,
      "quoteHash": "sha1:def456...",
      "quote": "今天翻了那条架构帖",
      "contentType": "event",
      "epistemicType": "direct",
      "origin": {
        "kind": "autonomous",
        "ref": "round-8f8ddcca",
        "at": "2026-11-02T11:50:28.832Z",
        "quote": ""
      },
      "roundId": "round-8f8ddcca",
      "stale": false
    }
  ],
  "updatedAt": "2026-11-02T23:50:00.000Z"
}
```

### 3.3 对外接口

```js
// src/diary/meta.js

/**
 * 读某天的元数据（只读）。
 * 文件不存在 → { ok:true, meta:null }（不是错误）
 * JSON 损坏 → { ok:false, error }
 */
export function readDiaryMeta(dateKey) {}

/**
 * 写某天的元数据（**只在真正新增/修改时调**）。
 * 会先算 sourceHash 并校验原文存在。
 */
export function writeDiaryMeta(dateKey, meta) {}

/**
 * 把当前原文切成段落（**只读**）。
 * 返回 [{ index, text, hash }]
 */
export function splitParagraphs(dateKey) {}

/**
 * 定位一条元数据对应的段落。
 *
 * 返回：
 *   { ok:true, text }                          ← 定位成功
 *   { ok:false, stale:true, reason:'hash_mismatch' }     ← 段在但内容变了
 *   { ok:false, stale:true, reason:'index_out_of_range' } ← 段不在了
 *   { ok:false, stale:true, reason:'source_missing' }     ← 原文文件没了
 *
 * ⚠️ **绝不用「内容相似」猜新位置**（机主明确：不允许静默指向其他段落）。
 */
export function locateEntry(dateKey, entry) {}

/**
 * 给某天的日记追加一条元数据（幂等：同 paragraphIndex + quoteHash 不重复）。
 */
export function appendDiaryEntry(dateKey, { paragraphIndex, contentType, epistemicType, origin, roundId }) {}
```

**约束（R4 补充，2026-11-02）**：

> **空日记（0 段）不能 append。**
> 元数据必须指向一个已存在的段落 —— 没有段落就没有引用对象。
> 返回 `{ ok:false, error:'paragraphIndex 越界' }`。

**为什么不做「先建后关联」**：

如果允许空日记先记一条元数据，那条记录**永远定位不到**（`index_out_of_range`），
只会产生垃圾数据。将来真需要的话，那应该是**另一个接口**（比如 `addPendingEntry`），
不该改 `appendDiaryEntry` 的语义。

### 3.4 段落切分的规则

**必须稳定**（否则 `paragraphIndex` 会漂移）。

```js
function splitParagraphs(text) {
  // ① 按空行切（markdown 的段落定义）
  // ② 跳过纯标题行（## xxx）和纯分隔线（---）
  // ③ 保留段落原文（**不 trim 内部**，只 trim 首尾）
  // ④ 只保留非空段落
}
```

**关键**：**规则一旦定了就不能改** —— 改了 `paragraphIndex` 就对不上。

**如果将来必须改**：**升 `version`，旧元数据整体标 `stale`**。

### 3.5 `sourceHash` 与 `quoteHash`

| hash | 对象 | 作用 |
|---|---|---|
| `sourceHash` | **整个 .md 文件** | 检测文件是否被改过 |
| `quoteHash` | **单段内容** | 检测这一段是否变了 |

**为什么不只用 `sourceHash`**：

- 文件改一个字 → `sourceHash` 变 → **所有条目都失效**
- 有 `quoteHash` → **只有受影响的那段失效**，其余还能用

### 3.6 `stale` 的处理流程

```
读元数据
  ↓
校验 sourceHash
  ├─ 一致 → 逐条校验 quoteHash
  │         ├─ 一致 → 正常
  │         └─ 不一致 → 标 stale（hash_mismatch）
  └─ 不一致 → 逐条校验 quoteHash
              ├─ 一致的仍可用（**不整体标 stale**）
              └─ 不一致的标 stale
```

**关键**：**`sourceHash` 变了不等于全部失效** —— 逐条校验才是准的。

**`sourceHash` 的作用**是"提示需要复核"，不是"判定失效"。

---

## 四、和 writer.js 的关系

**完全不改 `writer.js`**。

**唯一的接触点**：

- `writer.js` 写日记后，**可选**调 `appendDiaryEntry`（如果那一段有 `roundId` 来源）

**但**：**R3 才接**，R2 只定接口。

---

## 五、不做什么

| ❌ 不做 | 理由 |
|---|---|
| 改日记原文 | 机主明确 |
| 从原文里猜 `contentType` / `epistemicType` | 那是模型的事 |
| 用内容相似度重新定位 | 机主明确禁止 |
| 自动修复 `stale` | 不静默改数据 |
| 把日记正文写进元数据 | 只存 `quote`（≤ 60 字） |

---

## 六、验收标准（R3 实现时）

| # | 标准 |
|---|---|
| 1 | 原文文件的 sha256 在元数据读写前后**完全一致** |
| 2 | `paragraphIndex` + `quoteHash` 能精确定位 |
| 3 | 原文改一段 → **只有那段** stale，其余正常 |
| 4 | 原文删一段 → 那条 `index_out_of_range` |
| 5 | **不出现"内容相似但位置不同"的静默重定位** |
| 6 | 元数据文件损坏 → 明确报错，不崩 |
| 7 | `appendDiaryEntry` 幂等（同段同内容不重复） |

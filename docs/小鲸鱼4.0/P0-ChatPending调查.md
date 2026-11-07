# P0 调查：Chat Pending 去重与询问生命周期

> 时间：2026-11-02 23:45
> 状态：**只读调查，未改代码**
> 范围：不扩大到 Pending 状态机重构

---

## 一、真实调用链

### 1.1 Pending 的数据结构（生产实例）

```json
{
  "id": "p-539f5f",
  "text": "等老大回应，看他怎么说",
  "status": "done",
  "source": "autonomous",
  "at": "2026-11-01T05:59:05.261Z",
  "atSource": "legacy",
  "expiresAt": "2026-12-01T06:50:30.954Z",
  "migrationTag": "chat-wait-reply",
  "settledAt": "2026-11-01T07:29:27.622Z",
  "settledBy": "autonomous"
}
```

**字段**：`id` / `text` / `status` / `source` / `at` / `atSource` / `expiresAt` / `migrationTag` / `settledAt` / `settledBy`

**没有**：`askCount` / `lastAskedAt` / `waitingSince` / `lastAskRoundId`

### 1.2 创建入口

**唯一调用点**：`plugins/autonomous/index.js`（`decision.next` 那段）

```js
if (decision.next) {
  const nextText = String(decision.next).slice(0, 120);
  const pr = addCompanionPending({
    text: nextText,
    source: 'autonomous',
    status: isWaitingForReply(nextText) ? 'waiting' : 'pending'
  });
  if (!pr || !pr.ok) warn(...);
}
```

**`addPending` 的去重**：

```js
const dup = st.pending.find((p) => p.text === t
  && p.status !== 'done' && p.status !== 'cancelled' && p.status !== 'expired');
if (dup) { added = dup; return; }
```

> ⚠️ **去重是「完全相同文本」** —— 换一种说法就当成新事项。

### 1.3 结算入口

**`settleChatPending`**（`plugins/autonomous/index.js`），每轮开始调一次。

**结算条件**：

```js
const isMigrated = p.migrationTag === 'chat-wait-reply';
const isWaiting = p.status === 'waiting';
if (!isMigrated && !isWaiting) continue;     // ← **pending 状态不结算**
if (!(userAt > at)) continue;                 // 只结算"待办产生之后"的消息
```

> ⚠️ **`status === 'pending'` 的条目永远不会被结算** —— 它被当成"还没开始做的事"。

### 1.4 prompt 注入

**`promptSection({ maxPending = 5 })`**：

```js
const act = activePending().slice(0, maxPending);   // 按 at 正序，取最早 5 条
if (act.length) {
  bits.push(`还没做完的：${act.map((p) => `${p.text}${p.status === 'waiting' ? '（在等）' : ''}`).join('；')}`);
}
```

> ⚠️ **按 `at` 正序取最早的 5 条** —— 最老的"等回话"永远在注入列表里。
> ⚠️ **`pending` 和 `waiting` 都注入**，只是多了个"（在等）"后缀。

### 1.5 `isWaitingForReply`

```js
// 说法一：等 [老大|你] …… [回|说|答|应]
/等(着|候)?[^，。；]{0,12}(老大|你)[^，。；]{0,12}(回|说|答|应)/
// 说法二：等 …… [回一句|回话|回复|答复]
/等[^，。；]{0,12}(回一句|回个话|回话|回复|答复)/
```

**对现有 7 条的实际判定**：

| # | 文本 | 判定 | 状态 |
|---|---|---|---|
| 1 | 等老大回一句，再翻翻评论里有没有人吐槽这架构 | **waiting** | `pending` ⚠️ |
| 2 | 等他回话，再决定要不要翻架构评论 | **waiting** | `pending` ⚠️ |
| 3 | 翻翻这条的评论，再瞄一眼老大回没回 | **pending** | `pending` |
| 4 | 看老大回没回，回了就一起翻评论 | **pending** | `pending` |
| 5 | 看老大怎么答，再顺着他的说法掰扯两句 | **pending** | `pending` |
| 6 | 老大回了就一起翻评论，没回就下次醒来再问一嘴 | **pending** | `pending` |
| 7 | 他回话就一起看 dsh-honcho 评论 | **pending** | `pending` |

**两个问题**：

1. **#1 #2 判成 `waiting` 但状态是 `pending`** → **说明创建时没有 `isWaitingForReply`**（或后来被改了）
2. **#3~#7 判成 `pending`** → **正则太窄**：只认"等 + 老大/你 + 回"，不认"看老大回没回""老大回了就…""他回话"

---

## 二、根因（三条叠在一起）

### 根因 1：去重只看完全相同文本

```js
p.text === t
```

**换一种说法就当成新事项** → 同一件事堆 7 条。

### 根因 2：`pending` 状态的"等回话"永不结算

```js
if (!isMigrated && !isWaiting) continue;   // pending 直接跳过
```

**而且 `isWaitingForReply` 正则太窄** → 大量"等回话"被分到 `pending` → **永不结算**。

### 根因 3：prompt 按时间正序取最早的 5 条

```js
activePending().slice(0, 5)   // at 正序 = 最老的 5 条
```

**最老的"等回话"永远在 prompt 里** → 每轮都被提醒 → 又去问。

**三条叠起来的循环**：

```
decision.next 写一条 pending（换种说法就新建）
  ↓
isWaitingForReply 判不准 → 多半落到 pending
  ↓
settleChatPending 不结算 pending
  ↓
prompt 按 at 正序取最早 5 条 → 老的"等回话"永远在
  ↓
下轮 intent 看到"还没做完的：等老大回话…" → 又去问
  ↓
又写一条 → 回到起点
```

---

## 三、字段兼容情况

| 现有字段 | 能否复用 | 说明 |
|---|---|---|
| `at` | ✅ | 可以当 `waitingSince`（创建时间） |
| `status` | ⚠️ | `waiting` 可用，但 `pending` 的"等回话"需要迁移语义 |
| `source` | ✅ | `autonomous` vs `chat` 可区分来源 |
| `migrationTag` | ✅ | 旧数据兼容标记，保留 |
| `settledAt` / `settledBy` | ✅ | 结算时写 |
| `expiresAt` | ✅ | 已有 30 天过期 |

**缺的**：

| 字段 | 用途 |
|---|---|
| `askCount` | 实际询问次数 |
| `lastAskedAt` | 最近一次询问时间 |
| `lastAskRoundId` | 最近询问所属 Round（防重复计数） |
| `silent` | 是否进入静默等待（达上限） |

**兼容策略**：新字段**可选**，旧数据读作默认值（`askCount: 0` / `silent: false`）。

---

## 四、拟修改文件及风险

### 拟修改

| 文件 | 改什么 | 风险 |
|---|---|---|
| `src/companion/state.js` | ① `addPending` 加**语义去重**<br>② 新增 `bumpAskCount(id, roundId)`<br>③ `promptSection` 按新规则筛选 | **中**（改的是核心接口） |
| `plugins/autonomous/index.js` | ① 发送成功后调 `bumpAskCount`<br>② 传 `roundId` 给 addPending | **中**（要确认"发送成功"在哪判断） |
| `test/` | 新增专项测试 | 低 |

### 不改

- `settleChatPending` 的**结算条件**（不动 `migrationTag` 逻辑）
- Pending 的**状态机**（不加新状态，用元数据表达）
- Goal 生命周期 / Round 调度 / DSH / 记忆写入开关

### 关键风险

| # | 风险 | 缓解 |
|---|---|---|
| **R1** | 语义去重**误合并不同事项** | 阈值保守；宁可保留两条也不错误合并 |
| **R2** | `bumpAskCount` 只应在**发送成功后**调 | 要找到"发送成功"的准确位置 |
| **R3** | 旧数据没有新字段 | 默认值兼容，**不写盘迁移** |
| **R4** | `promptSection` 改动影响所有注入 | 保持 <300 字符，测试覆盖 |

---

## 五、六个调查项的结论

| # | 项 | 结论 |
|---|---|---|
| 1 | Pending 数据结构 | 10 个字段，**没有询问计数** |
| 2 | `decision.next` 调用链 | 唯一入口，**去重是完整文本匹配** |
| 3 | `settleChatPending` | **`pending` 状态永不结算**；只在收到回话时 |
| 4 | `promptSection` | 按 `at` **正序取最早 5 条** → 老的永远在 |
| 5 | `isWaitingForReply` | **正则太窄**，7 条里 5 条判成 `pending` |
| 6 | 可复用字段 | `at` 可当 `waitingSince`；`lastAskedAt` / `askCount` **没有** |

---

## 六、需要你确认的三个设计点

### ① 语义去重的阈值

**我建议**：

```js
// 归一化后：去掉标点、统一空白
// 相似度用「关键词重叠 + 长度比」
// 只在 sim >= 0.6 且 长度比 >= 0.5 时判为同一事项
```

**举例**（现有 7 条）：

| 对 | 相似度 | 判同？ |
|---|---|---|
| "等老大回一句…" vs "等他回话…" | 高（都是"等…回…"） | **是** |
| "看老大回没回…" vs "等老大回一句…" | 中 | **可能否** |
| "他回话就一起看 dsh-honcho 评论" vs "等老大回话" | 低 | **否** |

**这个阈值可能不够准** —— 要不要先用**保守阈值**（0.7），观察后再调？

### ② "发送成功"在哪判断

**`executeAction` 返回 `outcome.result === 'success'`**。

**但**：`chat` 动作的成功是真的发出去了吗？

**看 `maybeShare` / chat 的发送逻辑** —— **需要再查一次**。

**这个必须先确认**，否则 `askCount` 会算错。

### ③ 静默后 prompt 怎么写

**你说**："可以保留简短状态提示，但必须明确'已经询问过，等待用户主动回复'，不能再次诱导模型提问"

**我建议**：

```
还在等的（已经问过，等他自己说）：等老大回话…
```

**而不是**：

```
还没做完的：等老大回话…
```

**这个措辞你满意吗？**

---

## 补充：② 「发送成功」到底在哪判断（已查清）

**`maybeShare` 返回 `{ mode, text }`**：

```js
const mode = dryRun ? 'dryRun' : String(s.shareMode || 'dryRun');
```

**`mode === 'live'` = 真的发出去了**；其余都是没发：

| mode | 含义 |
|---|---|
| `live` | **真发了** |
| `dryRun` | 演练 |
| `quiet` | 安静时段 |
| `capped` | 额度到顶 |
| `failed` | 发失败 |
| `invalid` | 目标不对 |

**chat 分支的写法**（`plugins/autonomous/index.js:1324`）：

```js
const sent = await maybeShare({ s, st, item: null, message: decision.message, nowTs, dryRun, isChat: true });
out.chat = sent.text;
out.mode = sent.mode;
fromMode(sent.mode, `主动说了句话：...`, '主动消息没发出去');
```

**所以 `bumpAskCount` 要挂在 `out.mode === 'live'` 之后。**

### ⚠️ 一个必须注意的坑

**`out.result === 'success'` 不等于发出了** —— `fromMode` 里 `dryRun` 也可能算 success（演练成功）。

**必须看 `out.mode === 'live'`**，不能看 `out.result`。

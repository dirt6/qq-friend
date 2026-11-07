# R8-B：纠正状态三态设计（v2）

> 时间：2026-11-03
> 状态：**设计定稿，未实施**（B1 批次）
> 取代：`R8-B-TRISTATE-REVIEW.md` 第三节的 `false/true/unknown` 矩阵
> 基线：`ad7b7b7`（C 实现回滚后）、`4007105`（Token 替换）仍在历史中
> 边界：**不修改生产记忆记录，不运行会写入生产数据的迁移或演练**

---

## 一、规范状态

```js
export const CORRECTION_STATES = ['clear', 'unresolved', 'unknown'];
```

| 状态 | 含义 | 晋升 | 归档 |
|---|---|---|---|
| `clear` | 明确知道**没有未解决的纠正** | 允许（仅通过纠正检查，不代表自动晋升） | 允许 |
| `unresolved` | 存在**明确未解决**的纠正 | 禁止 | 禁止 |
| `unknown` | 历史信息不足，**无法判断** | 禁止 | 禁止 |

**clear 只能来自明确的状态声明或明确的解决记录，不能由缺失信息推导。**

---

## 二、字段

### 2.1 规范字段

`item.correction.state`：字符串，取值只能是三态之一。

### 2.2 兼容字段（只读，保留在磁盘上）

| 字段 | 旧语义 | 新角色 |
|---|---|---|
| `item.correction.historicalUnresolved` | boolean 标记 | 仅作为**证据**：`true` → `unresolved`；`false` **不能单独**推出 `clear` |
| `item.correction.events[]` | 纠正事件列表 | 仅作为**解决记录证据**：最后一条 `source/kind/by` 是 `owner` / `user_stated` 时，配合 `historicalUnresolved=false` 才能推出 `clear` |
| `item.correction.count` | 事件计数 | **不是状态**，不参与推导 |
| `item.corrections` | 旧计数 | **不是状态**，不参与推导 |
| `item.correction` 缺失 | — | `unknown` |

### 2.3 证据优先级（字段冲突时）

从高到低，**命中即返回**：

| 优先级 | 证据 | 结果 |
|---|---|---|
| 1 | `correction.state` ∈ 三态 | 该值（**显式声明最高**） |
| 2 | `correction.historicalUnresolved === true` | `unresolved`（明确未解决标记） |
| 3 | `historicalUnresolved === false` **且** `events` 非空 **且** 最后一条 `source/kind/by ∈ {owner, user_stated}` | `clear`（明确的用户认可记录） |
| 4 | 其余（缺字段 / 只有 count / 空 events / false 无记录 / 非法 state） | `unknown` |

**明确不成立的推导**：

- `count === 0` ✗ 推 `clear`
- `events === []` ✗ 推 `clear`
- `count > 0` ✗ 推 `unresolved`
- `historicalUnresolved === false`（无 events）✗ 推 `clear`
- `historicalUnresolved` 默认 `true` ✗ 让新建条目变 `unresolved`（新建必须显式写 `clear`）

---

## 三、迁移矩阵（逐项对应真实实现）

| # | 数据情况 | 规范状态 | 依据 / 实现点 |
|---|---|---|---|
| 1 | `addExperience` 新建（创建路径显式写 `state:'clear'`） | `clear` | 优先级 1 |
| 2 | 旧条目没有 `correction` 字段 | `unknown` | 优先级 4 |
| 3 | 旧条目只有 `corrections` 计数（无 `correction`） | `unknown` | 优先级 4 |
| 4 | 旧条目只有 `correction.count` | `unknown` | 优先级 4 |
| 5 | 旧条目 `correction.events: []` | `unknown` | 优先级 4 |
| 6 | 旧条目 `count: 0, events: []` | `unknown` | 优先级 4（**不是 clear**） |
| 7 | 有 `historicalUnresolved: true`（无论 events） | `unresolved` | 优先级 2 |
| 8 | 有 `historicalUnresolved: false` + 最后一条事件为 `user_stated`/`owner` | `clear` | 优先级 3 |
| 9 | 有 `historicalUnresolved: false` + 最后一条事件不是用户认可（如 `model`） | `unknown` | 优先级 4 |
| 10 | 显式 `state: 'clear'` | `clear` | 优先级 1 |
| 11 | 显式 `state: 'unresolved'` | `unresolved` | 优先级 1 |
| 12 | 显式 `state: 'unknown'` | `unknown` | 优先级 1 |
| 13 | 矛盾：`state:'clear'` + `historicalUnresolved:true` | `clear` | 优先级 1（显式声明压过旧标记） |
| 14 | 矛盾：`state:'unknown'` + 用户认可事件 | `unknown` | 优先级 1 |
| 15 | 非法 `state`（`null` / `'yes'` / 数字） | 按 2–4 继续判；仍无证据 → `unknown` | 优先级 2–4 |
| 16 | 合并（相似文本）后 | `unresolved` | 发生纠正且新版本未获确认；`addExperience` 显式写 |
| 17 | `memory.js` 新建印象 | `clear` | 显式写 |
| 18 | `memory.js` 内容变更（一次纠正） | `unresolved` | 显式写 |
| 19 | `memory.js` 内容未变 | 沿用 `resolveCorrectionState(prev)`（旧数据即 `unknown`） | 不猜 |
| 20 | `saveItem` 改文本 | **不改纠正状态** | 改文本不改变纠正历史 |

---

## 四、创建 / 变更路径的写入规则

| 路径 | 写入 |
|---|---|
| `learned.addExperience` 新建 | `correction: { state: 'clear', count: 1, events: [] }`（**不再写 `historicalUnresolved: true`**） |
| `learned.addExperience` 合并 | push 事件后 `correction.state = 'unresolved'`（旧版本被纠正，新版本尚未被确认） |
| `learned.saveItem` | 不改 `correction` |
| `memory.addImpression` 新建 | `correction: { state: 'clear', count: 0, events: [] }` |
| `memory.addImpression` 变更 | `correction.state = 'unresolved'`，events 追加 |
| `memory.addImpression` 未变 | 保留 `resolveCorrectionState(prev)`（不写 clear） |
| `withMeta`（读时补全） | 输出 `correction.state = resolveCorrectionState(item)`；**只读，不写盘**；旧字段原样保留 |

---

## 五、唯一规范化入口

```js
/**
 * 纠正状态唯一解释器。
 * 纯函数：不修改入参、不做 I/O、不调模型。
 * @param {object} item 完整经验/印象条目
 * @returns {'clear'|'unresolved'|'unknown'}
 */
export function resolveCorrectionState(item) { ... }
```

调用方（全部必须改用它，不得各自实现）：

- `withMeta`
- `addExperience`（写入时的初始值由创建路径显式给，不靠推断）
- `suggestPromotion`（pending→verified 与 verified→stable 的纠正门禁）
- `archiveStale`（归档保护）
- `memory-hub/adapters.js`（输出透传，不再 `Boolean()`）
- `memory.js`（未变分支沿用）
- 面板/统计/测试辅助（读状态时）

---

## 六、晋升与归档门禁

| 场景 | 规则 |
|---|---|
| `pending → verified` | `unresolved` / `unknown` → blocked；`clear` 仍需满足原有通过条件（user_stated / direct 且 corrections≤1 / 有用户认可事件） |
| `verified → stable` | `unresolved` / `unknown` → blocked；`clear` 仍需 direct + 时间门槛 |
| `archiveStale` | `unresolved` / `unknown` → skipped（理由区分）；`clear` → 继续时间判断 |
| 状态变更 | 仍只通过 `setStatus(source='owner')`；**不根据 hits / lastUsedAt / 空 events 自动晋升** |

**本轮不增加可信度加权总分，不修改 epistemicType 语义。**

---

## 七、测试矩阵

| # | 用例 | 期望 |
|---|---|---|
| 1 | 新建 learned 条目读回 | `state === 'clear'` |
| 2 | 历史缺 `correction` | `unknown` |
| 3 | `count: 0` | `unknown` |
| 4 | `events: []` | `unknown` |
| 5 | `count: 1` 单独 | `unknown` |
| 6 | 明确未解决事件（`historicalUnresolved:true`） | `unresolved` |
| 7 | 显式 `state:'clear'` | `clear` |
| 8 | 显式 `state:'unresolved'` | `unresolved` |
| 9 | 矛盾字段（`state:'clear'` + `true`） | `clear`（优先级 1） |
| 10 | `resolveCorrectionState` 不修改入参 | 深比较不变 |
| 11 | `withMeta` 不污染历史（不写盘、不改入参） | 入参不变；输出 `state` 正确 |
| 12 | 重复读取结果一致 | 两次相同 |
| 13 | 旧接口兼容（`historicalUnresolved:false` + 用户认可） | `clear` |
| 14 | 晋升/归档对 unknown/unresolved 的处理 | blocked / skipped |
| 15 | 新建记忆印象 | `clear` |
| 16 | 记忆变更后 | `unresolved` |
| 17 | `adapters` 输出 `correctionState` | 与 resolve 一致，不再 `Boolean(undefined)=false` |
| 18 | dry-run 只读隔离 | 注入只读 store + 打桩写入抛错，不写盘 |

---

## 八、与旧报告的差异（为什么必须改矩阵）

| 旧矩阵（`R8-B-TRISTATE-REVIEW.md`） | 新设计 |
|---|---|
| 三态是 `false/true/unknown` | 改为 `clear/unresolved/unknown` |
| 新建 → `false` | 新建 → 显式 `clear` |
| `count:0` 可作"老数据"判据 | `count` 不是状态，一律 `unknown` |
| 老数据缺字段 → `unknown` | 保留 |
| 有 events 且 `unresolved=false` → `false` | 有 events 且用户认可 → `clear`；否则 `unknown` |
| `memory.js` 缺字段"保持原值" | 统一 `unknown` |
| `adapters.js Boolean()` | 透传三态 |

旧报告的矩阵作为历史审查记录保留，但**不再作为实现依据**。

---

## 九、本设计的边界

- 不修改生产 `data/learned.json` / `data/memory/**`；
- 不自动迁移老数据；
- 不改聊天存档（`store.js` 已完成 W1–W5/P1，与 R8-B 无关）；
- 不做 R8-C（四维可信度）、不做 R8-D（日记结构化）；
- 若实现中发现矩阵与源码不一致 → 停在设计阶段，报告证据，不自行猜测。

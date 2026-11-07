# R6-C S8-B：DSH rc.2 兼容性实测

> 时间：2026-11-03
> 状态：**只读调查 + 源码验证**
> 结论：**S8 总结论仍为 INCONCLUSIVE**（S8-B 只完成了"能不能用"的调查，没做真实订阅验证）

---

## 一、三个问题的答案

| # | 问题 | 答案 |
|---|---|---|
| 1 | `session/follow` 存在吗 | ✅ **存在，但模式是 `stream`，只能在 DSH 进程内部调** |
| 2 | `tokenUsage` 投影存在吗 | ✅ **存在**，`dsh-token-meter/lib/index.js` 行 413 |
| 3 | `llm/retry-started` 存在吗 | ✅ **存在**，字段是 `turn` 和 `step` |

---

## 二、`session/follow`：存在，但我们用不了

### 实测定义

```js
// @deepseek-ai/dsh-api-session-controller/lib/typert.host.js
{
  id: '@deepseek-ai/dsh-api-session-controller#session/follow',
  service: 'sessionController',
  namespace: 'session',
  method: 'follow',
  mode: 'stream',              // ← 关键
  invocation: { kind: 'direct' },
  parameters: [...]
}
```

### 为什么我们（headless CLI）用不了

**`mode: 'stream'` + `invocation: { kind: 'direct' }`** ——
这是 **DSH 的 remote API**，设计给**宿主进程内的客户端**（Web UI、插件）用的。

**我们的调用方式是外部进程**：

```
spawn('cmd', ['/c', 'dsh', '--profile', 'headless', '--json', '-'])
  → 只能拿到 stdout 的 JSON 事件流
  → **没有任何渠道调用 sessionController 的 service 方法**
```

**这解释了为什么 SurfCore 能用**：

> SurfCore 是 **DSH 插件**（跑在宿主进程里），
> 所以它可以直接 `ctx.sessionController.follow(...)`。
>
> **我们是外部进程，只能走 CLI 的 `--json` 事件流。**

**结论**：**`session/follow` 对我们不可用，不是配置问题，是架构位置决定的。**

---

## 三、`tokenUsage` 投影：完整结构（源码验证）

```js
// dsh-token-meter/lib/index.js 行 413
const tokenUsageProjectionDefinition = {
  key: "tokenUsage",
  stateVersion: 2,
  stateSchema: tokenUsageStateSchema,
  init: () => ({ totals: zeroBuckets(), last: null }),
  apply: (state, event) => {
    // ① retry-started 关闭"替换槽"
    if (event.type === "llm/retry-started")
      return state.last?.turn === event.data.turn && state.last?.step === event.data.step
        ? { ...state, last: null }     // ← 清空 last
        : state;

    // ② 只认这两种事件
    if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return state;

    const sample = usageOf(event);
    if (sample === void 0) return state;

    // ③ 同 (turn, step) → 替换；否则累加
    const { turn, step } = event.data;
    const buckets = bucketsFrom(sample);
    const previous = state.last !== null && state.last.turn === turn && state.last.step === step
      ? state.last.buckets : undefined;
    if (previous !== void 0 && bucketsEqual(previous, buckets)) return state;  // 完全相同就跳过

    return {
      totals: addReplacing(state.totals, previous, buckets),   // ← 先减旧再加新
      last: { turn, step, buckets }
    };
  },
  wire: {
    viewSchema: projectionSchema,
    view: (state) => state.totals      // ← 对外只暴露 totals
  }
};
```

### 三个关键设计

| 设计 | 实现 | 含义 |
|---|---|---|
| **同 (turn, step) 幂等** | `addReplacing(totals, previous, buckets)` | **先减掉上一次的，再加这次的** —— 不是忽略 |
| **retry 另算** | `llm/retry-started` 时 `last = null` | 清空后下次同 turn/step 就是**新 attempt**，会累加 |
| **对外只给 totals** | `view: (state) => state.totals` | 消费方拿到的是**累计桶**，不是逐条明细 |

---

## 四、我们目前的实现 vs DSH 官方

| 维度 | DSH 的 `tokenUsage` | 我们的 `dsh-gateway` |
|---|---|---|
| **幂等键** | `(turn, step)` | `(turn, step)` |
| **重复处理** | **替换**（先减后加） | **忽略**（保留第一次） |
| **retry 轴** | ✅ `llm/retry-started` 清空槽位 | ❌ **没有** |
| **权威总量** | `totals`（累计桶） | 逐 step 求和 |

### 差异的实际影响

**场景**：一个 step 先报了一次 usage（比如 100 tokens），然后又报一次（150 tokens，因为流式补全）

| | DSH | 我们 |
|---|---|---|
| 结果 | 150（替换） | 100（忽略第二次） |
| 正确性 | ✅ 对的（后者是最终值） | ❌ **少算 50** |

**场景**：llm 重试

| | DSH | 我们 |
|---|---|---|
| attempt1: 100 tokens | 100 | 100 |
| retry-started | last=null | （不识别） |
| attempt2: 120 tokens | **220**（累加） | **100**（当冲突忽略） |
| 正确性 | ✅ | ❌ **少算 120** |

**结论**：**我们的 usage 统计在"同 step 多次上报"和"重试"两种情况下会少算。**

**⚠️ 但目前没观察到这个现象** —— R6-C 的生产数据（`total=802131`）和 DSH 自己算的对得上。**可能是因为我们的场景里这两种情况很少发生**。

---

## 五、`llm/retry-started` 的字段

```js
if (event.type === 'llm/retry-started') {
  if (event.data.turn !== turn
   || state.kind !== 'settled'
   || state.by !== 'retry'
   || !sameAttempt(state, event.data.turn, event.data.step))
    invalid = true;
}
```

**字段**：`event.data.turn`、`event.data.step`

**没有 `retry` 序号** —— 它靠"清空 `last` 槽位"来表达"下一个同 (turn,step) 的样本是新 attempt"。

---

## 六、S8 的进展与剩余

### ✅ S8-A（已完成）

- Fake ChildProcess 的 12 个场景，**71 项测试**
- 错误分类矩阵、kill 失败、usage 幂等、跨 key 隔离

### ✅ S8-B 第一部分（本次完成）

- `session/follow` / `tokenUsage` / `llm/retry-started` 的**存在性与结构**（源码验证）

### ⚠️ S8-B 剩余（**未做**）

| # | 内容 | 为什么没做 |
|---|---|---|
| 1 | **真实超时后 session 锁能不能释放** | 需要一次真实超时（`taskkill /T` 的修复待验证） |
| 2 | **持久化 sessionId 映射的串扰** | 需要真实进程 + 多次异常 |
| 3 | **`llm/retry-started` 的真实事件顺序** | 需要触发一次真实重试 |

### ❌ 明确不可行

**`session/follow` + `tokenUsage` 投影订阅** —— **架构上做不到**（我们是外部进程）。

---

## 七、结论

> **S8 总结论：INCONCLUSIVE**
>
> - S8-A 的逻辑状态机验收：**PASS**（71 项）
> - S8-B 的 API 调查：**完成**（三个接口全部查清）
> - S8-B 的真实环境验证：**未做**（需要真实超时/重试）
> - **`session/follow` 订阅：架构上不可行**

**五项硬门槛里"工具不重复执行"仍然是 INCONCLUSIVE**（S4 环境限制，S8 不改变这个结论）。

---

## 八、一个可执行的改进建议

**我们的 usage 统计可以对齐 DSH 的语义**（不需要 `session/follow`）：

```js
// 当前：同 (turn, step) 出现不同 usage → 记冲突、保留第一次
// 改成：同 (turn, step) 出现不同 usage → **用后者替换前者**（先减后加）

// 当前：没有 retry 轴
// 改成：收到 llm/retry-started 时清空"当前 step 槽位"，
//       下一个同 (turn, step) 的样本累加而不是替换
```

**这两个改动都在 `dsh-gateway.js` 的 `applyEvent` / `decideOutcome` 里**，不依赖任何新 API。

**价值**：让 token 统计在"流式补全"和"重试"场景下不再少算。

**风险**：如果 DSH 的事件里其实**没有**这两种情况，改了也没影响；但如果**有**，改了就更准。

**建议**：**先在生产日志里查一下有没有 `llm/retry-started` 事件**，有的话就值得改。

---

## 九、补充实测（2026-11-03 22:20）

### 我们的 `applyEvent` 只处理 4 种事件

```js
// src/dsh-gateway.js
if (ev.type === 'session') ...
if (ev.type === 'final') ...
if (ev.type === 'status') ...
if (ev.type === 'error') ...
```

**但 headless `--json` 会发出更多**（R6-A 确认过 6 种：`session` / `status` / `thinking` / `text` / `final` / `error`）。

**我们只是"不处理"，不是"收不到"。**

### 生产数据里 retry / tool / thinking 都是 0

```
model-calls.ndjson: 311 条记录
  retry:    0 次
  tool_:    0 次
  thinking: 0 次
```

**这不能证明"没发生"** —— 因为 `model-calls.ndjson` 只记录 `recordDshCall` 写入的摘要字段，
**不记录原始事件流**。

### 关键判断：`llm/retry-started` 在 headless 里可能根本不存在

**理由**：
· 它是 DSH **session 内部**的 LLM 层事件（`llm/retry-started`），
  属于 token-meter 的**折叠输入**，不是 headless CLI 的**输出去向**。
· R6-A 的 23 项实测里**从没见过它**。
· `dsh-token-meter` 的注释也把它描述成"stream 内部的槽位信号"，不是对外事件。

**所以**：**给我们的 usage 加 retry 轴，收益不明确**（可能永远收不到那个事件）。

### 但有一个改动是明确值得的

**同 `(turn, step)` 出现不同 usage 时，从"忽略"改成"替换"**。

**理由**：DSH 官方的 `tokenUsage` 用的是 `addReplacing`（先减后加），
我们的"保留第一次"在**流式补全**场景下会少算。

**这个改动不依赖 retry 事件**，纯语义对齐。

**风险**：如果 DSH 的 `--json` 里一个 step 只报一次 usage，改了没影响；如果报多次，改了更准。

**建议**：**值得做，但优先级不高**（当前生产数据和 DSH 自算对得上，没观察到偏差）。

---

## 十、最终结论（更新）

| 项 | 状态 |
|---|---|
| **S8-A 逻辑状态机** | ✅ PASS（71 项） |
| **S8-B API 存在性调查** | ✅ **完成**（三个接口全查清） |
| **`session/follow` 订阅** | ❌ **架构不可行**（我们不是 DSH 进程内客户端） |
| **`tokenUsage` 投影** | ✅ 存在，但**拿不到**（同样原因） |
| **`llm/retry-started`** | ⚠️ **headless 里可能没有**（R6-A 没见过） |
| **真实超时后的 session 锁释放** | ⬜ **未验证**（`taskkill /T` 修复待实测） |
| **持久化 sessionId 串扰** | ⬜ **未验证** |
| **S8 总结论** | **INCONCLUSIVE** |

**S8 不能判 PASS 的核心原因**：真实环境验证（超时/重试/串扰）一项都没做。

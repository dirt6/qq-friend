# SurfCore 源码级对照审查

> 审查对象：`https://github.com/Mieksido/surfcore`
> **commit：`0deb8261afe4c31b3127759ee4de36a1439cf422`（release v0.8.8，2026-11-02T20:40:02Z）**
> 审查日期：2026-11-03
> 方法：GitHub Contents API 拉源码 → 本地解码 → 结构分析
> **状态：只读审查，未修改任何代码、未引入任何依赖、未执行 SurfCore 脚本**

---

## 〇、先纠正一处路径事实

**机主此前给的路径是「文档里的说法」，与实际仓库结构有偏差。** 我实测的真实位置：

| 之前说的 | 实际是否存在 | 真实路径 |
|---|---|---|
| `src/memory-card.js` | ✅ 存在 | `src/memory-card.js`（96832B / 2202 行） |
| `src/purpose-engine.js` | ✅ 存在 | `src/purpose-engine.js`（107909B / 2303 行） |
| `src/conversation-closure.js` | ✅ 存在 | `src/conversation-closure.js`（26050B / 524 行） |
| `src/token-budget.js` | ✅ 存在 | `src/token-budget.js`（17232B） |
| `src/token-ledger.js` | ✅ 存在 | `src/token-ledger.js`（41272B / 998 行） |
| 工具守卫与 preset | ✅ 存在 | `src/turn-guard.js` + `src/gate-events.js` + `dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs` |

**我一开始找错的地方**：`plugins/surfcore/lib/` 是**插件宿主侧的薄封装**（如 `lib/memory-card.js` 只有 529 行，是 `src/memory-card.js` 的宿主适配层）。**核心实现都在 `src/`**。

**这个纠错本身也印证了机主的原则：不能把文档描述当成源码事实。**

---

## 一、能力重叠矩阵

| 能力 | SurfCore 实现 | 小鲸鱼现状 | 重叠度 | 判定 |
|---|---|---|---|---|
| **记忆写入单一维护者** | `src/memory-card.js` 的 `runMemoryCardMaintenance` + promise 链串行化 | 五层记忆，Memory Hub（只读）+ R5 写入安全 | **中** | 借鉴流程，不复制存储 |
| **记忆衰减 / 全量归档** | `archiveDecayedToFull` / `compactMemoryCard` | 无 | **低** | 值得借鉴 |
| **主动目的引擎** | `src/purpose-engine.js`（2303 行，零 import 零 I/O） | `plugins/autonomous`（Round/Action） | **高** | 强借鉴 |
| **对话收尾** | `src/conversation-closure.js`（524 行，纯逻辑） | 无（backlog 有「沉默权」） | **极低** | **最值得借鉴** |
| **Token 账本** | `src/token-ledger.js`（998 行）+ `token-budget.js` | R6-C 刚修好的 usage 累加 | **高** | 借鉴幂等语义 |
| **工具守卫** | `src/turn-guard.js` + `gate-events.js` + `qq-tool-restrict.mjs` | 无（R7 待做） | **低** | 借鉴设计 |
| **权限边界** | `src/allowlist.js` + `src/state-acl.mjs` | 面板 ACL（部分） | **低** | 借鉴 fail-closed |
| **状态一致性** | `src/state-acl.mjs`（6766B） | `withFileLock` | **中** | 对比实现 |

---

## 二、最值得借鉴的 5 项（源码已验证）

### 第 1 项：`conversation-closure.js` —— **沉默权**

**源码验证**：`src/conversation-closure.js`，524 行，**纯逻辑、无 I/O、无网络、无状态**。

**导出 12 个**：
```
DEFAULT_CLOSURE_CONFIG / normalizeClosureConfig
classifyMessage
assessConversationClosure     ← 核心判定
formatClosureRecord / makeClosureRecord / normalizeClosureRecord
closurePromptBlock            ← 注入提示词
closureStatus / closureSuppressesWake   ← **抑制唤醒**
reopenClosure / closeGate
```

**关键正则（真实存在）**：

```js
END_ANY_RE     = /(晚安|拜拜|再见|886|先这样|先这么着|先撤|溜了|去忙|下了|睡了|不聊了|回头聊|改天聊|明天聊|下次聊|到此为止)/
END_STRONG_RE  = /^(晚安|拜拜|再见|886|先这样|...)[呀啦哦喔~～。...]?$/     ← 句首强信号
QUESTION_TAIL_RE = /[?？]\s*$/                                    ← 问号结尾
QUESTION_WORD_RE = /(吗|嘛|么|咋|怎么|为什么|为啥|什么|哪个|...)/      ← 疑问词
REQUEST_RE       = /(帮我|帮忙|麻烦你|请你|能不能帮我|...)/          ← 求助
ACK_RE           = /^(?:嗯+|哦+|噢+|喔+|好+|行+|可以|收到|了解|...)/   ← 附和
SETTLED_RE       = /(说好了|就这么定|扯平|一言为定|成交|定了|...)/     ← 已收束
```

**它解决的问题**（引源码注释）：
> 真人不是按条数回复的，是按「这段还有没有信息要交换」回复的。
> 硬性静音会误杀真正想问的下一句；纯靠提示词又会每轮都说「看情况」。

**关键设计取舍**：
1. **不直接静音，而是先「判断」** —— 让桥接能看见理由
2. **收尾要留痕** —— `summary`（结束点）+ `nextOpening`（下次的接法）必须落盘
3. **对方明确提问或求助时拒绝收尾**（`REQUEST_RE` / `QUESTION_*` 优先级）
4. **`closureSuppressesWake`** —— 收尾后能抑制唤醒

**对小鲸鱼的价值**：**极高**。这是 backlog 里「沉默权」的成熟实现。

**差异与冲突**：
- 小鲸鱼有 `Topic` 和 `Pending`，**没有"对话是否该结束"的判断**
- 但**不能直接搬** —— 小鲸鱼的对话发生在 QQ，收尾要考虑 `Pending` 里有没有未完成事项

**建议**：**借鉴判定逻辑（正则 + 理由），不搬代码**。
**归属**：**4.0**（作为 Session/Topic 的补充）**或 5.0**（作为主动交流的反面闸门）。

---

### 第 2 项：`purpose-engine.js` —— 结构化目标假设

**源码验证**：`src/purpose-engine.js`，2303 行，**零 import、零 I/O**（注释明确写了）。

**50 个导出**，核心链路：

```
collectMaterials        → 素材（QQ + B站 + 人格卡 + 记忆卡）
deriveDrives            → 驱动（情感/需求）
analyzePersona          → 人格分析
extractTopic            → 话题提取
makeGoal                → **目标假设**
selectPurpose           → **选择目的**
planNextFire            → 排程
evaluatePurposeTick     → **闸门判断**
markPurposeDelivered / markPurposeSkip / applyPurposeOutcome  → 状态迁移
buildPurposePrompt      → 提示词
textSimilarity / isDuplicateText  → **去重**
```

**关键常量**：
```
PURPOSE_NEEDS / NEED_LABELS / ACTION_LABELS / EMOTION_LABELS / DEFAULT_DRIVES
```

**设计意图**（引源码注释）：
> 原理不是定时复读一句问候，而是像人一样：
> · 从近期 QQ + B站 + 人格卡 + 记忆卡里提取「目的」
> · **区分「谁的目标」（我 / 主人 / 群友 / 视频里）与「观察/推断/事实」**
> · 目标带**置信度、价值、紧迫度、风险、反馈**，不是一句话直接变成欲望

**⚠️ 关键发现**：**"区分谁的目标" + "观察/推断/事实"** —— 这正是小鲸鱼的 `epistemicType`（`direct` / `inferred` / `unknown`）！

**它解决的问题**：
> 不是"一有念头就发消息"，而是"先产生结构化假设，再判断要不要行动"。

**对小鲸鱼的价值**：**极高**。5.0 的主动交流可以直接参考。

**差异与冲突**：
- **SurfCore 的 `goal` = 此刻的目标假设**（短生命周期）
- **小鲸鱼的 `Goal` = 长期方向**（周/月）
- **⚠️ 这是最大的命名冲突**：SurfCore 的 `makeGoal` 产物**绝不能**直接映射成小鲸鱼的 `Goal`

**建议**：**借鉴"四维评分 + 谁的目标 + 观察/推断区分"的结构，但必须改名**（避免与 `Goal` 混淆）。

**机主已明确**：Purpose ≠ Goal。这条**必须守住**。

**归属**：**5.0**。

---

### 第 3 项：记忆写入的单一维护者

**源码验证**：`src/memory-card.js`（2202 行）+ `plugins/surfcore/lib/memory-card.js`（529 行，宿主适配层）。

**数据流**（引 `plugins/surfcore/lib/memory-card.js` 顶部注释，**原文**）：

> · QQ 桥接（独立进程）只做两件事：把「主人消息 / 直接对她说的话 / 有情绪的公开发言」追加到 `memory-inbox.jsonl`；把 `memory-card-prompt-qq.md` 注入 QQ 提示词。
> · 本插件（DSH 宿主进程）定时摄取 inbox + `state/bili-memory.json`，跑每日遗忘整理、容量压缩，写 memory-card.json / .md / 两份 prompt 文件，并在 80/90/100% 时告警。
> · B站调度器每次醒来读 `memory-card-prompt-bili.md`。
>
> **只有本模块写记忆卡（单进程内用 promise 链串行化）；桥接只 append 不写卡，避免并发覆盖。**

**源码里验证到的关键实现**：

```js
let chain = Promise.resolve();
function serialize(task) {
  const next = chain.then(task, task);
  chain = next.catch(() => {});
  return next;
}
```

**三个很实用的细节**（源码验证）：

1. **损坏文件先备份**：
```js
if (!before && fs.existsSync(pathsNow().json)) {
  try { backupFile(pathsNow().json, 'memory-card-corrupt'); } catch {}
}
```
2. **压缩前把即将衰减的内容归档到全量卡**：
```js
const archived = archiveDecayedToFull(pathsNow(), card, config, now);
```
3. **inbox 轮转时要同时读 `.1` 和当前文件**（否则两次整理之间会永久丢掉一段）：
```js
// 桥接在 1MB 时把当前文件轮转成 .1；维护器要同时读 .1 + 当前，
// 否则「轮转恰好发生在两次整理之间」会永久丢掉那一段
for (const file of [`${pathsNow().inbox}.1`, pathsNow().inbox]) { ... }
```

**对小鲸鱼的价值**：**高**。

**差异与冲突**：
- 小鲸鱼**已有五层记忆**，**不应再建一套记忆卡**
- 但**"写入入口与维护者分离"这个模式**值得借鉴

**建议**：**借鉴流程，不复制存储结构**。

**归属**：**3.0**（记忆可信化的延伸）。

---

### 第 4 项：Token 账本的幂等语义

**源码验证**：`src/token-ledger.js`，998 行。

**设计意图**（引源码注释，**原文**）：

> 1. **权威总量来自 DSH 的 tokenUsage 投影，不来自桥接自己累加。**
>    `session/follow` 的 snapshot 帧带 `projections.values.tokenUsage`，
>    是**整条会话日志**的累计桶（含桥接启动之前的历史）。
> 2. **逐轮明细靠事件折叠，且必须幂等。**
>    snapshot 帧的 `records` 在重连时会**重新下发**；
>    因此同一 `(session, turn, step, retry)` 的采样必须「**后到覆盖先到**」，而不是累加。
>    - `assistant/message` / `assistant/attempt` 带 usage 时，同 `(turn, step)` 覆盖上一次采样；
>    - `llm/retry-started` 结束该覆盖作用域，于是重试的第二次请求**另算一次**（retry 轴 +1）。

**⚠️ 这对小鲸鱼是一个重要对照**：

| 维度 | SurfCore | 小鲸鱼（R6-C 刚修的） |
|---|---|---|
| 权威源 | DSH 的 `tokenUsage` 投影 | `step_end` 的 usage 累加 |
| 去重键 | `(session, turn, step, retry)` | `(turn, step)` |
| 重试处理 | `llm/retry-started` 另算一次 | **没考虑 retry 轴** |
| 累加语义 | **后到覆盖先到**（不是累加） | **逐步累加** |

**关键差异**：
- SurfCore 是「同一位置覆盖」
- 小鲸鱼是「不同 step 累加」

**两者不矛盾**（一个是同 step 幂等，一个是跨 step 聚合），但 **SurfCore 多了 `retry` 轴** —— 这是小鲸鱼**没覆盖**的。

**⚠️ 待验证**：`session/follow` 和 `tokenUsage` 投影在 **rc.2** 里是否存在？**R6-A 的 23 项清单里没测过**。

**建议**：
1. **借鉴 `retry` 轴的思路**（小鲸鱼的 `(turn, step)` 应该扩成 `(turn, step, retry)`）
2. **R6-C 补测**：rc.2 有没有 `tokenUsage` 投影

**归属**：**4.0**（Session 迁移时）。

---

### 第 5 项：工具守卫的「预期内业务拒绝」区分

**源码验证**：`src/turn-guard.js`，113 行，**纯策略，不碰 DSH / QQ / 文件**。

**设计意图**（引源码注释，**原文**）：

> 触发条件只有三类：
> · 单轮工具步数超上限；
> · 同一 tool + 同一错误重复到阈值；
> · 每日额度在回合中间被判定为已耗尽。
>
> 真正的 cancel / 通知由 bridge 做；这里只回答"该不该停、为什么停"。

**关键设计**（源码验证）：

```js
// 预期内的业务拒绝（不是"环境坏了"）：模型重试是浪费，但**不该把整轮停掉**——
// 这类错误自带下一步（比如 qq_close_conversation 会让你先发消息），停轮只会让用户困惑。
// 2026-10-31 实测：同一会话里 qq_close_conversation 连续 3 次「收尾失败…建议 qq_send_message」
// 触发 L3 停轮；实际是模型没听建议，不是通道故障。
const EXPECTED_REJECTION_RE = /(收尾失败|不能收尾|还没到收尾|请先|不在允许|未授权|白名单|审计|令牌|参数|不能为空|格式|频率|限流|已禁用|未开启|没有配|...)/;
```

**它解决的问题**：**区分「环境坏了」和「模型没听话」** —— 后者不该触发止血。

**对小鲸鱼的价值**：**中高**。

**差异与冲突**：
- 小鲸鱼**还没有工具守卫**（R7 待做）
- 这个"预期内拒绝"的区分，**可以直接用**

**建议**：**借鉴设计**（`EXPECTED_REJECTION_RE` 的思路），**不搬正则**（那是 QQ 专用的业务词）。

**归属**：**4.0**（R7 工具权限）。

---

## 三、不建议借鉴的模块

| 模块 | 原因 |
|---|---|
| **`src/bridge.js`（17307 行 / 802KB）** | **巨型单体**，包含 QQ 桥接、B站、桌宠全部逻辑。**小鲸鱼的 `dsh-gateway` 只有 1000 多行，引入它等于重写整个项目** |
| **`src/mcp-snowluma-safe.js`（87584B）** | SnowLuma 专用，小鲸鱼用的是 NapCat + OneBot，**协议不同** |
| **`src/voice-*.js`（语音相关，共约 12 万字节）** | 小鲸鱼没有 TTS/语音包需求 |
| **`plugins/surfcore/lib/pet-*.js`** | 桌宠载体，小鲸鱼**没有桌面端** |
| **`src/bili-*.js`（B站相关）** | 小鲸鱼**没有 B站集成** |
| **`dsh/agent-presets/`** | 依赖 SurfCore 自己的 DSH 插件体系，**小鲸鱼的 DSH 用法不同** |

---

## 四、可直接复用的代码候选

**结论：没有可以直接 copy-paste 的模块。**

理由：
1. **所有核心模块都依赖 SurfCore 自己的 `paths.js` / `store.js` / `character-persona.js`**
2. **`src/bridge.js` 的调用约定（`callBridge` / `appendInbox`）和小鲸鱼的 `dsh-gateway` 完全不同**
3. **SurfCore 的目标 DSH 版本和本地 `0.2.0-rc.2` 不同**（机主已明确不能假定兼容）

**唯一可能"抽取逻辑而非代码"的**：
- `conversation-closure.js` 的**判定正则与优先级**（纯逻辑，可以重写）
- `turn-guard.js` 的**三类触发条件与「预期拒绝」思路**（纯策略，可以重写）

---

## 五、对 3.0—5.0 路线的调整建议

| 阶段 | 原计划 | 建议调整 |
|---|---|---|
| **3.0** | 记忆可信化（已完成 R2/R3） | **不变**。SurfCore 的记忆卡流程可以作为**未来多来源接入的参考**，但**现在不引入** |
| **4.0** | R6 Session 迁移 + R7 工具权限 | **R7 增加一项：借鉴 `turn-guard` 的「预期内业务拒绝」区分**。<br>**R6-C 补测**：rc.2 有没有 `tokenUsage` 投影 |
| **5.0** | R8 规划 + R9 记忆治理 + R10 主动交流 | **R10 强借鉴 `conversation-closure` + `purpose-engine`**。<br>**但 Purpose ≠ Goal 的红线必须守住** |

**一条新增的路线建议**：
> **「沉默权」应该从 backlog 提升为 5.0 的显式交付项**，因为 SurfCore 已经证明它可以做成纯逻辑、可测试、可解释的组件。

---

## 六、需要进一步实验验证的问题

| # | 问题 | 为什么重要 |
|---|---|---|
| **1** | **rc.2 是否有 `session/follow` 和 `tokenUsage` 投影？** | 如果有，小鲸鱼的 Token 统计可以改成读投影（更权威）；如果没有，只能继续用 `step_end` 累加 |
| **2** | **rc.2 的事件流里有没有 `llm/retry-started`？** | 决定要不要给 usage 加 `retry` 轴 |
| **3** | **SurfCore 的 `closureSuppressesWake` 在真实使用中的误判率** | 单看代码无法判断正则的召回/精确率 |
| **4** | **`purpose-engine` 的 50 个导出里，哪些是真正被 `bridge.js` 调用的？** | 2303 行里可能有大量未使用代码 |

---

## 七、最终建议

| 模块 | 建议 | 归属 |
|---|---|---|
| `conversation-closure.js` | **借鉴（最高优先级）** | 5.0（或超前到 4.0） |
| `purpose-engine.js` | **借鉴**（但必须改名避免与 `Goal` 冲突） | 5.0 |
| `memory-card.js` 的维护流程 | **借鉴** | 3.0 延伸 |
| `token-ledger.js` 的幂等语义 | **借鉴 retry 轴** | 4.0（R6-C 补测） |
| `turn-guard.js` 的预期拒绝区分 | **借鉴** | 4.0（R7） |
| `bridge.js` / 语音 / B站 / 桌宠 | **拒绝** | — |

### 一句话结论

> **借鉴设计，不搬代码。最高价值是 `conversation-closure.js`（沉默权）和 `purpose-engine.js`（结构化目标假设 + 谁的目标 + 观察/推断区分）。**

**两个必须守住的边界**：
1. **Purpose ≠ Goal**（SurfCore 的 `makeGoal` 是短生命周期的目标假设，绝不能映射到小鲸鱼的长期 `Goal`）
2. **不新增平行记忆存储**（五层结构足够，只借鉴「写入与维护分离」的流程）

---

## 八、本报告的证据等级标注

| 结论 | 等级 |
|---|---|
| commit hash / 文件路径 / 行数 / 字节数 | **源码已验证**（GitHub API 实测） |
| `serialize()` promise 链 / `backupFile` / `archiveDecayedToFull` | **源码已验证**（读了实现） |
| `conversation-closure.js` 的 7 个正则 | **源码已验证**（抓了常量） |
| `turn-guard.js` 的 `EXPECTED_REJECTION_RE` | **源码已验证** |
| `token-ledger.js` 的「后到覆盖先到」语义 | **源码注释**（未逐行验证折叠算法） |
| `purpose-engine.js` 的 50 个导出 | **源码已验证**（导出列表），**但各函数内部实现未逐个读** |
| 「SurfCore 的 DSH 版本与 rc.2 不兼容」 | **推测**（未核验 SurfCore 的 DSH 版本声明） |
| 各项的「实际效果 / 误判率」 | **未验证** |

---

## 九、本次审查的边界

- **没有修改小鲸鱼任何代码**
- **没有引入任何 SurfCore 依赖**
- **没有执行 SurfCore 的安装脚本**
- **没有导入其运行数据**
- **没有使用任何真实账号凭据**
- **没有修改 DSH Session / 调度 / 生产配置**
- 拉下来的源码只放在 `%TEMP%\surfcore-audit\`，**用完即弃**

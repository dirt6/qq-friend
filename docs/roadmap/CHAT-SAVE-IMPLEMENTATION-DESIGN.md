# 聊天持久化并发修复 · 实现设计修订版

> 时间：2026-11-03
> 状态：**只读设计，未改任何代码 / 未动生产数据 / 未启动第二个机器人实例**
> 依据：机主对《CHAT-SAVE-CONCURRENCY-INVESTIGATION》的逐条拍板 + 六个追问
> 本版取代原报告第九节（目标设计）的草案；原报告第一至八节的事实仍有效，第九节的 `mergeChatStates(fresh, state)` **作废**。

---

## 零、为什么原草案不能直接用

原草案的核心是：

```js
const fresh = loadChat(state.chatKey);
const merged = mergeChatStates(fresh, state);   // ← 问题在这一行
writeFileAtomic(file, JSON.stringify(merged));
```

`state` 是调用方**改之前从内存拿的完整快照**。它不是"待合并的数据源"，是"过期的全量状态"。

机主点出的三个后果，都成立：

| 现象 | 机制 |
|---|---|
| 旧的 `mid: null` 消息被反复追加 | `state.messages` 里每一轮都带着整份历史，合并时"内存有、磁盘无"的判定会把旧 null 消息当新消息 |
| 已删除的消息复活 | 删除只发生在磁盘；下一轮任何 `appendSelf` 都带着删除前的内存快照回来 |
| 旧 id 写回 | `nextLocalId` 和 `id` 都在内存快照里，合并时无法判断谁更新 |

**修法不是"合并两个快照"，而是"把操作搬进锁里"。**

调用方不再提交快照，只提交**要做什么**。锁内的 mutator 拿磁盘最新状态执行同一个动作。这样"旧快照"从根上不存在。

---

## 一、Q2：聊天文件的所有写入入口（全量清点）

### 1.1 写入入口：2 个

| # | 入口 | 位置 | 形态 | 当前状态 |
|---|---|---|---|---|
| **1** | `saveChat(state)` | `src/store.js:40` | 固定 tmp 名 `${file}.${pid}.tmp` + rename | 主入口，11 个调用点 |
| **2** | `appendSelfToFile()` | `plugins/silence-ping/index.js:264` | 自己读改写 + `${file}.${pid}.tmp` + rename 重试 4 次 | **旁路写入**；config 里 `enabled: false`，代码在 |

**原报告说"只有 saveChat 一个写入函数"不准确。** 漏了 silence-ping。

它现在没启用（`data/config.json` 的 `skills.silence-ping.enabled = false`），但代码随时可被打开。打开后它和主进程并发写同一个 `private_<QQ>.json`：

```
主进程：读内存快照 → push → 写全量          ← 旧 bug
插件：  读磁盘       → push → 写全量          ← 同样是"读旧写全量"
```

它的 4 次 rename 重试只解决"写失败"（EPERM），**不解决"读旧覆盖"**。两个入口必须用同一把锁。

### 1.2 只读入口（不受锁约束）

| 入口 | 位置 | 说明 |
|---|---|---|
| `loadChat(chatKey)` | `store.js:30` | store 内部读盘 |
| `#state(chatKey)` 内存缓存 | `store.js:57` | 首次读盘，之后一直用内存 |
| `loadChatFile` / `fileChats` | `plugins/silence-ping/index.js:236,257` | 插件自己的只读视图 |
| `lastUserMessageAt` / `readRecentChat` / `chatTopicsToday` | `plugins/autonomous/index.js:189,910,927` | 只读 `private_<master>.json` |
| `audit-sessions.mjs` | `scripts/audit-sessions.mjs:42` | 启动审计时统计 |
| 其余模块 | 一律走 `store.findByMid` / `recent` / `listChats` | — |

### 1.3 实测

```
data/messages/ 下会话文件：1 个（private_1846383180.json，6383 条）
*.tmp 残留：0 个
全仓库搜 MESSAGES_DIR / data/messages 的写操作：只有 store.js 与 silence-ping
```

**结论**：写入入口 2 个。第 2 个本期一并迁移（见第八节 ④）。

---

## 二、Q1：11 个调用点分别是什么操作，能否全部迁移进锁内 mutation

### 2.1 统一接口

示意如下，**不是可执行代码**：

```js
// store.js 内部
#update(chatKey, mutator, opts = {}) {
  const file = chatFile(chatKey);
  return withFileLock(file, () => {
    const fresh = readChatForWrite(chatKey);       // ① 锁内读磁盘；损坏 → 抛错，绝不返回空状态
    const { value, write = true } = mutator(fresh) ?? {};   // ② 对最新状态执行动作
    if (write) writeFileAtomic(file, JSON.stringify(fresh, null, 1));  // ③ 锁内原子写
    this.chats.set(chatKey, fresh);                // ④ 写后同步内存缓存
    this.#stamp(chatKey);                          // ⑤ 记录 mtime/size，供读路径判陈旧
    return value;
  }, { retries: 100, waitMs: 20, ...opts });
}
```

三条约定：

1. mutator 只拿到**磁盘最新状态**，不拿调用方手里的旧对象。
2. 返回 `{ value, write }`：`write:false` 用于"幂等命中 / 无变化"，避免无意义的整文件重写。
3. 读—改—写—rename 全在临界区。锁是稳定的 `${file}.lock` sidecar，不会被 rename 替换。

### 2.2 逐点映射

| 行 | 方法 | 锁内 mutator（对 `fresh` 执行） | 返回 | 写盘条件 |
|---|---|---|---|---|
| 109 | `appendIncoming` | 幂等检查（同 mid + ts 窗）→ push `{id: fresh.nextLocalId++}` → `trim` | 新 entry（或已存在的 entry） | 真新增才写 |
| 134 | `appendSelf` | 幂等检查（同 mid + ts 窗）→ push（self/read:true）→ `trim` | entry | 真新增才写 |
| 146 | `drainUnread` | 取 `!read && !self` 快照 → 全部置 `read` | unread 数组 | 总是写（保持现状语义） |
| 174 | `drainUnreadFrom` | 按 `fromTs` 分流 batch/archived → 全部置 `read` | `{batch, archived}` | 总是写 |
| 194 | `markAllRead` | 全部 `!read && !self` 置 `read` → 计数 | n | n>0 |
| 214 | `markEntryRead` | 按 id 找 → `!read && !self` → `read=true` | bool | 命中才写 |
| 235 | `markUnreadInWindow` | 时间窗内 `read→false` | n | n>0 |
| 281 | `markRecalled` | 按 mid 找 → `recalled=true; read=true` | bool | 命中才写 |
| 303 | `updateByMid` | 按 mid 找 → 改 text / appendMedia（按 url 去重） | bool | 命中才写 |
| 324 | `removeByLocalIds` | 按 id 集合 filter | removed | removed>0 |
| 337 | `clearChat` | `messages=[]`（`nextLocalId` 不重置，与现状一致） | removed | removed>0 |

**全部可迁移。** 没有一个方法需要"合并"。

### 2.3 返值与调用方

签名不变（同步）。20+ 个调用点一行都不用改：

```
app.js:907,1052,1127
orchestrator.js:347,411,413,588,685,698,712,713,725
routes.js:2859,2869,2876,2899,2920
sender.js:183,271,337,377,394
tools.js:605
```

### 2.4 新增的失败语义（必须定，见 5.4）

| 场景 | 现状 | 迁移后 |
|---|---|---|
| 磁盘写失败（ENOSPC / EBUSY 重试耗尽） | 异常冒泡 | 同 |
| 锁超时 | 不存在 | 抛 `ELOCKTIMEOUT` |
| 读盘时文件损坏 | 静默当空会话（不写） | **抛错，不写**（见 4.2 R2） |

⚠️ `sender.js:183`：`appendSelf` 在 `sendText` **成功之后**调用。若它因锁超时抛错，sender 的 `Promise.allSettled` 会把这个已发出的消息记为 failed，模型可能重发。**"记录失败"不能等同"发送失败"**。建议 sender 捕获 appendSelf 异常 → warn 日志 + emit 事件，不改变 sent 结果（见 9.2）。

---

## 三、Q3：mid、内部 ID、localId 的生成者与引用方

### 3.1 mid（QQ 消息 id）

| 来源 | 生成者 | 位置 | 可空 |
|---|---|---|---|
| 入站消息 | OneBot `message_id` | `app.js:908` | 正常不空 |
| 拍一拍（合成事件） | 无 | `app.js:1053` | **是** |
| 机器人发送 | OneBot 返回 `message_id` | `sender.js:183,271,337,377,394` | 可能（兜底 `?? null`） |
| 面板 test-send | **没传** | `routes.js:2859` | **是**（拿到了 `data.message_id` 却丢弃） |
| silence-ping 主动私信 | 没传 | `index.js:1252` | **是** |

事实：现有 6383 条里 `mid: null` 64 条（1%）；mid 无重复（抽查）；mid 可为负数（`test/message-id-test.mjs` 已覆盖）。

### 3.2 localId（条目 `id`）

**生成**：`fresh.nextLocalId++`，每个会话文件一个独立计数器（`store.js:37,87,121`）。

**引用方（这就是"不能重排"的证据）**：

| 引用方 | 位置 | 用法 |
|---|---|---|
| 存档页勾选/删除 | `ui/app/04-archive-usage.js:305-314,223` | `data-midrow`、`chatDeleteSelected` 都是 `m.id` |
| 引用勾选 | `ui/app/10-feedback.js:699,733` | `quoteSelected` 是 `m.id` |
| 删除接口 | `routes.js:2893-2902` | 按 `ids` 调 `removeByLocalIds` |
| 按 id 查 | `store.findByLocalId` | tools / skills |
| 事件日志 | `companion/events.js` | 记 `localId` |

**结论**：已发 id 永不重排（机主已定）。新消息在锁内 `fresh.nextLocalId++` 分配，已有 id 原样保留。

### 3.3 nextLocalId 冲突

迁移后不会冲突：两个进程各拿一次锁，后者读到前者的 `nextLocalId` 再 +1。旧报告问题 3（"合并时按 ts 重排"）**作废**——不合并，自然不需要重排。

唯一风险：文件损坏被重置为 1（见 4.2 R2）。

---

## 四、Q4：修改/删除时，如何防止旧进程把已删除的消息写回来

### 4.1 迁移后为什么天然安全

| 旧路径（快照写回） | 新路径（操作迁移） |
|---|---|
| `st = 内存快照`；`st.messages = filter(...)`；写回整份 | 删除：锁内 `fresh = 磁盘`；`fresh.messages = filter(...)`；写回 |
| 另一个进程随后 `appendSelf`，带着**自己内存里的旧列表**整体写回 → 删掉的消息复活 | 另一个进程 `appendSelf` 时锁内重读磁盘（已删）+ push 一条 → 已删的不会回来 |

三条机制：

1. **没有"整份快照写回"的路径了**——每个写操作只对 fresh 施加一个动作。
2. **修改/删除都在 fresh 上按 mid/id 定位**。找不到就返回 false、不写盘（`markRecalled` / `updateByMid` 现状已是这样，迁移后更严格）。
3. **append 只 push 新条目**，不会把调用方手里的旧列表带进来。

### 4.2 仍然存在的三个风险

#### R1 内存缓存陈旧（中等）

`#state` 首次读盘后**永不失效**（`store.js:57-60`）。进程 A 的 `recent()` 看不到进程 B 刚写的消息；进程 B 删了消息，A 的 UI/上下文仍显示。

- 迁移后**不会**导致持久化复活（A 的任何写都基于 fresh）；
- 但**展示层会复活**，且 A 的下一轮提示词会带上已删消息。
- 对策：`#state` 增加 `mtimeMs + size` 校验（`fs.statSync`，成本 <0.1ms），变化即重读；写后主动 `#stamp`。建议纳入本次（低风险）。

#### R2 坏文件静默重置（**最危险，必须修**）

现状 `loadChat` 的 catch 吞掉一切错误：

```js
} catch { /* 新会话 */ }
return { chatKey, nextLocalId: 1, messages: [] };
```

读的时候无害。**迁移后每次写都先 `loadChat`**——一旦 JSON 解析失败（半截文件、磁盘错误、别的工具改坏），就会拿空状态写回，**6383 条全丢**。

- 对策：区分 `ENOENT`（新会话，正常返回空）与其他错误（损坏/权限）：把原文件备份成 `${file}.broken-<ts>`，**抛错、不写盘**，日志 warn。做法与 `state-store.js:71-77` 一致。
- 这条必须纳入，否则并发修复本身会变成一个新的数据丢失源。

#### R3 插件旁路（中等）

silence-ping 的 `appendSelfToFile` 不遵守锁（见 1.1）。对策：本期一起迁移（约 20 行，import `withFileLock` + `writeFileAtomic`，锁内读改写）。它当前 `enabled: false`，改动无线上风险。

### 4.3 clearChat 的语义边界

`clearChat` 在锁内读 fresh 并清空：**清空时刻之前的所有消息消失**，之后 append 的保留。不做版本隔离（那是 WAL 的范畴）。两个进程同时 clear 是幂等的。

---

## 五、Q5：file-lock.js 的真实超时、异常释放、陈旧锁回收语义

### 5.1 事实（逐条读代码得出）

| 项 | 值 | 位置 |
|---|---|---|
| 等待预算 | 1500 × 20ms = **30 秒** | `file-lock.js:40-41` |
| 抢锁方式 | `writeFileSync(lock, payload, { flag: 'wx' })` —— Windows 上是 `CREATE_NEW`，原子排他 | `:150` |
| 锁文件 | `${file}.lock`，稳定 sidecar | `:136` |
| 锁内容 | `{ pid, token, startedAt, host }` | `:140-145` |
| 释放 | 先读 holder，**token 相同才 unlink** | `:170-175` |
| 陈旧判定 | 有 pid 且进程存活 → **永不判陈旧（哪怕 1 小时）**；pid 死 → 陈旧；旧格式无 pid → mtime 15 秒 | `:107-122` |
| 回收 | unlink 后 `continue`，重新 `wx` 竞争，只有抢到的进临界区 | `:156-160` |
| 超时 | 抛 `Error`，`code = 'ELOCKTIMEOUT'` | `:179-181` |
| 原子写 | 唯一 tmp 名（pid+时间+随机）+ rename；EPERM/EBUSY/EACCES 重试 12 次（15+10i ms），失败清理 tmp | `:193-219` |
| PID 重用 | 理论风险；token 含随机串缓解；不追求 100% | `:19-23` |

补充：`state-store.js:55-60` 的 `withState` 对 `ELOCKTIMEOUT` **再重试 3 次**——每次又是 30 秒，最坏 90 秒。store **不要**套 `withState`，直接 `withFileLock`。

### 5.2 三个必须正视的限制

**L1 同步阻塞。** `sleepSync` 用 `Atomics.wait`，主线程等待期间冻结。30 秒预算 = 最坏冻结 30 秒；Electron 主进程冻结 = 面板、SSE、托盘全卡。聊天写频率远高于经验库，这个上限不能照搬。

**L2 不会误删活锁。** holder 存活就不回收，这是 R5 重写的核心修复（旧实现按 mtime 15 秒会删掉仍在用的锁）。✓

**L3 持锁进程崩溃可恢复。** 进程死 → pid 死 → 下个进程判陈旧、回收、重抢。两个进程同时回收有竞态，但 `unlink` + `continue` + `wx` 的设计保证只有一个进入临界区。✓

### 5.3 建议参数

`retries: 100, waitMs: 20` → **2 秒上限**。

理由：
- 正常单进程：锁永远空闲，0 等待；
- 双进程偶发冲突：2 秒内可抢 100 轮，足够（实测一次完整写约 12–15ms）；
- 最长冻结从 30 秒降到 2 秒，主线程安全得多。

### 5.4 超时后的行为

抛 `ELOCKTIMEOUT`，**不静默跳过**（机主禁止静默）。调用方行为见 2.4 与 9.2。

正常路径不会触发；若触发，说明另一个进程持锁超过 2 秒——那是异常状态，值得让调用方看见。

### 5.5 性能实测（只读测量）

```
文件 1.5 MB / 6383 条：
JSON.parse      中位 3.6 ms
JSON.stringify  中位 5.8 ms
加 1.5 MB 写盘与 rename，单次 append 约 12–15 ms
```

当前实现每次也是全量写（saveChat），迁移后多一次读+解析。个人聊天量级可接受。

---

## 六、Q6：双进程隔离测试怎么验"新增、修改、删除、冲突、null-mid 都不丢"

### 6.1 隔离方式

- 临时 `DATA_DIR`：`process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(...)`，**必须在 import src 前设**（`MESSAGES_DIR` 是模块级常量）。
- 子进程：`spawn(process.execPath, ['-e', script], { stdio: ['ignore', outFd, errFd] })`——沙箱里 pipe 会 EPERM，走文件 fd。与 `test/learned-concurrent-test.mjs` 同构。
- 不启动真实机器人、不连 OneBot、不碰真实 data/。

### 6.2 用例矩阵

| # | 用例 | 操作 | 期望 | 对应追问 |
|---|---|---|---|---|
| 1 | 并发新增 | A、B 各 append 100 条（不同 mid） | 总数 200，id 唯一且连续，无一条被覆盖 | 新增 |
| 2 | 同 mid 幂等 | A、B 同时 append 同一 mid + 同一 ts | 只 1 条；两边拿到的 id 相同 | 冲突 |
| 3 | null-mid 追加 | A、B 各 append 1 条 `mid:null` | 2 条都在，id 不同 | 冲突 |
| 4 | 删除不复活 | 预置 50 条；A 删 id 1–10，B 并发 append 5 条新消息 | 1–10 不在；新 5 条在；其余 40 条在 | 删除 |
| 5 | 撤回并发 | A `markRecalled(mid)`，B 同时 append | `recalled=true` 保持；新消息在 | 修改 |
| 6 | 清空并发 | A `clearChat`，B append 3 条 | 旧 50 条清空；B 的 3 条在；A 的 `nextLocalId` 不重置 | 删除 |
| 7 | 修改并发 | A `updateByMid` 改 text，B 同时 `updateByMid` 补 media | text 与 media 都在（锁内各改各的字段） | 修改 |
| 8 | 锁超时 | 另起进程持锁 5 秒不释放；store 用 `retries:2, waitMs:10` | 抛 `ELOCKTIMEOUT`；磁盘**没有被写**；无 tmp 残留 | 锁 |
| 9 | 坏文件 | 预置非法 JSON，再 append | 抛错；原文件被备份为 `.broken-*`；原文件字节不变 | 删除/修改 |
| 10 | 生产隔离 | 全部用例跑完后比对真实 `data/messages/private_1846383180.json` 的 sha256 | 与跑前一致 | — |

### 6.3 判定

- 每项打印 `✓/✗`，失败 `exit 1`；
- 全部在 `mkdtemp` 目录内；
- 用例 8 的"磁盘没被写"用文件 sha256 前后对比；
- 用例 9 的"原文件字节不变"同样用 sha256。

---

## 七、本次不解决的（明确边界）

| # | 问题 | 为什么不在本次 |
|---|---|---|
| 1 | **"已进内存、未落盘就被杀"** | 锁解决不了。需即时落盘或 WAL，是更大改动；机主已明确不顺便加 |
| 2 | 读路径也加锁 | 读频率高，加锁代价大；用 mtime 校验在正确性与成本间取平衡 |
| 3 | 进程管理层（`instance-lock` / `killStaleSiblings`） | 已由 `056b865` 处理，独立工作包 |
| 4 | 会话文件 22 MB 只增不减 | 独立工作包 |
| 5 | 异步化（避免同步阻塞） | 需要改 20+ 调用点签名，风险大；2 秒预算下暂不需要 |

**一句话**：本次修的是"**两个写者互相覆盖**"，不是"**写者自己死掉**"。后者需要下一级持久化机制，先有证据再动。

---

## 八、实施顺序（等批准后）

```
① 修 loadChat：损坏 → 备份 + 抛错，不再静默返回空          ← 先做，否则后面的锁会放大丢数据风险
② store 增加 #update(chatKey, mutator)：锁内读改写 + 原子写 + 缓存同步
③ 11 个方法逐个迁移到 #update（每个方法独立小步，可单独 review）
④ silence-ping.appendSelfToFile 迁移到同一把锁
⑤ #state 增加 mtime+size 校验（读路径一致性）
⑥ 新增 test/store-concurrent-test.mjs（第六节 10 个用例）
⑦ 专项测试 + 全量回归 + diff 审查
⑧ 独立 commit（一个工作包一个 commit）
```

③ 的每个方法都要单独过一遍现有测试（`coverage-offline.mjs`、`p0-chat-pending-test.mjs`、`message-id-test.mjs`、`prompt-anchor-test.mjs` 等）。

---

## 九、需要机主确认的 5 个点

| # | 问题 | 我的建议 | 不确认的后果 |
|---|---|---|---|
| **1** | 同 mid 判重的 **ts 窗口** | **±10 分钟**：同 mid 且 ts 差 ≤10 分钟 → 判重复；>10 分钟 → 视为新消息追加 | 若 OneBot 重连后 mid 复用，会误吞新消息（静默丢弃） |
| **2** | sender 里 `appendSelf` 失败怎么处理 | **warn 日志 + emit 事件，不把"记录失败"当"发送失败"** | 已发出的消息被判 failed，模型可能重发 |
| **3** | silence-ping 本期迁移 | **是**（约 20 行；它 `enabled:false`，无线上风险） | 启用后旁路写仍是旧的"读旧覆盖"bug |
| **4** | `routes.js:2859` test-send 补 mid | **是**：`store.appendSelf(chatKey, { text, ts, mid: data?.message_id ?? null })` | 面板发的消息永远无法幂等去重 |
| **5** | 锁等待预算 2 秒 + 读路径 mtime 校验 | **都纳入** | 30 秒主线程冻结；UI 显示已删消息 |

---

## 十、这次没验证的（如实记录）

| # | 未验证 | 影响 |
|---|---|---|
| 1 | OneBot 重连后 `message_id` 是否复用 | 决定第九节第 1 点的窗口取值 |
| 2 | 2 秒预算在 10 万条（约 25 MB）会话下的表现 | 当前只有 6383 条，实测 12–15 ms；文件越大越慢，届时需重新评估 |
| 3 | Electron 打包后 asar 环境下 store 的写路径 | data 在用户目录（`QQ_AGENT_DATA_DIR`），不写 asar，理论上无影响；未实测 |
| 4 | 两个真实 Electron 进程同时抢锁的极端表现 | 机主禁止起第二个真实机器人，只做子进程模拟 |

**这次调查只做了只读验证**：读代码、读配置、读数据、跑了一次只读的 parse/stringify 计时。没有改任何代码，没有写任何 data/ 文件。

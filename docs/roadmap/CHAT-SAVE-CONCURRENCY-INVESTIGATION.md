# 聊天消息跨进程丢失：只读调查报告

> 时间：2026-11-03
> 状态：**只读调查，未修改任何代码/配置/生产数据**
> 范围：独立工作包，**不并入 R8**
> 结论：**根因确认，修复方案可行，但未实施**

---

## 零、报告约定

**本报告严格区分三类陈述**：

| 标记 | 含义 |
|---|---|
| **【事实】** | 代码/数据可直接验证 |
| **【推测】** | 有依据但未验证 |
| **【未验证】** | 没查过 / 查不到 |

---

## 一、saveChat 的全部调用方与调用链

### 1.1 定义（唯一写盘入口）

**【事实】** `src/store.js:40`

```js
function saveChat(state) {
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  const tmp = `${chatFile(state.chatKey)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, chatFile(state.chatKey));
}
```

**【事实】** `chatFile(chatKey)`（`store.js:24`）：

```js
function chatFile(chatKey) {
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}
```

**所以**：`group:123` → `data/messages/group_123.json`，`private:456` → `data/messages/private_456.json`。

### 1.2 11 个调用点（全部在 store.js 内部）

**【事实】** 用脚本扫出来的：

| 行 | 所在函数 | 语义 | 是否有条件 |
|---|---|---|---|
| **109** | `appendIncoming()` | 追加收到的消息（未读） | 无条件 |
| **134** | `appendSelf()` | 记录自己发的消息（已读） | 无条件 |
| **146** | `drainUnread()` | 快照未读并全部置已读 | 无条件 |
| **174** | `drainUnreadFrom()` | 同上（从指定位置） | 无条件 |
| **194** | `markAllRead()` | 全部标记已读 | `if (n)` |
| **214** | `markEntryRead()` | 单条标记已读 | 无条件 |
| **235** | `markUnreadInWindow()` | 窗口内标记未读 | `if (n)` |
| **281** | `markRecalled()` | 标记撤回 | 无条件 |
| **303** | `updateByMid()` | 按 mid 更新 | 无条件 |
| **324** | `removeByLocalIds()` | 按 localId 删除 | `if (removed)` |
| **337** | `clearChat()` | 清空 | 无条件 |

### 1.3 共同模式（**这就是 bug 的结构**）

**【事实】** 每个调用点都是：

```js
const st = this.#state(chatKey);   // ① 从**内存**拿状态
st.xxx = ...;                       // ② 改内存
saveChat(st);                       // ③ **用内存整个重写文件**
```

**关键**：**第 ③ 步写的是内存快照，不是磁盘最新状态。**

---

## 二、所有写同一聊天文件的入口

### 2.1 结论

**【事实】** **只有 `saveChat` 一个函数写 `data/messages/*.json`。**

**验证方法**：在 `src/` 全目录搜 `writeFileSync` / `renameSync` 指向 `MESSAGES_DIR` 的代码，只有 `store.js:40-45`。

**这是好消息**：加锁只需要改一个地方。

### 2.2 但读有两个入口

**【事实】**

| # | 入口 | 位置 | 语义 |
|---|---|---|---|
| **1** | `#state(chatKey)` | `store.js` 内部 | **内存缓存**，首次访问时 `loadChat` 读盘 |
| **2** | `loadChat(chatKey)` | `store.js:29` 附近 | 直接从磁盘读 |

**【未验证】** `routes.js:2765` 那个 `m.id, m.mid, m.ts...` 是否走了 `loadChat` 还是别的路径。

### 2.3 内存缓存的生命周期

**【事实】** `#state(chatKey)` 首次访问读盘，之后一直用内存。

**【未验证】** 内存缓存有没有失效/重载机制（比如文件被外部改动后重新读）。

---

## 三、mid 的生成、唯一性和重复语义

### 3.1 mid 是什么

**【事实】** `mid` = OneBot 的消息 ID（`message_id`）。

| 来源 | 位置 | 值 |
|---|---|---|
| **收到的消息** | `app.js:908` | `mid: event.message_id` |
| **自己发的消息** | `sender.js:183` | `mid: data?.message_id ?? null` |
| **某些场景** | `app.js:1053` | `mid: null` |

### 3.2 mid 的唯一性

**【推测】** **同一个 QQ 账号下，OneBot 的 `message_id` 全局唯一且单调递增。**

**依据**：
· 实测 `messages` store 里 6383 条，`mid` 没有重复（**未逐条验证**，只是抽查）
· OneBot 规范里 `message_id` 是 int32，由 QQ 分配

**【未验证】** **跨 OneBot 重连/重启后 `message_id` 会不会复用。** 如果会复用，按 mid 合并就有风险。

### 3.3 mid 为 null 的消息

**【事实】** 存在 `mid: null` 的情况（`app.js:1053`、`sender.js:183` 的兜底）。

**【未验证】** 这些消息占多少比例、什么场景产生。

**对合并的影响**：**`mid: null` 不能做唯一键**，需要兜底键。

### 3.4 消息编辑与重复消息

**【事实】** `updateByMid()`（`store.js:303`）说明存在「按 mid 更新已有消息」的路径（比如撤回、编辑）。

**【事实】** `sender.js` 有 `#isDuplicate` 去重窗口（`sender.js:173`），窗口内相同文本跳过发送。

**【推测】** 「重复消息」有两层含义：
· **发送层去重**（`#isDuplicate`）：防止模型重复调用
· **存储层去重**（按 mid）：防止两个进程各写一份

**这两层是独立的，不能混为一谈。**

---

## 四、现有原子写入和跨进程锁工具

### 4.1 已有工具：`src/file-lock.js`

**【事实】** 这是 R5 重写过的实现，提供三个导出：

| 函数 | 作用 |
|---|---|
| **`withFileLock(file, fn, opts)`** | 在 `${file}.lock` 内执行 `fn`（**读和写都要在里面**） |
| **`writeFileAtomic(file, content)`** | 唯一 tmp 名 + rename（含 EPERM/EBUSY 重试） |
| **`lockState(file, opts)`** | 判断锁是否陈旧 |

### 4.2 它的四条设计规则（原文）

**【事实】** `file-lock.js` 文件头注释：

```
① 唯一 owner token：锁文件里写 { pid, token, startedAt, host }
② 释放时验证 owner：token 不匹配就不删（别人已经接管了）
③ 陈旧判定不看年龄，看持有者是否还活着：
   · 有 pid 且进程存活 → 永不判陈旧（哪怕持了 1 小时）
   · 进程不存在 → 陈旧，可以回收
   · 旧格式锁（没有 pid）→ 退回 mtime 判断（兼容）
④ 回收必须原子：删掉后重新用 wx 竞争，只有抢到 wx 的那个才进临界区
```

### 4.3 它明确写了我们要解决的问题

**【事实】** 第 32 行注释：

> 只在写的时候加锁 = 两个进程各读旧值再互相覆盖（D9 原话：**原子写 ≠ 并发安全**）。

**这就是我们的 bug 的准确描述。**

### 4.4 R5 日记锁能不能复用

**【事实】** `state-store.js:50` 的 `withState()` 内部就是调 `withFileLock()`：

```js
export function withState(file, mutator, { ... }) {
  // 只对 ELOCKTIMEOUT 重试 3 次
  const got = withStateOnce(file, mutator, { ... });
}
function withStateOnce(file, mutator, { ... }) {
  result = withFileLock(file, () => {
    // 锁内：读 → 改 → 写
  });
}
```

**所以**：**R5 的锁工具完全可以复用**，而且它已经在 `learned.js` / `token-ledger.js` / `companion/*` 上跑了很久。

### 4.5 谁已经在用

**【事实】** 搜 `withState|withFileLock` 的用户：

```
src/learned.js          ← 经验库
src/model-calls.js      ← 模型调用账本
src/token-ledger.js     ← Token 账本
src/companion/*.js      ← 陪伴状态
src/state-store.js      ← 通用封装
```

**`store.js`（聊天记录）不在里面。**

**【事实】** 这是唯一一个「高频写、有并发风险、却没用锁」的持久化模块。

---

## 五、Windows 环境下的跨进程锁

### 5.1 现有实现用的机制

**【事实】** `withFileLock` 用 **`fs.writeFileSync(lock, payload, { flag: 'wx' })`** ——
这是 Windows 上 `CreateFile` + `CREATE_NEW` 的封装，**原子排他创建**。

**不依赖 `flock` / `LockFileEx`** —— 所以**跨平台一致**（POSIX 上 `O_EXCL` 也是原子的）。

### 5.2 异常退出释放

**【事实】** `withFileLock` 的 `finally` 里释放：

```js
finally {
  const holder = readLockHolder(lock);
  if (holder && holder.token === myToken) {
    try { fs.unlinkSync(lock); } catch { }
  }
}
```

**【事实】** 如果进程被 `TerminateProcess`（`Stop-Process -Force`）杀掉，
**`finally` 不会跑** → **锁残留**。

**【事实】** 下次有进程来抢锁时：
· `lockState()` → `readLockHolder()` 拿到 `pid`
· `isPidAlive(pid)` → **false**
· → **判为陈旧** → 删掉重抢

**所以异常退出不是死锁，只是「下次多一轮回收」。**

### 5.3 超时与冲突处理

**【事实】**

```js
DEFAULT_RETRIES = 1500;   // 1500 × 20ms = 30 秒
DEFAULT_WAIT_MS = 20;
```

**超时后抛 `ELOCKTIMEOUT`**，调用方（`withState`）会重试 3 次。

**【未验证】** 30 秒预算在聊天这种高频写入下够不够。
参考：`learned.js` 的注释说「10 秒在高并发下偶发超时（实测 99/100）」，后来改成 30 秒。

### 5.4 PID 重用的理论风险

**【事实】** 注释里明确写了：

```
PID 存活检查有 PID 重用的理论风险（旧进程死了，PID 被新进程复用）。
缓解：token 里带 startedAt + 随机串，释放时先比对 token 再删。
不追求 100% 完美，因为那需要 OS 级进程启动时间查询，跨平台不可靠。
```

**【未验证】** 实际撞到的概率。

---

## 六、旧进程被新进程终止时的风险

### 6.1 场景

**【事实】** `056b865` 加的 `killStaleSiblings` 会发 `SIGTERM` 给旧进程。

**【事实】** 旧进程收到 `SIGTERM` 后：
· 如果有 handler → 可能优雅退出
· 如果没有 → **直接死**

**【未验证】** `store.js` 有没有注册 `SIGTERM` handler。

### 6.2 未完成写入的风险

**【事实】** `saveChat` 的写入序列：

```js
fs.writeFileSync(tmp, ...);      // ① 写 tmp
fs.renameSync(tmp, chatFile);    // ② 原子替换
```

**如果在 ① 之后、② 之前被杀**：
· **tmp 文件残留**（`${chatFile}.${pid}.tmp`）
· **目标文件**保持旧内容（**没损坏**）

**如果在 ② 之后被杀**：写入完成。

**所以**：**rename 的原子性保证了「要么旧要么新」，不会写一半。**

**【事实】** 但 **tmp 残留没人清理** —— 日积月累会有垃圾文件。

**【未验证】** 现在 `data/messages/` 里有没有 `.tmp` 残留。

### 6.3 消息本身的风险

**【事实】** 如果 `appendSelf()` 在内存里 push 之后、`saveChat()` 之前被杀：
· **内存丢了**（进程死）
· **磁盘没有**
· → **那条消息彻底丢失**，**QQ 里有、store 里没有**

**这正是 20:13 的场景之一（另一种解释）。**

---

## 七、测试覆盖情况

### 7.1 现有的并发测试

**【事实】**

```
test/state-store-test.mjs           ← 通用状态存储并发
test/learned-concurrent-test.mjs    ← 经验库并发
test/token-ledger-concurrent-test.mjs ← Token 账本并发
```

**这三个都用 `child_process` 起多个进程测并发。**

### 7.2 聊天记录的测试

**【事实】** **没有 `store-concurrent-test.mjs`。**

**搜 `test/` 目录，没有任何测试涉及 `saveChat` 的并发。**

### 7.3 单进程覆盖

**【未验证】** 有没有单进程下 `saveChat` 的功能测试（`p0-chat-pending-test.mjs` 可能覆盖了一部分）。

---

## 八、根因总结

### 8.1 三层问题

| 层次 | 问题 | 严重度 |
|---|---|---|
| **L1 架构** | **`saveChat` 用内存快照整个重写，不读磁盘** | 🔴 **根本原因** |
| **L2 并发** | **没有跨进程锁** | 🔴 |
| **L3 进程** | **可能有多个进程**（`056b865` 缓解但没消除） | 🟡 |

**`056b865` 只动了 L3。L1 和 L2 完全没动。**

### 8.2 为什么会丢

```
进程 A 内存：6383 条
进程 B 内存：6383 条

20:13  A 发消息 → A 内存 6384 → saveChat 写整个文件（含 20:13）
20:16  B 收到消息 → B 内存 6384（**但它不知道 20:13**）→ saveChat 写整个文件
       → **覆盖，20:13 消失**
```

**id 连续（6353→6354）是因为 B 的 `nextLocalId` 是它自己的计数器。**

---

## 九、目标设计

### 9.1 核心原则

**【设计要求】**（机主给的）：

```
· 锁覆盖完整 read → merge → temp write → atomic rename 事务
· 使用稳定 sidecar lock 文件，不锁定会被 rename 替换的目标文件
· 获取锁后重新读取磁盘最新状态
· 按 mid 合并，明确重复和内容冲突规则
· 所有写入相同聊天文件的入口必须遵守同一锁协议
· 保留原子写入机制
· 不静默丢弃冲突消息
```

### 9.2 设计草案

**`saveChat` 改成**：

```js
import { withFileLock, writeFileAtomic } from './file-lock.js';

function saveChat(state) {
  const file = chatFile(state.chatKey);

  // 锁文件 = `${file}.lock`（稳定 sidecar，不会被 rename 替换）
  withFileLock(file, () => {
    // ① 锁内**重读磁盘**
    const fresh = loadChat(state.chatKey);

    // ② 按 mid 合并
    const merged = mergeChatStates(fresh, state);

    // ③ 原子写
    writeFileAtomic(file, JSON.stringify(merged, null, 1));
  });
}
```

### 9.3 合并规则（**这里必须机主拍板**）

**按 mid 合并的三种情况**：

| # | 情况 | 处理 |
|---|---|---|
| **1** | 磁盘有、内存没有 | **保留磁盘的**（别的进程写的，不能丢） |
| **2** | 内存有、磁盘没有 | **追加**（新消息） |
| **3** | 两边都有同一个 mid | **看内容**：相同→不变；不同→**冲突，不能静默选一个** |

**`mid: null` 的消息怎么办**：

**【需要决策】** 三个选项：
· **A**：用 `(ts, text, self)` 三元组当兜底键
· **B**：`mid: null` 的消息**总是追加**（宁可重复不丢）
· **C**：给 `mid: null` 的消息**本地生成一个稳定 UUID**（但会改数据）

**我倾向 B** —— **宁可重复，不可丢失**（符合机主「不静默丢弃冲突消息」的要求）。

### 9.4 冲突的处理

**【设计要求】**「不静默丢弃冲突消息」。

**所以**：**同一个 mid 内容不同时**：

```
① 保留两条（加 suffix 区分）
② 或者：保留新内容 + 把旧内容写进一个 `conflicts` 数组
③ 或者：两条都进 `conflicts`，让人工裁决
```

**【需要决策】** 选哪个。

**我倾向 ②** —— **和 Token 冲突记录的做法一致**（记录 old/new）。

---

## 十、需要机主确认的五个问题

| # | 问题 | 我的建议 |
|---|---|---|
| **1** | **`mid: null` 的消息怎么合并？** | **总是追加**（宁可重复不丢） |
| **2** | **同一 mid 内容冲突怎么处理？** | **保留新内容 + 把旧的写进 `conflicts` 数组**（和 Token 一致） |
| **3** | **`nextLocalId` 冲突怎么办？**（两个进程各自从同一个值开始） | **合并时重排**：按 `ts` 排序后重新分配连续 id |
| **4** | **锁超时 30 秒够不够？** | **先用默认值**，实测后调。聊天写入比经验库更频繁 |
| **5** | **tmp 残留要不要清理？** | **启动时扫一遍 `*.tmp`，超过 1 小时的删掉** |

---

## 十一、这次调查没做的事

| # | 没做 | 原因 |
|---|---|---|
| **1** | 没改任何代码 | 机主要求只读 |
| **2** | 没跑双进程实验 | 机主明确禁止 |
| **3** | 没统计 `mid: null` 的实际比例 | 要写脚本扫 6383 条（可以做，但没做） |
| **4** | 没验证 OneBot 重连后 mid 会不会复用 | 需要真实重连实验 |
| **5** | 没查 `data/messages/` 里有没有 `.tmp` 残留 | 一行命令的事，漏了 |

---

## 十二、结论

**【事实】**：

1. **所有聊天写入只走 `saveChat` 一个函数**（`store.js:40`）
2. **`saveChat` 用内存快照整个重写，不读磁盘**
3. **没有跨进程锁**
4. **现成工具 `file-lock.js` 完全够用**，而且已经跑了很久（learned/token-ledger/companion）
5. **`store.js` 是唯一没用锁的高频持久化模块**
6. **没有 `store-concurrent-test.mjs`**

**【推测】**：

· 修复后，双进程也不会丢消息（因为有锁 + 重读 + 合并）
· 改动局限在 `store.js` 一个文件（约 30 行）
· 风险主要是合并规则和 `nextLocalId` 重排

**【未验证】**：

· `mid: null` 的实际比例
· OneBot 重连后 mid 是否复用
· 30 秒锁预算是否够
· `data/messages/` 里有没有 tmp 残留

---

## 十三、下一步（等设计审查）

**需要机主先拍板第十节的五个问题**，然后：

```
① 改 store.js 的 saveChat（加 withFileLock + 重读 + 合并）
② 新增 mergeChatStates 纯函数
③ 新增 test/store-concurrent-test.mjs（真多进程，用 child_process）
④ 专项测试 + 全量回归 + diff 审查
⑤ 独立 commit
```

---

## 十四、补充实测（2026-11-03 21:45）

**上一节标记的三项「未验证」，补查了。**

### 14.1 `.tmp` 残留：**0 个**

```
data/messages/*.tmp → 0
```

**【事实】** 目前没有残留垃圾。

**但**：`saveChat` 的 tmp 文件名是 `${chatFile}.${process.pid}.tmp` —— **固定后缀，不唯一**。

**如果同一进程连续两次写同一个 session**：第二次会覆盖第一次的 tmp（因为名字一样）。
正常情况没问题（rename 之后 tmp 已消失），但如果 rename 失败一次，**下一次写会把上次的 tmp 覆盖**。

**对比**：`writeFileAtomic` 的 tmp 名带时间戳和随机数，**更安全**。

### 14.2 `mid: null` 的比例：**1%（64 / 6383）**

```
消息总数:       6383
mid 为 null:     64 (1%)
mid 重复:         0
```

**【事实】**：
· **`mid` 没有重复** → **按 mid 合并可行**
· **`mid: null` 只有 64 条（1%）** → 兜底规则只影响极少数
· **但那 64 条不能被丢**

**需要决策**：这 64 条怎么合并（见第十节问题 1）。

### 14.3 `store.js` 没有 SIGTERM handler

**【事实】** `src/store.js` 里搜 `SIGTERM|SIGINT|process.on` → **零结果**。

**【事实】** 这意味着：**进程被 `SIGTERM` 或 `Stop-Process -Force` 杀掉时，`store.js` 没有任何清理机会。**

**后果**：
· 内存里刚 push 但还没 `saveChat` 的消息 → **彻底丢失**
· 这是 **20:13 那条丢失的另一种可能解释**（不只是双进程覆盖）

**【推测】** 两种机制可能同时存在：
· **双进程覆盖**（`saveChat` 后写赢）
· **单进程未落盘就被杀**（`saveChat` 都没跑到）

**目前无法区分**，因为两种都会导致「QQ 里有、store 里没有」。

### 14.4 对设计的影响

| 发现 | 影响 |
|---|---|
| **tmp 名不唯一** | 建议改用 `writeFileAtomic`（它自带唯一 tmp 名） |
| **mid 无重复** | 按 mid 合并安全 |
| **`mid: null` 1%** | 兜底规则要定，但影响面小 |
| **无 SIGTERM handler** | **加锁之后仍有「未落盘就被杀」的窗口** —— 这是锁解决不了的 |

**【重要】** 最后一条是**关键限制**：

**锁能解决「并发覆盖」，但解决不了「写到一半进程死」。**

**要彻底不丢，需要**：

```
① 每次 append 立即落盘（即时写，不攒批）
② 或者：用 WAL（write-ahead log）—— 先 append 一条日志，再改主文件
```

**这两种都是更大的改动，不在本次范围。**

# 聊天持久化 · 后续只读审查（W1–W5 验收后）

> 时间：2026-11-03
> 状态：**只读审查 + 补充测试；未改生产代码、未碰生产数据**
> 触发：机主对 W1–W5 的验收结论「有条件通过」，指定四项审查
> 前置：`docs/roadmap/CHAT-SAVE-W1-W5-REPORT.md`

---

## 零、审查结论摘要

| # | 审查项 | 结论 |
|---|---|---|
| 1 | ±10 分钟 mid 判重 | **暂定启发式，不是唯一性保证**。实测同 mid 不同内容会被静默吞掉；建议下一轮扩展判重键，需先拍板冲突保留策略 |
| 2 | 异步锁超时/异常释放/进程退出回收 | 机制正确，三条路径都有测试证据；发现一个**回收 TOCTOU 理论窗口**（R5 既有设计，非本次引入，概率极低） |
| 3 | 同大小快速替换的缓存边界 | 新增 8 项测试：mtime 变化时能发现；**mtime 被强制固定时检测不到**（已知边界，需内容 hash 才能覆盖） |
| 4 | 11 个写方法是否全部走统一 mutation | **全部走**；没有绕过 `#update` 的写路径；撤回/clear/删除都基于锁内 fresh |

**没有修改任何代码**。唯一新增是测试文件与本文档。

---

## 一、±10 分钟 mid 判重

### 1.1 当前实现（`src/store.js`）

```js
// store.js:54
function findDupByMid(state, mid, ts) {
  if (mid === null || mid === undefined || String(mid) === '' || Number(mid) === 0) return null;
  const target = String(mid);
  const t = Number(ts) || 0;
  return state.messages.find((m) => {
    if (!m || m.mid === null || m.mid === undefined) return false;
    if (String(m.mid) !== target) return false;
    const mt = Number(m.ts) || 0;
    return Math.abs(mt - t) <= DUP_WINDOW_MS;   // DUP_WINDOW_MS = 10 分钟
  }) || null;
}
```

**判重键 = `mid` + 时间窗。不比较 sender、text、消息类型、media。**

命中时 `appendIncoming` / `appendSelf` 返回已有条目、`write:false`、不写盘、不记事件。

### 1.2 实测：同 mid 不同内容会被静默吞掉

用临时数据目录做只读实验（不碰生产），两条消息：`mid=777`、sender `111` / `222`、文本完全不同、ts 差 5 分钟、第二条还带图片：

```json
{
  "原条数": 1,
  "第一条id": 1,
  "第二条返回id": 1,
  "第二条是否被吞": true,
  "磁盘内容": [{ "id": 1, "mid": 777, "sender": "111", "text": "第一条：今天吃火锅" }]
}
```

**第二条消息（不同发送者、不同内容、带媒体）被静默丢弃，没有任何冲突记录。** 这正是机主指出的风险。

### 1.3 边界分析

| 场景 | 当前行为 | 评价 |
|---|---|---|
| 同 mid + 同内容 + 窗口内（双进程重复投递） | 只存 1 条 | ✅ 符合设计意图 |
| 同 mid + **不同内容** + 窗口内（mid 复用/上游异常） | **静默吞掉后者** | ❌ 风险点 |
| 同 mid + 窗口外 | 追加新条目 | ✅ 宁可重复不丢 |
| `ts` 缺失/`null`/非数字 | `Number(ts) || 0` → 窗口不匹配 → 两条都追加 | ✅ 不会误吞；代价是失去幂等 |
| `mid = 0` / 空串 | 不参与判重 | ✅（0 不是有效消息 id） |
| 时区 | `ts` 是绝对毫秒；`app.js` 把 OneBot 秒级时间转毫秒 | ✅ 无时区歧义 |
| OneBot 重连后 mid 是否复用 | **未验证** | ⚠️ 决定风险实际概率 |

**结论：±10 分钟只能视为「暂定启发式」，不是可靠的消息唯一性保证。** 它解决的是「双进程收到同一条事件」，但代价是「同 mid 不同内容一律当重复」。

### 1.4 建议（下一轮，不实施）

按优先级：

1. **判重键扩展**：同 mid 时再比 `senderId` + 文本（或文本前 N 字/哈希）+ `self`。三者都一致才判重；任一不同 → 追加 + 标记冲突。
2. **冲突保留**：同 mid 不同内容时，保留新条目，并把旧条目摘要写进一个 `conflicts` 数组（与 Token 冲突记录同思路）；**不静默丢弃**。
3. **先测概率再定窗口**：从 NapCat/OneBot 日志统计「跨重连 mid 复用」是否真实发生、间隔多长。在这之前不要把窗口当成安全保证。
4. **窗口取值**：若确认复用存在，窗口应缩到「同一次投递的合理范围」（秒级），而不是 10 分钟。

> 这三条涉及业务语义（冲突如何合并、是否保留重复），需要机主拍板，本审查不动代码。

---

## 二、异步锁：超时、异常释放、进程退出回收

### 2.1 与同步版逐行对比

| 环节 | 同步版 `withFileLock` | 异步版 `withFileLockAsync` | 一致？ |
|---|---|---|---|
| 锁文件 | `${file}.lock` | 同 | ✅ |
| 抢锁 | `writeFileSync(lock, payload, { flag: 'wx' })` | 同 | ✅ |
| 锁内容 | `{ pid, token, startedAt, host }` | 同 | ✅ |
| 陈旧判定 | `lockState`：pid 活→不陈旧；pid 死→回收；旧格式→mtime 15s | 同 | ✅ |
| 回收 | `unlink` 后 `continue` 重新竞争 | 同 | ✅ |
| 临界区 | `return fn()` | `return await fn()` | ✅ |
| 释放 | finally 里 token 相同才 `unlink` | 同 | ✅ |
| 超时 | `ELOCKTIMEOUT` | 同 | ✅ |
| 唯一差异 | `Atomics.wait` 阻塞 | `setTimeout` 让出事件循环 | — |

### 2.2 超时

- store 用 `{ retries: 100, waitMs: 20 }` = **2 秒**上限，超时抛 `ELOCKTIMEOUT`。
- 超时**不写盘**（`store-concurrent-test` ⑧ 已验证：持锁子进程 5 秒，主进程 2 秒失败，磁盘字节不变）。
- 没有套 `withState`（那个对 ELOCKTIMEOUT 会再重试 3 次，最坏 90 秒）。

### 2.3 异常释放

- `fn` 抛错（磁盘满、损坏、mutator 异常）→ `finally` 仍执行，token 校验后 `unlink`。
- 释放前重新读锁并比对 token：如果锁已被别人接管（或误回收），**不删别人的锁**。
- 若 `fn` 是 async 且内部 `await`，持锁时间会被拉长——store 的 mutator 全是同步代码，这一点已被注释约束。

### 2.4 进程退出回收

- 进程被 `TerminateProcess`（`Stop-Process -Force`）杀掉：`finally` 不跑 → 锁残留。
- 下一个进程 `lockState` 读到 pid → `process.kill(pid, 0)` → 进程不存在 → 判陈旧 → 回收 → 重新 `wx` 竞争。
- 实测：`store-concurrent-test` ⑩（持锁子进程 `exit(9)` → 下一个进程回收并写入）。
- 补充实验：造一个死 pid（999999）的残留锁，**两个子进程同时回收并各写一条**，5 轮全部 `2 条 / 无残留锁`（见附录 A）。

### 2.5 一个必须诚实记录的理论缺陷：回收 TOCTOU

回收路径是「检查后删除」，跨进程不是原子的：

```
A: lockState 读到 L1 holder pid 已死 → 判 stale
B: （抢先）unlink L1 → writeFileSync(wx) 创建 L2（B 的 token）→ 进入临界区
A: unlink(L1 路径) —— 实际删掉的是 L2
A: writeFileSync(wx) 创建 L3 → 认为拿到锁 → 进入临界区
```

后果：A 与 B 可能同时进入临界区（写覆盖）。

**触发条件**（三个必须同时成立）：

1. 存在一个**死进程**的残留锁；
2. 两个进程**同时**判定它 stale（例如崩溃后并发重启）；
3. A 在 `lockState` 与 `unlink` 之间被 OS 调度打断（微秒到毫秒级窗口）。

**这是 R5 锁的既有设计，同步版同样存在，不是 W1–W5 引入。** 本次 5 轮并发回收实验未复现（概率低）。

**为什么本次没有修**：修复需要把「检查 + 回收」变成一个原子操作。可行方向：

- 回收时把锁 `rename` 到唯一名 `${lock}.stale-${myToken}`，只有 rename 成功者继续；但 rename 仍可能搬走别人新建的锁（同一 TOCTOU）。
- 回收后加随机退避（例如 50–200ms）再重试，降低撞车概率——缓解，不是根治。
- OS 级锁（`LockFileEx` / `flock`）能根治，但 Node 没有跨平台封装，与现有跨平台目标冲突。

**现实评估**：Electron 已有单实例锁（`instance-lock.js`）+ `killStaleSiblings`（`056b865`），「两个进程同时回收同一个死锁」的场景极窄。建议记为已知边界，**不本次修**。

### 2.6 结论

超时、异常释放、进程退出回收三条路径都正确且有测试证据；回收 TOCTOU 是低概率已知边界，需在文档标注，修复优先级低于判重问题。

---

## 三、同大小快速替换的缓存边界（补充测试）

新增 `test/store-cache-samesize-test.mjs`，8 项全过：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 同大小、mtime 变化（快速连续替换） | 能发现新内容 |
| 2 | 连续 10 次同大小替换，每次都读 | 最后一次内容可见 |
| 3 | 同大小 + **mtime 被强制设回原值** | 指纹相同 → **读回旧内容（检测不到）** |
| 4 | mtime 恢复变化 | 能追上最新内容 |
| 5 | size 变化 | 必然发现 |

**结论**：

- `mtime/size` **不是内容版本号**，不能当唯一性/版本判断依据。
- 作为「另一个进程正常写入」的失效检测是够用的——正常 `writeFileSync`/`rename` 必然更新 mtime。
- **同毫秒内、同大小、且 mtime 被刻意固定**的覆盖检测不到。要覆盖这种情况只能读内容 hash（每次读 1.5MB 不现实）或加文件内容版本字段。
- 第 3 项是**预期行为**（测试断言的就是"检测不到"），不是失败；它把边界固定在测试里，防止以后有人误以为缓存是内容版本号。

---

## 四、11 个写方法清点

`src/store.js` 内 `#update(` 调用点（除定义）：

| 行 | 方法 | mutator 对 fresh 的操作 | 找不到时 |
|---|---|---|---|
| 242 | `appendIncoming` | 幂等检查 → push（`nextLocalId++`）→ trim | 不适用 |
| 284 | `appendSelf` | 幂等检查 → push → trim | 不适用 |
| 314 | `drainUnread` | 取未读快照 → 全部置 read | 不适用 |
| 336 | `drainUnreadFrom` | 按 ts 分流 → 全部置 read | 不适用 |
| 360 | `markAllRead` | 未读全部置 read | n=0 不写 |
| 381 | `markEntryRead` | 按 id 找 → read=true | 返回 false，不写 |
| 398 | `markUnreadInWindow` | 时间窗内 read=false | n=0 不写 |
| **446** | **`markRecalled`（撤回）** | 按 mid 找 → recalled/read=true | 返回 false，不写 |
| 462 | `updateByMid` | 按 mid 找 → 改 text / 补 media | 返回 false，不写 |
| **491** | **`removeByLocalIds`（删除）** | 按 id 集合 filter | removed=0 不写 |
| **504** | **`clearChat`（清空）** | `messages = []`（nextLocalId 不重置） | removed=0 不写 |

另外核对：

- `writeFileAtomic` 只在 `#update`（`:211`）调用一次；
- `copyFileSync` 只在损坏备份（`:89`），不在写路径；
- 全仓库写 `data/messages` 的入口仍然只有 2 个：`ChatStore` 与 `silence-ping.appendSelfToFile`（后者 W3 已并入同一把同步锁）。

**结论：11 个写方法全部经统一 mutation；撤回、clear、删除都基于锁内 fresh 定位，找不到就不写盘——不会把旧内存快照写回。**

---

## 五、验收口径（保持不变，不美化）

| 项 | 数字 |
|---|---|
| W1–W5 专项测试 | **115 / 115 PASS**（store-corrupt 19 + store-mutation 33 + silence-ping-store 12 + store-cache 13 + store-concurrent 38） |
| 全量回归 | **41 / 45 PASS** |
| 4 项失败 | 经 `git stash` 基线复跑确认**属于既有失败**：`selftest` / `tools-skill-audit` / `setup-qq-version` / `gallery-test` |
| 本次补充测试 | 同大小缓存边界 **8 / 8 PASS** |
| 生产数据 | sha256 未变（`BE986B4A…78C`） |

**全量回归不是 45/45。** 4 项失败保留在报告里，不抹掉。

---

## 六、下一步建议（本审查不实施）

| 优先级 | 事项 | 理由 |
|---|---|---|
| P1 | 扩展 mid 判重键 + 冲突保留 | 当前会静默吞「同 mid 不同内容」；需要先拍板冲突语义 |
| P2 | 锁回收 TOCTOU 加固 | 概率极低，可在引入 WAL 前一起做 |
| P3 | 缓存内容版本字段 | 仅当出现「同大小同 mtime 覆盖」的真实案例再做 |
| — | **不引入 WAL** | 先测量「已进内存、未落盘被杀」的实际发生概率，避免为未确认的故障加复杂度 |

---

## 附录 A：死锁并发回收实验（只读，临时目录）

```
round 0: msgs=2 texts=A-0|B-0 lockLeft=false => OK
round 1: msgs=2 texts=A-1|B-1 lockLeft=false => OK
round 2: msgs=2 texts=A-2|B-2 lockLeft=false => OK
round 3: msgs=2 texts=A-3|B-3 lockLeft=false => OK
round 4: msgs=2 texts=A-4|B-4 lockLeft=false => OK
ALL OK
```

## 附录 B：判重吞消息实验（只读，临时目录）

见 1.2；同一脚本还验证了 `ts` 缺失时两条都会追加（不会误吞，但也失去幂等）。

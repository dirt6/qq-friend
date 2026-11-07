# P1 + P2 实施报告

> 时间：2026-11-03
> 授权：机主「P1 + P2 连续实施授权」
> 依据：`docs/roadmap/CHAT-SAVE-FOLLOWUP-AUDIT.md`（`81dc5a0`）
> 前置：W1–W5 已完成（`aaae63e` … `e4fcc68`）

---

## 零、结论（先看这里）

| 工作包 | 结论 | 说明 |
|---|---|---|
| **P1 消息判重修复** | **PASS** | 判重改为内容+身份匹配；冲突两条都保留；23 项专项全过 |
| **P2 异步锁陈旧锁回收加固** | **INCONCLUSIVE（暂停）** | 无法在纯 Node + 文件系统下证明「检查后回收」安全；按授权停止，**未改 `file-lock.js`** |
| 全量回归 | 见第四节 | 基线 41/45 保留；本轮 47 项 |
| 生产聊天数据 | 未变 | sha256 `BE986B4A…78C` |

**P2 没有实施任何修改。** 下面第二节给出研究过程与反例证据。

---

## 一、P1：判重修复

### 1.1 机主 8 条要求逐条对应

| # | 要求 | 实现 |
|---|---|---|
| 1 | 移除仅依赖 ±10 分钟时间窗的判重 | 主判据改为「mid + senderId + self + 完整内容」；时间窗降为 2 分钟**辅助**保护 |
| 2 | 同 mid、senderId、self、完整内容一致 → 幂等跳过 | `classifyDuplicate()` 返回 `identical` 时 `write:false`，返回已有条目 |
| 3 | 同 mid 但身份/内容不同 → 保留两条 + 冲突关联 | 正常 push 新条目（新 id），并写 `conflicts[]` |
| 4 | null mid 永不参与 mid 判重 | `findMidRecords()` 对 null/0/空串直接返回空 |
| 5 | 完整比较消息段（含图片） | 内容指纹 = `text + media + reply + isPoke` 的稳定序列化（键排序） |
| 6 | 不静默覆盖/丢弃冲突 | 冲突时两条都在；`conflicts` 记录 `existingId / incomingId / reason / 摘要` |
| 7 | 不改 localId、不全量重排 | 新条目 `nextLocalId++`；老 id 原样（测试 10 验证） |
| 8 | 冲突记录有界、容量满不丢正式消息 | `MAX_CONFLICTS = 50`，滚动 `shift` 最老；`messages` 不受影响（测试 9 验证） |

### 1.2 实现（`src/store.js`）

判重函数：

```js
function contentFingerprint(msg) {
  return stableStringify({
    text: String(msg?.text ?? ''),
    media: Array.isArray(msg?.media) ? msg.media : [],
    reply: msg?.reply ?? null,
    isPoke: Boolean(msg?.isPoke)
  });
}

function classifyDuplicate(state, incoming) {
  const records = findMidRecords(state, incoming.mid);
  if (!records.length) return null;
  const identical = records.find((m) => (
    String(m.senderId) === String(incoming.senderId) &&
    Boolean(m.self) === Boolean(incoming.self) &&
    sameContent(m, incoming) &&
    Math.abs((Number(m.ts) || 0) - (Number(incoming.ts) || 0)) <= DUP_WINDOW_MS
  ));
  if (identical) return { type: 'identical', entry: identical };
  return { type: 'conflict', entry: records[records.length - 1] };
}
```

冲突记录结构（写进会话 JSON 的 `conflicts` 字段，有界 50）：

```json
{
  "at": 1730000000000,
  "mid": 777,
  "existingId": 1,
  "incomingId": 2,
  "reason": "different-sender",
  "existing": { "senderId": "111", "self": false, "ts": 0, "text": "…", "mediaCount": 0, "mediaKinds": [] },
  "incoming": { "senderId": "222", "self": false, "ts": 0, "text": "…", "mediaCount": 1, "mediaKinds": ["image"] }
}
```

`reason` 取值：`different-self` / `different-sender` / `different-content` / `time-gap`。

### 1.3 行为对比

| 场景 | 旧（P1 前） | 新（P1 后） |
|---|---|---|
| 同 mid 同 sender 同内容，ts 差 5 秒 | 1 条 | 1 条（幂等） |
| 同 mid **不同 sender** | **静默吞第二条** | 2 条 + `different-sender` 冲突 |
| 同 mid **不同文本** | **静默吞第二条** | 2 条 + `different-content` 冲突 |
| 同 mid 同文本、图片不同 | **静默吞第二条** | 2 条 + `different-content` 冲突 |
| 同 mid 一方 self 一方 incoming | **静默吞第二条** | 2 条 + `different-self` 冲突 |
| 同 mid 同内容但 ts 差 5 分钟（重连复用） | **静默吞第二条** | 2 条 + `time-gap` 冲突 |
| null mid 连续追加 | 2 条 | 2 条（不变） |
| ts 缺失/异常 | 2 条 | 2 条 + `time-gap` 冲突 |
| 冲突记录容量 | 无 | 50 条滚动，正式消息不丢 |

### 1.4 专项测试

`test/store-dedup-test.mjs` —— **23 项全过**，覆盖机主列表的全部场景（同 mid 同内容、不同 sender、不同文本、不同图片、不同 self、null mid、ts 缺失/异常、重连复用、容量上限、id 不变、mid=0/空串）。

---

## 二、P2：为什么暂停（不是没做，是做了研究后判定不能证明安全）

### 2.1 候选方案与结论

| # | 方案 | 能否证明安全 | 结论 |
|---|---|---|---|
| 1 | 原位 `unlink`（现状，检查后删除） | ❌ 检查与删除之间路径可被替换 | 机主已禁止继续用 |
| 2 | `rename` 到唯一隔离路径再删 | ❌ 见 2.2 反例 | 不采用 |
| 3 | 目录锁 + 回收权互斥 | ❌ 回收权本身需要被回收（递归）；目录 `rename` 同 TOCTOU | 不采用 |
| 4 | **fencing token**（写路径拒绝低 fence） | ✅ 可证明（分布式系统标准做法） | 需改数据格式 + 所有写入校验，**超出本次范围** |
| 5 | **OS 级锁**（`LockFileEx` / `flock`） | ✅ 可证明 | Node 无跨平台封装，需原生依赖，与跨平台目标冲突 |

### 2.2 Windows 实测（`test/lock-reclaim-protocol-test.mjs`，11 项）

| 实验 | 结果 | 含义 |
|---|---|---|
| `rename(src, target)` 且 target 已存在 | **成功，target 被覆盖**（got=NEW） | 「认领失败再把锁搬回去」会覆盖别人刚建的新锁 |
| 两个进程同时 `rename` 同一把死锁 | **一个成功、一个 ENOENT** | rename 本身是互斥的，但只保证「搬走一次」 |
| barrier 反例：A 判死后 B 回收+建新锁，A 再 `rename` | **A 搬走的是 B 的活锁**（gotPid=B.pid, token=B-alive） | **核心反例**：判死与认领之间锁可被替换 |
| 释放时 owner token 不匹配 | **不删**（锁保留） | 现有释放逻辑正确 |
| pid 存活但 token 不符 | `lockState` 判 `holder-alive` | 宁可等待，不误删（安全方向） |

### 2.3 反例的因果链

```
A: 读锁，pid 死 → 判定 stale
B: 抢先 rename 走死锁 → wx 创建自己的新锁（B 活着）→ 进入临界区
A: rename(锁路径 → A.reclaim) —— 搬走的是 B 的新锁
A: 校验 reclaim 内容 → 发现是 B（活）→ 但锁已经从原位消失
   → 无论 A 删 reclaim、还是搬回去（Windows rename 覆盖），都会破坏 B 的互斥
```

**结论：在「检查路径 → 操作路径」的协议下，无法保证「操作的是检查时看到的那个文件」。** 纯 Node 文件系统没有「按文件身份删除/移动」的原子操作。

### 2.4 为什么不能用「加重试 / 缩短窗口」替代

机主授权里明确：不允许以增加重试或缩短时间窗口代替正确性。反例里的窗口不是概率问题，是协议本身缺少原子性——只要「判死后被重建」发生一次，互斥就破了。缩小窗口只能降低概率，不能证明安全。

### 2.5 因此的处理

- **不修改 `src/file-lock.js`**；
- 保留现有回收逻辑（R5 既有设计），并在 `CHAT-SAVE-FOLLOWUP-AUDIT.md` 里已标注为已知边界；
- 实验测试留在仓库（`test/lock-reclaim-protocol-test.mjs`），后续做 fencing token 时可作为协议验证基线。

### 2.6 如果以后要做，建议方向

| 方向 | 需要改动 | 代价 |
|---|---|---|
| **fencing token** | 锁文件加单调 `fence`；会话 JSON 加 `_fence`；所有写入校验 `myFence >= fileFence` | 改数据格式（兼容老文件）+ 改 11 个写方法；可证明 |
| OS 级锁 | 引入原生依赖（Windows `LockFileEx` / POSIX `flock`） | 失去纯 JS 跨平台；打包复杂 |
| 强化单实例 | 启动时更激进地清理僵尸进程（`killStaleSiblings` 已有） | 不解决「两进程同时回收」，只降低概率 |

**本次按授权暂停，不实施。**

---

## 三、全量回归

### 3.1 范围

基线 45 项 + 本轮新增 2 项（`store-dedup-test`、`lock-reclaim-protocol-test`）= **47 项**。逐项执行、单项失败不中断（`scripts/run-regression.ps1`）。

### 3.2 结果

**43 PASS / 4 FAIL**。

| 项 | 数量 | 明细 |
|---|---|---|
| PASS | 43 | 41 项基线通过 + 2 项新增（store-dedup、lock-reclaim-protocol） |
| FAIL | 4 | 全部为基线既有失败：`selftest` / `tools-skill-audit` / `setup-qq-version` / `gallery-test` |

### 3.3 与基线对比

| 口径 | 基线（W5） | 本轮（P1+P2） |
|---|---|---|
| 测试数 | 45 | 47 |
| 通过 | 41 | 43 |
| 失败 | 4（既有） | 4（同一批既有，未新增） |

**4 项既有失败没有因为本轮改动而变化，也没有被改写或抹掉。** 全量回归仍不是全绿。

---

## 四、验收口径（不美化）

| 项 | 数字 |
|---|---|
| W1–W5 专项（基线） | 115 / 115 PASS |
| P1 专项 | **23 / 23 PASS** |
| P2 协议实验 | **11 / 11 PASS**（通过 = 反例成立，不等于加固成功） |
| 全量回归（基线） | **41 / 45 PASS**（4 项既有失败，保留记录） |
| 全量回归（本轮） | 见第三节 |
| 生产数据 | sha256 未变 |

**P2 不判 PASS**：它是「研究 + 暂停」，不是「修复完成」。

---

## 五、分类

| 项 | 分类 |
|---|---|
| P1 判重与冲突保留 | **PASS** |
| P2 锁回收加固 | **INCONCLUSIVE（暂停，未实施）** |
| 既有 4 项回归失败 | 仍为既有失败，不因本轮改变 |
| 生产数据未被动 | PASS |

---

## 六、未解决（延续）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 锁回收 TOCTOU | 仍未修（P2 暂停）；需 fencing token 或 OS 锁 |
| 2 | 「已进内存、未落盘就被杀」 | 仍未修（WAL 边界，先测概率） |
| 3 | OneBot 重连后 mid 复用概率 | 未实测；P1 已保证「复用也不会静默丢」 |
| 4 | 缓存同大小同 mtime 覆盖 | 已知边界（需内容 hash） |

---

## 附录 A：P2 实验关键输出

```
rename 覆盖已存在目标：成功（目标=NEW）
两进程同时 rename 死锁：一个成功，一个 ENOENT
barrier 反例：
  A 判定时锁是死锁（deadAtCheck=true）
  B 成功建立新锁（pid=19032, token=B-alive）
  A 认领到的是 B 的活锁（gotPid=19032, gotToken=B-alive）
释放 token 不匹配：锁保留
```

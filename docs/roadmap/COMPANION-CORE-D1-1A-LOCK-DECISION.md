# D1-1A：MemoryStore 跨进程锁方案验证

> ⚠️ **补充验证证伪（2026-11-03）**：rename 认领存在确定的 TOCTOU（会移走其他进程新建的活锁），本方案**不满足安全要求**，D1-1B 暂停。见 COMPANION-CORE-D1-1A-RACE-FINDINGS.md。下文方案仅作记录。

> 时间：2026-11-03
> 性质：**调查 + 隔离实验**；未改 memory.js / file-lock.js / 生产配置 / 生产 data
> 实验位置：`scripts/experiments/d11a-lock/`（worker.mjs + run.mjs + result.json）
> 结论：**推荐「wx 创建 + rename 认领式回收」纯 Node 方案**，不引入 native 依赖

---

## 一、候选方案对比

| 方案 | Windows | Node/Electron 兼容 | 需编译/依赖 | 异常退出恢复 | 主要风险 | 结论 |
|---|---|---|---|---|---|---|
| **A. Windows LockFileEx（native）** | 原生 | 需 N-API addon；Electron ABI 需对应重编译 | 是（node-gyp） | OS 自动释放 ✅ | 打包/ABI/多版本 Electron 维护成本；**本机未安装、未验证** | ❌ 否决（无法只读验证，维护成本高） |
| **B. proper-lockfile（npm）** | 纯 JS（mkdir + 心跳） | 是 | 新增依赖 | 靠心跳 mtime 过期 | 过期窗口内可能双持有；需装依赖；未在本机验证 | ⚠️ 备选 |
| **C. 单写入者协调** | 是 | 是 | 无 | 不适用 | 只覆盖"同一进程内的写者"；外部脚本/旧进程仍可写；不能作为唯一保障 | ⚠️ 补充（进程内队列） |
| **D. wx 创建 + rename 认领（推荐）** | 是（已验证） | 是 | 无 | 认领式回收（已测） | 用户态锁：外部删除锁文件会失效；所有写者必须遵守 | ✅ 推荐 |
| **E. mkdir + 认领** | 是 | 是 | 无 | 同 D | 目录清理在 Windows 上同样是 rename/rmdir，等价于 D，无额外收益 | 不采用（与 D 等价） |
| **F. SQLite/WAL** | 是 | 是 | 新依赖 + 改格式 | OS 事务 | 需迁移数据格式，违反"不改格式" | ❌ 否决 |

**淘汰理由**：A 需要 native 编译与 Electron ABI 匹配（本批次不允许安装/编译，无法实测）；B 需新增依赖且有过期窗口；C 不能覆盖跨进程；F 改格式。D 是唯一可在本环境**实际验证**、零依赖、不改格式的方案。

---

## 二、隔离实验结果（本机实测，2026-11-03）

实验脚本：`node scripts/experiments/d11a-lock/run.mjs`（临时目录，纯 Node，Windows 11 / Node 24）。

| # | 实验 | 结果 | 判定 |
|---|---|---|---|
| ① | **无锁对照**：两个进程各 +50 | final = 51–53 / 100（丢 47–49） | ❌ 复现丢更新（证明实验有效） |
| ② | **wx + 认领**：两个进程各 +50 | final = 100 / 100（a/b 各 50，maxWait 189–237ms） | ✅ 不丢更新 |
| ③ | **持锁进程 SIGKILL（不 release）** → 另一进程恢复 | 锁残留 pid 已死；恢复 5/5，final = 6，maxWait 16ms | ✅ 可恢复 |
| ④ | **活进程持锁 + 等待超时** | waiter failed=1、ok=0，final 只 +1（持锁者） | ✅ 超时不写入 |
| ⑤ | **不同成员文件各自加锁** | 两个文件各 30/30，均成功 | ✅ 不互相阻塞 |
| ⑥ | **锁文件被外部删除** | 入侵进程仍进入（intruderOk=1） | ⚠️ **互斥失效**（用户态锁固有限制） |

**关键结论**：

- 无锁时丢更新**可稳定复现**（51–53/100），证明 D0 的风险不是理论。
- 认领式回收在"持锁者已死"时能恢复，且**只有 wx 成功者进入临界区**，不会双持有。
- 超时语义正确：拿不到锁就不写。
- 锁粒度按文件，不同成员文件互不阻塞（符合 MemoryStore 按成员文件存储的结构）。
- 用户态锁无法防"外部删除锁文件"——这是所有非内核锁的通病；需靠单实例守门 + 权限边界降低风险。

---

## 三、推荐方案

**wx 创建 + rename 认领式回收 + 等待超时**，实现为 MemoryStore 的写入包装：

```
进入临界区前：fs.open(`${file}.lock`, 'wx') 成功 ← 唯一进入条件
  失败 EEXIST：
    ├─ 读锁内容 {pid, at}
    ├─ 判定陈旧：pid 不活 或 at 超过 30s
    ├─ 陈旧 → fs.rename(lock, lock+'.stale.<pid>.<ts>') 认领（原子，只有一个成功）
    │        成功后 unlink 认领文件，回到循环重新 wx
    └─ 活锁 → sleep 5ms，直到超时（默认 5s）
临界区内：读写数据文件（保留 tmp+rename 原子替换）
退出：校验锁内容 pid == 自己 → unlink
```

**为什么是它**：纯 Node、零依赖、Windows 已验证、Electron 无 ABI 问题、不改变文件格式；TOCTOU 被收敛为"只有 wx 成功者进入"，陈旧回收用 rename 原子性避免 unlink 竞态。

---

## 四、已知限制（必须写进 D1-1B 设计）

1. **外部删除锁文件 = 互斥失效**（实验⑥）。缓解：单实例守门（R8-0）、锁文件权限、写者白名单；做不到绝对防护。
2. **所有写者必须遵守**：旧版本进程、外部脚本、直接 `fs.writeFileSync` 的代码不受保护。
3. **网络盘/多机不保证**（本方案只测本机）。
4. **锁文件是旁路文件**：清理 `data/memory/**/*.lock` 不影响数据，但持有期间删除会导致短暂双持有窗口。
5. **忙等轮询**（5–10ms）有少量 CPU 开销；临界区必须短（MemoryStore 写单成员文件足够短）。
6. **PID 复用**：锁内容含 `at`；陈旧判定为"pid 不活 **或** 超过 30s"，PID 复用时以 30s 上限兜底。

---

## 五、D1-1B 接入设计

1. 新增 `src/memory-lock.js`：`withMemoryLock(file, fn, { timeoutMs = 5000, staleMs = 30000 })`。
   - **不复用** `file-lock.js` 的陈旧回收（P2 TOCTOU 未修；本方案用 rename 认领而非 unlink）。
2. `memory.js` 的 `writeJson(file, value)` 改为：
   ```js
   writeJson(file, value) {
     return withMemoryLock(file, () => {
       const tmp = `${file}.${process.pid}.tmp`;
       fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
       fs.renameSync(tmp, file);
     });
   }
   ```
   - 所有写方法（`append/remove/replaceMember/markConsolidated`）都经 `writeJson`，自动覆盖。
3. 失败语义：拿不到锁 → 抛 `EMEMORY_LOCK_TIMEOUT`（**不写、不静默降级**）；调用方记录并延后重试。
4. 进程内优化：同一进程对同一文件的连续写可加 async 队列（避免自己和自己抢锁），但**不替代**跨进程锁。
5. 测试（D1-1B）：
   - 两进程并发 +50 → 100；
   - 超时不写；
   - SIGKILL 后恢复；
   - 格式字节不变（同一数据写入前后与旧实现一致）；
   - 单进程 100 次追加不丢；
   - 不同成员文件不阻塞。

## 六、回退方案

- 若 D1-1B 在目标环境验证失败（如 rename 认领在特定文件系统不可用）：
  1. 退回 `writeJson` 现状（tmp+rename，无锁），**记录风险**，不静默启用半成品；
  2. 或改用 proper-lockfile（需单独评估/安装）；
  3. 或把 impression 写入收敛到"单写入者 + 进程内队列"（跨进程风险由 R8-0 单实例守门承担）。

---

## 七、未验证 / 推测

- **LockFileEx（native）**：未安装、未编译、未测；表中"OS 自动释放"来自文档常识，**本机未验证**。
- **proper-lockfile**：未安装、未测；"心跳过期"来自其文档，**未验证**。
- **Electron 打包环境**：本实验用系统 Node 24；Electron 内置 Node 版本未单独验证（方案无 native 依赖，理论上无 ABI 问题，但**未实测**）。
- **多机/网络盘**：未测。

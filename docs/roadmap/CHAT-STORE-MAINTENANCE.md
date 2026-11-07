# 聊天存档维护约束与已知风险

> 时间：2026-11-03
> 适用范围：`src/store.js`（聊天存档）、`src/file-lock.js`（跨进程锁）、`plugins/silence-ping`（旁路写入口）
> 关联报告：
> - 调查：`CHAT-SAVE-CONCURRENCY-INVESTIGATION.md`（`337daa9`）
> - 设计：`CHAT-SAVE-IMPLEMENTATION-DESIGN.md`（`22aae67`）
> - 实施：`CHAT-SAVE-W1-W5-REPORT.md`（`e4fcc68`）
> - 跟进审查：`CHAT-SAVE-FOLLOWUP-AUDIT.md`（`81dc5a0`）
> - P1/P2：`P1-P2-REPORT.md`（`6d4e507`）

---

## 一、当前状态（四种状态必须分开看，不得混为一谈）

| # | 问题 | 状态 | 证据 |
|---|---|---|---|
| 1 | **多进程同时写入互相覆盖** | ✅ **已修复**（W1–W5） | `store-concurrent-test` 38 项；`store-mutation-test` 33 项 |
| 2 | **同 mid 不同内容被误判为重复、静默丢弃** | ✅ **已修复**（P1） | `store-dedup-test` 23 项 |
| 3 | **陈旧锁回收竞态（TOCTOU）** | ⚠️ **已证实、未修复**（P2 暂停） | `lock-reclaim-protocol-test` 11 项（反例成立） |
| 4 | **消息已进内存、未落盘就被杀** | ❓ **未验证、未修复** | 没有实现，也没有概率数据；WAL 明确不在本阶段 |

**一句话**：并发覆盖修好了；误判重复修好了；锁回收竞态被证实但还没修；未落盘被杀这类丢失还没有测量。

---

## 二、维护约束（后续改动必须遵守）

| # | 约束 | 为什么 |
|---|---|---|
| 1 | **禁止恢复仅依赖 ±10 分钟时间窗的旧判重逻辑** | 旧逻辑在同 mid 不同内容时静默吞消息（已复现，见 `P1-P2-REPORT.md` 1.2） |
| 2 | **同 mid 不同身份或内容必须保留消息并记录冲突** | 不得静默覆盖/丢弃；冲突写 `conflicts[]`（`different-sender` / `different-self` / `different-content` / `time-gap`） |
| 3 | **null mid 不参与 mid 判重** | 拍一拍、面板兜底等场景 mid 为 null；判重会误吞 |
| 4 | **冲突记录容量限制不能影响正式消息保存** | `MAX_CONFLICTS = 50` 只挤诊断记录；`messages` 永远照常追加 |
| 5 | **所有聊天写入必须通过统一 `#update`** | 目前 11 个写方法全部经它；新增写方法也必须走，禁止另开写路径 |
| 6 | **禁止重新引入旧快照整文件写回** | `saveChat(state)` 已被删除；快照写回是丢消息的根因（原子写 ≠ 并发安全） |
| 7 | **禁止使用未经原子所有权保护的陈旧锁 `unlink` / `rename` 回收方案** | P2 已证明「检查后操作路径」存在 TOCTOU；Windows 上 `rename` 覆盖会破坏别人新锁 |
| 8 | **`mtime/size` 只是缓存失效提示，不是内容版本号** | 同大小 + mtime 被固定时检测不到内容替换；需要内容 hash 才能覆盖（已知边界） |
| 9 | **当前 `withFileLockAsync` 的陈旧锁回收仍有已知 TOCTOU 风险** | 概率低（需死锁 + 两进程同时回收 + 微秒窗口），但**未被修复**；不得把它描述为"已解决" |

---

## 三、P2 立项记录（独立待研究事项，当前暂停）

### 3.1 现状

`src/file-lock.js` 的回收路径是「`lockState` 判陈旧 → `unlink` → 重新 `wx` 竞争」。检查与删除是两步，跨进程不原子。

已复现的反例（`test/lock-reclaim-protocol-test.mjs`）：

```
A 读锁：pid 死 → 判 stale
B 抢先 rename 走死锁 → 建自己的新锁（活着）
A 再 rename 认领 → 搬走的是 B 的活锁
```

Windows 实测：`rename` 覆盖已存在目标会成功，所以「搬回去」也会覆盖别人的新锁。

### 3.2 未来重启 P2 时先比较三种方案（不预先认定 fencing token 最优）

| 方案 | 思路 | 需要证明/评估 |
|---|---|---|
| **OS 级文件锁** | Windows `LockFileEx` / POSIX `flock` | 跨平台封装、原生依赖、打包影响 |
| **单写入者架构** | 只有一个进程/线程写聊天文件（如专用 writer 进程） | 与 Electron 单实例、插件写入的兼容性 |
| **数据提交边界可原子校验 fencing token 的存储方案** | 写路径拒绝低 fence | 见 3.3 |

### 3.3 若选择 fencing token，必须证明以下五条

1. token **严格递增**且不会回退；
2. 过期 token **无法写入**（写路径校验）；
3. token 检查与数据提交属于**同一原子边界**（不能检查完再写、中间被替换）；
4. **重启后最高 token 不会丢失**（否则重启可回退）；
5. **所有写入入口**均受保护（含 silence-ping、面板、插件）。

任何一条无法证明，就不得实施。

### 3.4 重启前建议先做的只读测量

- OneBot 重连后 `message_id` 是否复用、间隔多长（决定判重窗口是否还需要）；
- 「进程被杀、消息未落盘」的实际发生概率（决定是否值得引入 WAL）；
- 双进程并存的实际频率（决定锁回收竞态的真实暴露面）。

---

## 四、本阶段明确不做的事

| # | 不做 | 原因 |
|---|---|---|
| 1 | 不修改 `src/file-lock.js` | P2 无法证明安全，暂停 |
| 2 | 不实施 fencing token | 超出本阶段范围；需先立项 |
| 3 | 不引入 OS 原生锁依赖 | 跨平台/打包代价未评估 |
| 4 | 不引入 WAL | 先测量「未落盘被杀」概率，避免为未确认故障加复杂度 |
| 5 | 不修改聊天 JSON 数据格式 | 当前格式向后兼容；fencing 方案才需要 |
| 6 | 不修改生产聊天数据 | 全程只读/临时目录 |
| 7 | 不启动第二个真实机器人 | 双进程测试用子进程 + 临时目录 |
| 8 | 不启用 silence-ping | 其写入口已并入统一锁，但功能保持关闭 |
| 9 | 不重新设计消息存储架构 | 本阶段只修并发覆盖 + 判重 |

---

## 五、验证与复现（只读测试，不写生产）

```powershell
# 聊天存档专项（全部使用临时 DATA_DIR）
node test/store-corrupt-test.mjs        # W1 损坏保护（19）
node test/store-mutation-test.mjs       # W2 锁内 mutation（33）
node test/silence-ping-store-test.mjs   # W3 旁路写入（12）
node test/store-cache-test.mjs          # W4 缓存失效（13）
node test/store-concurrent-test.mjs     # W5 双进程验收（38）
node test/store-dedup-test.mjs          # P1 判重与冲突（23）
node test/store-cache-samesize-test.mjs # 缓存边界（8）
node test/lock-reclaim-protocol-test.mjs # P2 协议反例（11）

# 全量回归（47 项，单项失败不中断）
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/run-regression.ps1
```

**基线口径（不得改写）**：W1–W5 专项 115/115；P1 23/23；全量回归 43/47（4 项既有失败：`selftest` / `tools-skill-audit` / `setup-qq-version` / `gallery-test`）。P2 协议实验 11/11 **只说明反例成立，不是锁加固成功**。

---

## 六、变更记录

| commit | 内容 |
|---|---|
| `aaae63e` | W1 损坏存档保护 |
| `a7076de` | W2 锁内 mutation，11 个写方法迁移 |
| `ac4ef04` | W3 silence-ping 并入统一锁 + test-send 带 mid |
| `9876833` | W4 读路径缓存失效 |
| `e4fcc68` | W5 双进程验收 + 全量回归 |
| `81dc5a0` | 后续只读审查 |
| `da0bde0` | P1 判重与冲突保留 |
| `6d4e507` | P2 协议实验（暂停） |

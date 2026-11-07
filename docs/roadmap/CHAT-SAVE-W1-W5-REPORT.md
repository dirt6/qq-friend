# 聊天持久化并发安全修复 · W1–W5 实施报告

> 时间：2026-11-03
> 授权：机主「连续实施授权」（W1–W5，一次工作周期内完成，最后统一汇报）
> 设计依据：`docs/roadmap/CHAT-SAVE-IMPLEMENTATION-DESIGN.md`（`22aae67`）
> 调查依据：`docs/roadmap/CHAT-SAVE-CONCURRENCY-INVESTIGATION.md`（`337daa9`）

---

## 一、结论（先看这里）

| 项 | 结果 |
|---|---|
| W1–W5 | 全部完成，5 个独立 commit |
| 专项测试 | 4 个新套件 + 2 个修改套件，**全部通过** |
| 双进程验收 | `store-concurrent-test` **38 项全过**（12 类场景） |
| 全量回归 | 见第五节（既有失败已标注，非本次引入） |
| 生产聊天记录 | **sha256 前后完全一致**（未写入一个字节） |
| 未解决问题 | 「已进内存、未落盘就被杀」仍无解（设计边界内） |

---

## 二、提交清单

| 工作包 | commit | 内容 |
|---|---|---|
| W1 | `aaae63e` | 损坏存档先备份并拒绝空状态覆盖 |
| W2 | `a7076de` | 锁内 mutation API，11 个写方法迁移（含异步锁） |
| W3 | `ac4ef04` | silence-ping 写入口并入统一锁 + test-send 带 mid |
| W4 | `9876833` | 读路径 mtime/size 缓存失效检测 |
| W5 | （本报告提交） | 双进程验收测试 + 全量回归 |

每个工作包独立提交，专项测试在各自包内跑过；W5 是测试与报告，不夹带功能改动。

---

## 三、每个工作包的实现与验收

### W1 · 损坏存档保护

**改了什么**（`src/store.js`）：
- `loadChat(chatKey, { onCorrupt })`：区分 **ENOENT（新会话）** 与 **损坏/权限错误**。
- 损坏时先**复制**备份 `${file}.broken-<mtime>`（不移动原文件），再按模式处理：
  - 读路径 `empty`：返回空状态 + 记 warn，**不写盘**；
  - 写路径 `loadChatForWrite`：抛 `ECHAT_CORRUPTED`，**禁止用空状态覆盖**。
- 备份失败抛 `ECHAT_BACKUP_FAILED`，同样禁止写入。
- 同一 mtime 只备份一份（不产生垃圾）。

**为什么必须做**：迁移后每次写都先读盘。若沿用旧的 `catch → 空状态`，一次 JSON 损坏就会把 6383 条覆盖成空文件。

**专项**：`test/store-corrupt-test.mjs` —— 19 项通过（含打桩 `copyFileSync` 验证备份失败、打桩 `readFileSync` 验证 EACCES 不被吞）。

### W2 · 锁内 mutation API

**改了什么**：
- `src/file-lock.js` 新增 `withFileLockAsync`：等待锁时 `setTimeout` 让出事件循环，**不冻结主线程**；锁文件格式与同步版一致，可互斥。
- `src/store.js` 删除 `saveChat(state)`（快照整写），新增 `#update(chatKey, mutator)`：
  ```
  withFileLockAsync(file, () => {
    fresh = loadChatForWrite(chatKey);   // 锁内重读磁盘
    { value, write } = mutator(fresh);   // 只施加动作
    if (write) writeFileAtomic(file, JSON.stringify(fresh));
    缓存 = fresh; 指纹 = stat(file);
    return value;
  }, { retries: 100, waitMs: 20 })       // 2 秒上限
  ```
- 11 个写方法全部 async 化并迁移：`appendIncoming / appendSelf / drainUnread / drainUnreadFrom / markAllRead / markEntryRead / markUnreadInWindow / markRecalled / updateByMid / removeByLocalIds / clearChat`。
- 幂等：同 `mid` 且 `ts` 差 ≤10 分钟 → 返回已有条目、不写盘（双进程收到同一事件只存一条）；`mid: null` 不参与判重。
- `sender.js`：新增 `#recordSelf()`，**留档失败只记日志、不算发送失败**（避免模型重发已发出的消息）。
- 所有调用点改 `await`：`app.js`、`orchestrator.js`（含 `onIncoming`/`retrySession` 变 async）、`routes.js`、`sender.js`、`tools.js`、`plugins/autonomous`。
- 测试适配：`selftest / coverage-offline / coverage-http / coverage-e2e / companion-isolation / prompt-anchor / test-prompt / message-id / wake-semantics` 的调用全部改成 `await`（API 变化的必要适配，不是改断言掩盖问题）。

**专项**：`test/store-mutation-test.mjs` —— 33 项通过（语义回归、幂等窗口、null mid、写前重读、锁超时、原子写失败、损坏拒绝、子进程写）。

### W3 · silence-ping 并入统一锁

**改了什么**：
- `plugins/silence-ping/index.js` 的 `appendSelfToFile`：从「自己读快照 + 固定 tmp + 4 次 rename」改为 `withFileLock(file)` 锁内 `loadChatFile → push → writeFileAtomic`，与 ChatStore 共用 `${file}.lock`。
- `routes.js` 的 test-send：把 OneBot 返回的 `message_id` 传给 `appendSelf`（此前丢弃，导致面板消息永远无法幂等）。

**专项**：`test/silence-ping-store-test.mjs` —— 12 项通过，含**子进程插件写 20 条 + 主进程核心写 20 条，总数 40、id 连续无重复**。

### W4 · 读路径缓存失效

**改了什么**：
- `#state` 每次读先 `statSync`：`mtimeMs + size` 与缓存指纹一致才用缓存，否则重读。
- 写路径写成功后同步刷新指纹（`#update` 末尾）。
- 损坏文件在同一 mtime 下不重复备份。

**边界**：这只是**缓存失效检测**，不是并发控制——写仍然只能走 `#update` 的锁。指纹失效时重读可能读到"刚好正在写"的完整旧/新文件（rename 原子），不会读到半截。

**专项**：`test/store-cache-test.mjs` —— 13 项通过（子进程新增/删除/改文本/写坏文件，本进程都能正确感知）。

### W5 · 双进程验收 + 全量回归

**专项**：`test/store-concurrent-test.mjs` —— 38 项通过，覆盖机主验收清单 12 项：

| # | 场景 | 验证点 |
|---|---|---|
| ① | 并发新增 | A/B 各 50 条 → 100 条，id 连续 1..100 |
| ② | 同 mid 幂等 | 两进程同时写同 mid → 只 1 条 |
| ③ | null mid | 两条都追加（不判重） |
| ④ | 删除不复活 | A 删 1-10、B 并发追加 → 被删的没回来 |
| ⑤ | 撤回并发 | recalled 保持 true，新消息不丢 |
| ⑥ | clear 并发 | 旧消息一条不剩，nextLocalId 不重置 |
| ⑦ | 修改并发 | text 与 media 都保留（各改各的字段） |
| ⑧ | 锁超时 | 子进程持锁 5s → 主进程 2s 抛 ELOCKTIMEOUT，磁盘不变 |
| ⑨ | 坏文件 | 两进程同写 → 都 ECHAT_CORRUPTED，原文件不动，1 份备份 |
| ⑩ | 持有者异常退出 | 持锁子进程 exit(9) → 锁残留 → 下一个进程回收并写入 |
| ⑪ | 原子写失败 | 打桩 rename EBUSY → 抛错，旧文件字节不变，无 tmp 残留 |
| ⑫ | 缓存外部失效 | 本进程读到子进程刚写的消息 |

---

## 四、生产数据核对

| 项 | 实施前 | 实施后 |
|---|---|---|
| `data/messages/private_1846383180.json` sha256 | `BE986B4A…78C` | `BE986B4A…78C` |
| bytes | 1742529 | 1742529 |
| mtime | 2026-11-03T20:19:55.8819159+08:00 | 同 |
| 消息数 | 6383 | 6383 |

**没有写入、没有迁移、没有清理生产 tmp**。所有测试均使用 `mkdtemp` 临时目录。

---

## 五、全量回归

### 5.1 回归范围

`npm test` 的 37 项 + 本工作包新增/相关的 8 项（4 个 store 专项 + state-store + learned-concurrent + token-ledger-concurrent + store-concurrent），**共 45 项**。逐项执行、单项失败不中断（脚本：`scripts/run-regression.ps1`，可复跑）。

### 5.2 结果

**通过 41 / 失败 4**（4 项均为**既有失败**，已用 `git stash push -u` 回到 `22aae67` 改动前代码逐项复跑确认，失败点完全相同）。

通过（41）：community / skill / onebot-whitelist / sticker-collect / message-id / message-images / image-cache / master-mode / sticker-context / skill-modal-ui / render / scroll / usage-e2e / usage-daily / test-prompt / prompt-anchor / wake-semantics / setup-download / qq-pack / qq-process-detect / sender-file-uri / sender-send-path / vendor-mirror / safe-fetch-file / market-zip / web-search-parse / web-panel-page / recall-resolve / qself-profile-write / reminder-action / diary / now-playing / speech-to-text / state-store / learned-concurrent / token-ledger-concurrent / store-corrupt / store-mutation / store-cache / silence-ping-store / store-concurrent

### 5.3 既有失败（改动前就存在，非本次引入）

| 测试 | 失败点 | 判定依据 |
|---|---|---|
| `selftest` | 「工具名不带 qq_ 前缀」 | `git stash` 后同样失败 |
| `tools-skill-audit` | 工具定义/分类/能力消费方 3 项 | 同上，失败行完全相同 |
| `setup-qq-version` | `--check` 不报告协议栈 CLIENT_BUILD | 同上 |
| `gallery-test` | `skills/gallery/index.js` 模块不存在（`ERR_MODULE_NOT_FOUND`） | 同上，仓库缺该 skill 目录 |

### 5.4 额外的 coverage 套件

| 套件 | 结果 |
|---|---|
| `coverage-http` | 通过 112 / 失败 4（既有）：memory-files/consolidate ×2、qq-portable/launch（沙箱 `spawn EPERM`）、路由覆盖率 70% |
| `coverage-offline` | 跑到 ffmpeg 探测处 `execFile EPERM`（沙箱限制，非代码问题）；store 相关段由 4 个专项覆盖 |
| `coverage-e2e` / `coverage-ui` / `coverage-wiring` | 未纳入本次（不涉及 store；需要真实浏览器/完整环境） |

---

## 六、完整 diff 审查结论

`git diff 22aae67..HEAD` 共 22 文件、+1340/−302。逐块审查结论：

| 文件 | 审查结论 |
|---|---|
| `src/store.js` | 11 个写方法全部经 `#update`；无残留 `saveChat`；无绕过锁的写路径；`#trim` 在锁内执行 |
| `src/file-lock.js` | 异步版与同步版抢锁/释放/回收逻辑逐行对齐；仅等待方式不同 |
| `src/app.js` | 入站/拍一拍/撤回三处 `await`；`onIncoming` 变 async 后调用点已 await |
| `src/orchestrator.js` | 8 处写调用全部 await；`onIncoming`/`retrySession` 变 async 的调用方已适配 |
| `src/routes.js` | 6 处写路由 await；test-send 补 mid；无同步调用残留 |
| `src/sender.js` | 5 处留档改为 `#recordSelf`；失败只记日志 |
| `src/tools.js` | `updateByMid` 加 await |
| `plugins/autonomous/index.js` | 2 处 `storeRef.appendSelf` 加 await（否则 Promise 未处理） |
| `plugins/silence-ping/index.js` | 写入口改为锁内读改写；删除固定 tmp 逻辑 |
| 测试文件 | 全部是 API 适配（`await`/async 回调），未放宽任何断言 |

**没有发现**：新的生产写入入口、绕过统一 mutation 的写路径、localId 重排、对既有业务语义的改动。

---

## 七、未解决问题（明确边界）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 「已进内存、未落盘就被杀」 | **未修**（设计边界）。锁解决的是并发覆盖，解决不了进程死。需即时落盘或 WAL，是更大工作包 |
| 2 | 读路径不加锁 | 有意为之：用 mtime/size 指纹换正确性与成本平衡 |
| 3 | 2 秒锁预算在超大会话下的表现 | 未验证（当前 1.5MB / 6383 条，单次写 12–15ms） |
| 4 | OneBot 重连后 mid 是否复用 | 未验证；用 ±10 分钟时间窗兜底，超窗按新消息追加（宁可重复不丢） |
| 5 | `selftest` 的 qq_ 前缀失败 | 既有问题，不在本工作包范围 |
| 6 | 8899 面板退役 / Session 22MB 膨胀 | 仍是独立工作包 |

---

## 八、PASS / FAIL / INCONCLUSIVE 分类

| 项 | 分类 |
|---|---|
| W1 损坏保护 | **PASS**（19 项专项） |
| W2 锁内 mutation | **PASS**（33 项专项） |
| W3 插件并入 + mid | **PASS**（12 项专项） |
| W4 缓存失效 | **PASS**（13 项专项） |
| W5 双进程验收 | **PASS**（38 项） |
| 生产数据未被动 | **PASS**（sha256 一致） |
| 全量回归 | 见第五节；既有失败不计入本次 PASS/FAIL |
| 「未落盘被杀」 | **INCONCLUSIVE**（未实现，设计边界） |

---

## 九、这次调查/实施中如实记录的问题

1. **W2 专项测试第一版写错了期望**：`markUnreadInWindow` 的窗口会向前放宽 5 分钟，我按"只恢复 2 条"断言，实际 3 条。是测试期望错误，已改为 3 条并在测试名里注明语义。
2. **`selftest` / `coverage-http` 的失败一开始无法判断是否本次引入**：用 `git stash push -u` 回到改动前代码重跑，确认是既有失败后才继续。
3. **silence-ping 的 `appendSelfToFile` 在 `internals` 对象里**，不是具名导出；第一版测试导入方式错了，已改。
4. **`coverage-offline` 的 ffmpeg 探测在 DSH 沙箱里 EPERM**：不是代码问题，是沙箱 `execFile` 限制；真实环境可继续。
5. **全量回归里 4 个失败不能靠"看起来无关"就放过**：对 `selftest` / `tools-skill-audit` / `setup-qq-version` / `gallery-test` 逐个 `git stash` 回改动前复跑，失败点完全一致才判为既有失败。`gallery-test` 的真因是仓库里没有 `skills/gallery/index.js`（`ERR_MODULE_NOT_FOUND`），与 store 无关。

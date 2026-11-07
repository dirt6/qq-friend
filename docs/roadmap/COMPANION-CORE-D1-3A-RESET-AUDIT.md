# D1-3a 审计：reset / clear / delete / truncate / 初始化入口

> 时间：2026-11-04
> 性质：**只读审计**；未修改代码、未写生产、未清理生产文件
> 范围：日记正文、meta、pending、outbox、companion state、learned、impression、activity 及相关缓存

---

## 一、入口清单

### 1. `POST /api/reset-data`（最危险）

- **调用者**：设置页「重置为初始形态」按钮 → `src/routes.js:1550`
- **实际影响**：`DATA_DIR` 下的**所有内容**（递归 `fs.rmSync`），跳过 `qq-agent.lock`；包括 `learned.json`、`memory/`、`sessions/`、`autonomous.json`、`diary-meta/`（含 `pending.json`）、`companion-state.json`、`usage-days/`、`image-cache/` 等。
- **不影响的**：日记正文（`config.skills.diary.root` 默认在 `E:\dsh\日记`，在 `DATA_DIR` 之外）→ **正文保留、meta/pending 被删**。
- **锁**：无文件锁；仅 `orchestrator.abortAll()` + `onebot.close()`（停业务）。
- **备份**：`fs.cpSync(DATA_DIR → DATA_DIR.backup-<stamp>)`（同步全量复制；备份失败中止重置）。
- **失败**：备份失败 → 500 中止；删除中途失败 → 500，已删部分不回滚。
- **删重要内容**：**是**（全部数据）。
- **删未完成操作**：**是**（`pending.json` 里的 prepared/body_done/meta_done 一并删除，无提示、无对账）。
- **其他风险**：安全闸只检查目录名是否 `data*` 或含 `config.json`；备份是同步全量，数据大时阻塞主线程。

### 2. `POST /api/chats/:key/clear`

- **调用者**：会话页「清空」按钮 → `src/routes.js:2878`
- **实现**：`store.clearChat` → `#update`（文件锁 + 原子写）
- **影响**：该会话的 `messages` 数组清空（文件保留）
- **锁**：`withFileLockAsync` + `#update` ✓
- **备份**：无
- **失败**：`#update` 抛错 → handler 未 catch（由上层框架处理）
- **删重要内容**：**是**（全部聊天消息，不可恢复）
- **删未完成操作**：否（不碰 pending）

### 3. `POST /api/chats/:key/delete-messages`

- **调用者**：会话页部分删除 → `src/routes.js:2898`
- **实现**：`store.removeByLocalIds` → `#update`（锁 + 原子写）
- **锁** ✓；**备份** 无；**失败** 抛错
- **删重要内容**：是（指定消息，不可恢复）

### 4. `POST /api/sessions/clear-finished`

- **调用者**：会话页「清理已结束」→ `src/routes.js:2600`
- **实现**：`sessions.clearFinished()`（`src/sessions.js:512`）
- **影响**：`data/sessions/<id>.json`（已结束会话），index 内存同步
- **锁**：**无**（内存 index + `unlinkSync`）
- **备份**：无；**失败**：单个 unlink 失败被 `catch {}` 忽略
- **删重要内容**：是（会话/用量记录文件；token-ledger 不删）
- **删未完成操作**：只保留 running/waiting，不清 pending

### 5. `POST /api/autonomous/delete`

- **调用者**：自主活动页删除某轮 → `src/routes.js:671`
- **实现**：直接 `readFileSync`/`writeFileSync` 改 `data/autonomous.json` 的 `history`
- **锁**：**无**；**原子写**：**无**；**备份**：无
- **失败**：读失败/写失败返回错误码（业务错误，非异常）
- **删重要内容**：是（该轮活动记录）
- **风险**：与 autonomous 插件的状态写入并发时可能互相覆盖（插件侧有自己的 state 锁，但这里没走）。

### 6. `POST /api/learned/delete`

- **调用者**：经验管理页 → `src/routes.js:1377`
- **实现**：`learned.removeItem(id)`（`withState` 锁 + 原子写 + `__deleted` 标记防合并）
- **锁** ✓；**备份** 无；**失败** 返回 `{ok:false}`（不抛）
- **删重要内容**：是（单条经验；hits/corrections 一起没）
- **校验**：`confirm` + 目标存在性检查

### 7. `PUT/DELETE /api/memory-files/...`

- **调用者**：记忆管理页 → `src/routes.js:2687/2704/2714`
- **实现**：`memory.editMemberImpression` / `removeMember` / `removeChat`
- **锁**：`#withChatLock`（端口锁 + 进程内队列）✓
- **备份**：`editMemberImpression`/`replaceMember` 有 `.trash` 备份；`removeMember`/`removeChat` **无备份**
- **失败**：写失败抛错 → 路由 catch 返回 400
- **删重要内容**：是（成员印象/整个会话记忆目录，不可恢复）
- **删未完成操作**：否

### 8. 初始化入口（只建不删）

- `app.js:405/1989/2563`、`config.js:657`、`instance-lock.js:137`：`mkdirSync(DATA_DIR)`；
- `companion/events.js:35`、`draw.js:41`：`ensureDir()`。
- **影响**：仅创建目录/锁文件；不删除、不截断。

### 9. 自动清理（无显式入口）

- `sessions.finish()`：按 `keepFiles` 删除最旧会话文件（`unlinkSync`，无锁、无备份、失败忽略）——`src/sessions.js:446-455`
- `sessions.discard(id)`：只删 `waiting` 会话文件
- `outbox.completeDiaryOp` → `pruneInPlace`：只删 `completed` 的 pending 记录（保留 7 天/200 条），**不删未完成**
- `outbox.pruneCompletedDiaryOps`：**定义了但无调用者**（清理发生在 `completeDiaryOp` 内联）
- `image-cache` 孤儿清理（启动时）、`sessions` 僵尸回收（启动时）

### 10. 缓存

| 缓存 | 位置 | 清理方式 |
|---|---|---|
| ChatStore 内存状态 | `store.js #cache` | `#update` 后同步更新 |
| MemoryStore 缓存 | `memory.js this.cache` | 写方法前 `cache.delete(chatKey)` |
| sessions index | `sessions.js this.index` | `clearFinished/discard/finish` 同步 |
| DSH 内存 session | `dsh-gateway.resetSession` | 仅显式重试时重置，**不随 clear/删除联动** |
| image-cache 索引 | 文件 | 启动孤儿清理 |

---

## 二、风险清单（按严重度）

| # | 风险 | 说明 |
|---|---|---|
| 1 | **reset-data 删除未完成 pending 与 meta，但保留日记正文** | 正文与 meta 直接失配；无对账提示；用户点一下「重置」即可丢掉待补偿操作 |
| 2 | **autonomous.delete 无锁/无原子写/无备份** | 与插件并发写 `autonomous.json` 可能丢更新 |
| 3 | **memory.removeMember / removeChat 无备份** | 成员印象/整目录删除不可恢复（与 editMemberImpression 的备份策略不一致） |
| 4 | **sessions.clearFinished 无锁/无备份** | 与正在 finish 的会话并发时可能删错/漏删 |
| 5 | **reset-data 备份是同步全量 cpSync** | 数据大时阻塞事件循环；备份期间新写入可能不一致 |
| 6 | **chat clear/delete-messages 无备份** | 消息删除不可恢复（产品决定，但应明确） |
| 7 | **dsh-gateway 内存 session 不随 clear 联动** | 清空聊天后内存里可能仍有旧 session 引用 |

## 三、明确没有发现的问题

- 没有"按 mtime 删锁"或 rename stale-lock 回收；
- 没有自动删除未完成 pending 的代码路径（`pruneInPlace` 只删 completed）；
- 没有对 `qq-agent.lock` 的删除（reset-data 显式跳过）。

## 四、未覆盖

- 面板前端按钮的二次确认文案（只审后端）；
- `dsh-gateway` 的 DSH Session 存储清理（不在本批范围）；
- 生产 `--confirm` / 重置演练（按约束未执行）。

## 五、生产保护

本审计只读：未执行任何写命令、未清理生产文件。生产 `pending.json` / `data/diary-meta` / 日记正文三份 hash 在审计前后一致（见验收记录）。

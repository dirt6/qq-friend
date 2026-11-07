# D1-3b-B3 预检：MemoryStore 删除入口

> 时间：2026-11-04
> 性质：只读预检；本批只改 removeMember / removeChat 的备份与路径安全

## 1. 实际影响范围

| 入口 | 目标 | 锁 |
|---|---|---|
| `removeMember(chatKey, userId)` | `data/memory/<chatDir>/<userId>.json`（也兼容 `u_<id>.json` / `_n_<name>.json`） | `#withChatLock(chatKey)` = `withMemoryPortLock(chatDir, fn, {timeoutMs:5000})` |
| `removeChat(chatKey)` | `data/memory/<chatDir>/` 下全部文件（成员 + `_meta.json`）+ 旧版 `data/memory/<chatDir>.json` | 同上 |

- `chatDirName(chatKey)` 会把非 `[a-z0-9_]` 字符替换为 `_`，`..`、`/` 无法直接进入目录名；
- 成员文件名：数字 id → `<id>.json`；非数字 → `u_<sanitized>.json`；无 id → `_n_<name>.json`。

## 2. 锁的粒度与覆盖

- 端口锁（`memory-port-lock`）：按 `chatDir` 哈希到 42000–42999 的端口，跨进程串行；
- 超时 5s，超时抛 `MemoryLockError('EMEMORY_LOCK_TIMEOUT')`；
- 现有删除在锁内执行，但**备份（若有）与删除需在同一锁区间**；当前 `editMemberImpression` 的备份在锁内，但会覆盖同名旧备份。

## 3. 现有 `.trash` 备份规则

- `editMemberImpression` / `replaceMember`：`data/memory/backups/<chatDir>/<basename>`；
- 覆盖式：目标已存在则先删再复制（`fs.rmSync(dst)`）；
- **没有 hash 校验**；复制失败 `catch {}` 静默跳过，然后继续写新内容；
- `removeMember` / `removeChat`：**完全没有备份**。

## 4. 路径穿越 / 符号链接风险

- `chatDirName` 过滤了 `..` 和分隔符，正常输入不会穿越；
- 但 `data/memory` 下若存在 **junction/符号链接**，`chatDir` 解析后可能指向根外，`removeChat` 的 `fs.rmSync(dir, {recursive:true})` 会跟随删除——必须在删除前做真实路径校验；
- 旧版单文件 `legacyFile` 同样需要校验；
- 备份目录固定为 `data/memory/backups`，需保证备份目标唯一（禁止覆盖）。

## 5. 备份与删除的并发窗口

- 当前删除在锁内，但备份不存在；
- 本批要求：**同一把锁内完成 读取 → 备份 → 校验 → 删除 → 审计**；
- 复制本身不是原子操作，必须逐文件 SHA256 校验，校验失败拒绝删除。

## 6. 调用者

- `routes.js:2703` `await memory.removeMember(chatKey, match[3])`；
- `routes.js:2713` `await memory.removeChat(chatKey)`；
- 两者都忽略返回值；改为返回结果对象后路由会同时返回备份信息。

## 7. 本批边界

- 不改其他清理入口、不改数据格式、不在生产演练；
- 恢复只提供内部函数（可识别/可核验），不建 UI；
- 测试通过统一启动器（`run-diary-test.mjs`），使用隔离 `QQ_AGENT_DATA_DIR`。

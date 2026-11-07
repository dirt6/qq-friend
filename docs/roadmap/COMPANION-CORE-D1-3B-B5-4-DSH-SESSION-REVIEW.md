# D1-3b-B5-4 审查：DSH Session 与本地聊天/会话的关系（只读）

> 时间：2026-11-04 晚
> 性质：**只读审查**；未调用 DSH、未删除/迁移任何 Session、未改代码
> 结论先行：**本地文件删除 ≠ DSH 内部 Session 删除**；当前没有可验证的 DSH Session 删除接口。

## 一、DSH Session 的创建与复用

| 环节 | 位置 | 行为 |
|---|---|---|
| 读取映射 | `src/dsh-gateway.js:961-963` | 从 `data/dsh-sessions.json` 读 `map[chatKey].sessionId` |
| 冷启动 | `dsh-gateway.js:1000-1011` | 无映射 → 不带 `--session-id`，DSH 新建会话；preface（人设/历史）拼进首条消息 |
| 复用 | `dsh-gateway.js:1006` | 有映射 → `--session-id <sid>`，同一 chatKey 固定同一 DSH session |
| 串行 | `dsh-gateway.js:220-227` | 按 chatKey 排队（DSH session 不是并发安全的） |
| 回写 | `dsh-gateway.js:1219-1227` | 事件流 `type=session` 回写 `{sessionId, createdAt, lastUsedAt, turns}` |
| 实际存储 | `DSH_HOME = data/dsh-home` | `sessions/--E-dsh-QQ-agent--/session-*/session.v4.jsonl.zstd` 等（生产实测单文件可达 23MB） |

映射键 = chatKey（如 `private:1846383180`），值只存 sessionId/时间/轮数。

## 二、删除 / 重置能力

- **`resetSession(sessionKey)`（`dsh-gateway.js:234-238`）**：只删映射里该 key 并原子写回，**全仓库无生产调用者**（只有测试与文档）——是死接口；
- **没有任何“删除 DSH 会话文件”的入口**；`src/session/adapter.js:41-48` 明确声明 `list/delete/ttl/naming = false`，并注明 DSH 没有 TTL、会话文件“永远不消失，要清理只能由 QQ-agent 显式删目录（本批不做）”；
- DSH CLI 侧没有可验证的删除命令（据 adapter 的 2026-11 实测注释，本次未复验，标 UNKNOWN）；
- 没有 HTTP 路由、CLI 或 UI 做 DSH session 清理。

## 三、各删除入口对 DSH 的影响

| 入口 | 本地聊天/会话 | `dsh-sessions.json` 映射 | DSH 会话文件 |
|---|---|---|---|
| `POST /api/chats/:key/clear`（B5 已加备份） | 清空 messages | **不动** | **不动** |
| `POST /api/chats/:key/delete-messages`（B5 已加备份） | 删指定消息 | **不动** | **不动** |
| `DELETE /api/sessions/:id` / `clear-finished` | 删本地 session 留档 | **不动** | **不动** |
| `POST /api/reset-data`（B4） | 删 data 全部子项 | **随 data 删除（有备份）** | `data/dsh-home` 被删（有备份） |

推论：**清空聊天后，下一轮仍复用同一个 DSH session**（她还“记得”清空前的对话）；reset 会连带删掉 DSH 会话文件，但 `abortAll` **不会 kill 在跑的 dsh 子进程**，子进程持写句柄时删除可能失败（reset 会记录为 `needs_manual_recovery`，不会谎报成功）。

## 四、风险

1. **语义不一致**：用户点“清空存档”后，本地消息没了，但 DSH 侧历史仍在并被复用；UI 目前没有说明这一点（B5 只在报告记录，未改文案/行为）；
2. **孤儿 Session**：映射被 reset 删除 / `resetSession` 未接入时，旧 `dsh-home` 会话文件不会被回收（DSH 无 TTL）；`data/dsh-home` 若已有残留，`dsh-sessions.json` 丢失后不会被引用；
3. **子进程持锁**：超时 kill 链曾出现“cmd 被杀、node 仍持有 session 写锁”，下一轮报 `already owned by an active write handle` 并静默回落 API（`dsh-gateway.js:1108-1113`）；
4. **映射与本地会话解耦**：删本地 session 留档不会让 DSH 换新会话；反之 reset 后映射清空 → 下一轮冷启动新 session；
5. **不可验证**：清空后 DSH 运行时是否仍读取旧 zstd、reset 时是否有活跃子进程持句柄、DSH 是否存在未文档化清理命令——本次只读约束下均为 UNKNOWN。

## 五、结论与后续建议（不本批实施）

- **能证明（静态）**：上述调用链、`resetSession` 无调用者、DSH 无 delete 能力、reset 会删 `dsh-home`、clear/delete 不联动 DSH；
- **不能证明**：运行时是否仍引用旧 session、是否有可用的官方清理接口；
- **建议（独立工作包）**：
  1. 给“清空聊天”加显式选项或独立入口「同时重置她的 DSH 会话」（调用现有 `resetSession`，并写审计），默认行为不变；
  2. 为 `data/dsh-home` 的孤儿 session 设计可验证的清理/归档策略（需 DSH 侧确认目录语义）；
  3. 在 UI 明确“清空只清本地存档，不删除 DSH 记忆”；
- **本批不做**：不伪造清理成功、不调用未验证接口、不影响当前聊天功能、不改 DSH Session 迁移方案。

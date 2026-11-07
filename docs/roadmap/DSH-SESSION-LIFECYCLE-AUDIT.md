# DSH Session 生命周期审计（只读）

> 时间：2026-11-04
> 性质：只读源码调查 + 生产只读审计；未删除/迁移 Session、未终止进程、未改映射
> 关联：D1-3b B5-4 审查、D1-4 一致性审计、P3 工具 `scripts/dsh-session-audit.mjs`

## 一、生命周期事实（源码）

| 环节 | 位置 | 事实 |
|---|---|---|
| Session ID 生成 | DSH CLI（子进程） | `dsh headless --json` 新建时由 DSH 生成 `session-<uuid>`；QQ Agent 只记录返回值 |
| 映射保存 | `src/dsh-gateway.js:34,204-218` | `data/dsh-sessions.json`：`{ [chatKey]: { sessionId, createdAt, lastUsedAt, turns } }`，原子写 |
| 读取/复用 | `dsh-gateway.js:961-1011` | 有映射 → `--session-id <sid>`；无 → 冷启动，preface 拼首条消息 |
| 映射回写 | `dsh-gateway.js:1219-1227` | 事件流 `type=session` 回写 sessionId/turns |
| 并发 | `dsh-gateway.js:220-227` | 按 chatKey 队列串行（DSH session 非并发安全）；单实例锁保证单进程 |
| Session 文件 | `data/dsh-home/sessions/<project>/<session-*>/` | 由 DSH 子进程写（zstd jsonl 等），QQ Agent 不解析内容 |
| 重置映射 | `dsh-gateway.js:234-238 resetSession` | **死接口**：全仓无生产调用者 |
| 删除 Session | `src/session/adapter.js:41-48` | DSH 无 delete/TTL/list 能力；没有可验证清理命令 |
| 异常退出 | `dsh-gateway.js:1108-1147` | 仅超时 `taskkill /T /F`；无持久子进程表；可能残留 node 持写句柄 |
| 清空聊天 | `src/routes.js` chat clear/delete-messages | **不触碰 DSH 映射/Session**；下一轮仍复用同一 session |
| 重置 data | `src/reset-data.js` | 连带删除 `dsh-sessions.json` 与 `dsh-home`（有跨目录备份） |
| 本地 sessions 清理 | `src/sessions.js` | 只删本地留档；不联动 DSH |

## 二、六类异常分析

| # | 场景 | 现状 | 判定/风险 |
|---|---|---|---|
| 1 | Session 文件存在但 DSH Session 不存在 | 文件即 Session 本体，不存在“文件在、Session 不在”（除非 DSH 内部索引丢失，本批无法验证） | UNKNOWN（不解析 DSH 内部索引） |
| 2 | DSH Session 目录存在但本地映射不存在 | 历史遗留/换映射/测试写入均可产生；生产审计有 11 个孤儿目录 | **可检测（orphan）**；未映射不代表可删（可能属于其他项目/手工会话） |
| 3 | 多个聊天映射到同一 Session | 映射按 chatKey，正常不应重复；重复会让两人共享上下文 | **可检测（duplicate_mapping）**，人工处理，不自动改映射 |
| 4 | 清空聊天后旧 Session 被再次复用 | **当前行为**：clear 只清本地消息，映射保留 → 下一轮仍用旧 session | 语义不一致；未改行为，方案见 Recovery Design |
| 5 | 进程退出但 Session 状态仍显示运行中 | 本地 sessions 的 `running/waiting` 可能成僵尸（启动只扫最近 3 天） | 可检测（local_session_zombie）；只读审计，不删文件 |
| 6 | Session 结束后仍有子进程/工具执行 | DSH 子进程超时才 kill；无持久注册表 | 无法可靠判定归属 → **fail-closed：不 kill** |

## 三、孤儿判定（本工具）

- 目录：`data/dsh-home/sessions/<project>/session-*`；
- 被 `dsh-sessions.json` 任一 `sessionId` 引用 → 非孤儿；
- 未被引用 → `dsh_orphan_session`（warn），记录 project、mtime 年龄；
- **不**仅凭目录存在就判定可删；项目归属（如 `--E-dsh--` vs `--E-dsh-QQ-agent--`）必须核对。

## 四、进程身份与所有权（不能只靠 PID）

- 现状：无持久子进程注册表；PID 会被复用；PID 文件只用于 bot 单实例，不是 DSH 子进程归属；
- 设计（Recovery Design 展开）：任何恢复/终止必须同时满足
  1. PID 存在且**启动时间**与记录一致；
  2. 可执行文件路径在允许列表；
  3. 命令行包含期望的 sessionId/nonce（或父进程链匹配）；
  4. 有显式授权与审计；
  任一项无法确认 → **不终止**（fail-closed），只做文件级隔离/人工处理。

## 五、生产只读审计结果（2026-11-04）

```
映射=1  会话目录=12  被引用=1
critical=0  warn=11  info=0（全部 dsh_orphan_session）
计划（默认 project 过滤）：quarantine=0  manual=1
```

- 唯一映射：`private:1846383180 → session-2de90a0a-…`（turns=943）；
- 11 个孤儿：10 个属于 `--E-dsh-QQ-agent--`（约 4 天未改）、1 个属于 `--E-dsh--`（约 7 天，**外部项目**）；
- 默认计划只允许本项目目录进入隔离候选：当前 0 个；外部项目 1 个标记人工确认；
- **未执行任何隔离/删除/进程终止**。

## 六、审计工具

`scripts/dsh-session-audit.mjs`（只读）：

- `inspect`：映射缺失/孤儿/重复映射/无本地聊天/闲置映射/本地僵尸；`processOwnership=unknown`；
- `--plan`：仅生成计划（本项目、未映射、超期 → quarantine 候选；外部项目/映射异常/僵尸 → manual）；
- `quarantineSession/restoreQuarantined`：同卷移动（不删除）+ 审计，仅供隔离测试/后续授权流程；
- 不暴露生产清理 CLI、不解析 zstd 内容、不 kill。

测试：`test/dsh-session-audit-test.mjs`（8/8，见 Acceptance）。

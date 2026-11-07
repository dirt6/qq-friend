# D1-3b B1：清理语义分类与策略表

> 时间：2026-11-04
> 性质：设计文档；B2–B5 按此表实施

## 一、五类语义

| 语义 | 定义 | 容器/其他数据 |
|---|---|---|
| **clear** | 清空指定内容，保留容器与关联数据 | 保留 |
| **delete** | 删除明确指定的实体 | 视目标 |
| **archive** | 移出活动数据，保留可恢复记录 | 保留 |
| **reset** | 重置明确范围内的数据 | 范围外保留 |
| **truncate** | 仅删除明确指定的历史片段 | 保留 |

**禁止一个接口隐式承担多个语义**；跨语义必须拆成独立入口或显式参数。

## 二、现有入口映射

| 入口 | 语义 | 目标 | 重要数据 | 未完成操作 | 锁 | 备份 | 二次确认 | 失败恢复 |
|---|---|---|---|---|---|---|---|---|
| `POST /api/reset-data` | reset（跨目录） | `DATA_DIR/*`（跳过 lock）+ 需协调日记 meta/pending | 是（全部） | 是（pending） | 无 | 应备份 DATA_DIR + diaryRoot 相关 | 是（面板） | 当前：不完整；B4 加 manifest |
| `POST /api/chats/:k/clear` | clear | 该会话 messages | 是 | 否 | `#update` | 无 | 面板 | 抛错，文件保留 |
| `POST /api/chats/:k/delete-messages` | truncate | 指定 id 消息 | 是 | 否 | `#update` | 无 | 面板 | 抛错 |
| `POST /api/sessions/clear-finished` | delete（批量终态） | `data/sessions/<id>.json` | 是 | 否 | **待补**（B2） | **待补**（B2） | 面板 | 备份失败中止 |
| `POST /api/autonomous/delete` | delete（单轮） | `data/autonomous.json` history | 是 | 否 | **待补**（B2） | 无 | confirm+guard | 锁内读改写 |
| `POST /api/learned/delete` | delete（单条） | `learned.json` | 是 | 否 | `withState` | 无 | confirm+存在性 | 返回失败 |
| `PUT/DELETE /api/memory-files/*` | delete/clear | 成员印象/会话记忆目录 | 是 | 否 | 端口锁 | 部分（B3 补） | 面板 | B3 备份失败拒绝 |
| `outbox` completed 清理 | archive/truncate | pending.json completed | 否 | **否（永不删未完成）** | outbox 锁 | — | 自动 | 只删 completed |
| `sessions` 自动 `keepFiles` | truncate | 最旧 session 文件 | 是 | 否 | 无（B5 审） | 无 | 自动 | 明确保留规则 |
| 初始化 `mkdir` | —（只建） | DATA_DIR/子目录 | 否 | 否 | — | — | — | — |

## 三、默认策略（不改产品预期）

- `reset-data` 保持现有产品语义：**完整重置 `DATA_DIR`**；但 B4 增加：
  - 显式区分「应用状态重置（保留日记正文）」与「完整重置」的确认文案；
  - 跨目录 manifest 与备份验证；
  - 有未完成 pending 时默认拒绝。
- 用户主动删除（clear/delete/truncate）：必须提示不可恢复范围；自动清理必须有保留规则。

## 四、实施顺序

- B2：autonomous.delete（领域入口 + 锁 + 原子）、sessions.clearFinished（锁 + 备份 + 终态确认）。
- B3：memory.removeMember/removeChat 备份与路径边界。
- B4：reset-data manifest 跨目录协调（最高优先）。
- B5：其余入口与集成（chat clear/delete、learned、sessions 自动清理、outbox、DSH 内存 session）。

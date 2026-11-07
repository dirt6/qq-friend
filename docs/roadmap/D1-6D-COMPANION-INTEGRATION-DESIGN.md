# D1-6D：统一伙伴核心集成设计（不急于重构）

> 时间：2026-11-04
> 原则：**不改现有 prompt 输出、不改调度、不增加模型调用**；先加只读端口与 parity 测试，再逐步接线
> 依赖：D1-6D 审计（双入口、未使用门面、插件直连）

## 一、目标架构

```
插件/聊天/自主
   │  只能调用领域端口（不读文件、不 import 领域实现）
   ▼
Companion Core（组合根）
   ├─ state     : 伙伴状态快照/事务（唯一写入口）
   ├─ memory    : Memory Hub 只读检索（learned/impression/diary/activity/companion）
   ├─ diary     : 日记读写（委托 diary/index）
   ├─ goals     : Goal 生命周期
   ├─ pending   : Pending 生命周期
   ├─ activity  : 自主活动历史（只读）
   └─ context   : 聊天历史（只读）
```

- Core 不复制业务逻辑，只做**组合、权限、并发/一致性边界**；
- 领域模块仍是唯一实现（`companion/state.js`、`diary/index.js`、`memory-hub`、`store`）；
- 插件通过 `core` 或显式注入的端口访问，不再直接 import 实现文件。

## 二、分阶段（每步可回滚）

### 阶段 0：只读 parity（不接线）

- 新增 `core.readChatSnapshot({chatKey})`：一次返回 state 快照、memory 检索结果、diary 最近、activity 最近；
- 不参与 prompt 组装；用现有 `companionPromptSection()` 输出做**字节级 parity 测试**；
- 指标：快照与现有路径读取结果一致；无写操作；延迟可接受。

### 阶段 1：聊天读取改走 Core（不改 prompt）

- orchestrator 改为 `core.state.snapshot()` 取 state 文本，但**字符串内容完全一致**；
- 用 golden prompt 快照对比（同一 fixture，逐字节）；
- 若 parity 失败 → 自动回退旧路径（feature flag，默认旧路径）。

### 阶段 2：写入收口

- 聊天日记写入 → `core.diary.write`；自主写/删/改级 → `core.diary.*`；
- 所有 companion state 写 → `core.state.update`/`core.goals`/`core.pending`；
- 禁止插件直接 import `companion/state.js`、`diary/index.js`、`learned.js`（lint/审查规则）；
- 每域保留自己的锁；跨域不引入分布式事务，只保证单域原子。

### 阶段 3：活动检索统一

- `core.activity.recent` 与 `core.memory.search({layers:['activity']})` 使用同一 adapter；
- 聊天若需要活动摘要，只读 core，不直接读 `autonomous.json`；
- 去重：同一 roundId/actionId 只返回一次；不改变现有 `buildAutonomousNote` 的注入文案。

### 阶段 4：插件端口化

- 为插件提供显式端口对象（`{state, memory, diary, activity}`），不暴露文件路径；
- 端口方法带能力检查（只读/可写），写操作要求 `by`/`reason` 审计字段；
- 现有插件保持兼容：先适配 autonomous，再逐个迁移。

## 三、语义边界（定稿）

| 概念 | 定义 | 存储 | 写入口 | 读入口 |
|---|---|---|---|---|
| Goal | 长期目标（active/paused/terminal） | companion-state.goals | core.goals | core.goals/active |
| Pending | 待办/等待确认事项 | companion-state.pending | core.pending | core.pending.active |
| Action | 自主一轮中的具体动作（chat/diary/tool…） | autonomous.json history.actions | autonomous（唯一） | core.activity |
| Activity | 对 Action 的只读聚合视图 | 不单独存储 | 无 | core.activity / memory.search(activity) |
| Memory | 提炼经验/印象/日记/活动/伙伴项 | learned/memory/diary/... | 各自领域 | core.memory |
| Context | 聊天历史 | store | store（聊天） | core.context |

- Action ≠ Activity：前者是事件，后者是视图；
- Pending ≠ Goal：Pending 可来自 Goal 的中间步骤，但生命周期独立；
- 日记不等于长期记忆：日记是原文，learned 是提炼；Memory Hub 只读聚合，不合并写入。

## 四、并发与一致性

- 同域：沿用 `withState`/日记文件锁/store 锁；
- 跨域：不做分布式事务；Core 只保证“单次调用单域原子”；
- 聊天快照：一次读取一个版本；若自主在生成期间写入，下一轮读取新版本（可接受；不引入全局锁）；
- 写冲突：最后写入按域独立，不互相覆盖整个文件；审计记录 `by/reason`。

## 五、人格与 DSH 解耦

- 人格/行为状态：`companion-state.json` + `learned.json` + 日记；
- 会话：DSH Session 只承载对话连续性，不拥有状态；
- 新 Session 冷启动仍能通过 Core 读取同一人格/状态；
- 禁止把人格写入 DSH Session 专属目录作为唯一来源。

## 六、验收标准

1. 阶段 0：core 快照与现有路径读取一致（字节级 state 文本）；
2. 阶段 1：prompt golden 快照逐字节一致；无新增模型调用/调度变化；
3. 阶段 2：写路径全部经 Core；插件无直接 import（静态检查）；
4. 阶段 3：活动去重/检索一致；不改变现有注入文案；
5. 并发：聊天+自主同时写不损坏文件；单域锁测试；
6. 回滚：feature flag 一键回旧路径。

## 七、明确不做

- 不重写 Memory Hub；不复制状态；不改 prompt 文案；不改调度/预算/模型调用；
- 不把 DSH Session 当作伙伴状态存储；
- 不在本批实施大规模重构；先做阶段 0/1 的只读 parity。

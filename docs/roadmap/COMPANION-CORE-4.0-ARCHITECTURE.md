# COMPANION CORE 4.0 架构

> 时间：2026-11-04
> 原则：一个伙伴主体；Core 是统一能力入口；领域模块是唯一数据维护者；DSH 只是推理工具

## 一、分层

```
QQ-agent 主进程（唯一伙伴主体）
   ├─ 聊天 Orchestrator        ─┐
   ├─ 自主活动 autonomous      ─┼─→ Companion Core（组合根/端口）
   └─ 插件（未来/现有）         ─┘        │
                                          ├─ Memory Hub（只读聚合）
                                          ├─ companion/state（Goal/Pending/伙伴状态）
                                          ├─ diary（正文+meta）
                                          ├─ activity（autonomous Round/Action 只读视图）
                                          ├─ learned / memory（领域）
                                          └─ ChatStore（聊天历史）
```

- Core **不复制**状态、不直接写文件；只委托与协调；
- Memory Hub 是六层记忆唯一读取入口，不是第七层存储；
- DSH 接收 `companionText` 与上下文，不拥有伙伴状态；
- PROFILE 是运行隔离；当前单伙伴、单默认 PROFILE。

## 二、域职责（唯一维护者）

| 数据 | 唯一维护者 | 写入入口 | 读取入口 |
|---|---|---|---|
| learned | learned.js | learned API（admin/DSH 工具） | Memory Hub / DSH |
| 成员印象 | memory.js | memory API | MemoryStore.formatForPrompt / Hub |
| 日记正文+meta | diary 模块 | diary writer / Core.diary | Core.diary / DSH 只读 |
| Goal/Pending/伙伴状态 | companion/state.js | Core.goals/pending/state | Core.snapshot / autonomous |
| Round/Action/Activity | autonomous（history） | autonomous 领域 | Core.activity / Hub |
| 聊天历史 | ChatStore | store API | Core.context / store |
| token/usage 等 | 各自领域 | 各自 | 各自 |

## 三、4.0 变更

1. `Core.readChatSnapshot({chatKey})`：一次只读快照（state/prompt/goals/pending/activity/diary/memoryStats/context）；
2. 聊天 `wake` 经 Core 取 `companionText`（内部仍 `promptSection()`，字节不变）；
3. 日记增加 `readRawDay`，autonomous `readRecentDiary` 经 Core 读取（字节一致）；
4. 聊天日记写入、autonomous 状态/Goal/Pending/日记写删改级全部经 Core；
5. `createCompanionPorts(core,{allowWrite})`：插件最小端口，默认只读；
6. 领域内部仍可直接调用（如 memory.js→learned、dsh-gateway→learned、skills/diary→diary），不属于跨领域绕过。

## 四、并发/一致性

- 同域锁：companion `withState`、diary 文件锁、store 锁；
- Core 不做跨文件事务；跨文件操作仍由 outbox/Saga 领域机制负责；
- 快照是“某一时刻”的只读视图；聊天/自主并发写按域串行，不互相覆盖整个文件；
- reset barrier 仍由领域模块检查（Core 委托不绕过）。

## 五、明确不做（4.0）

- 不建设第二套存储、不把 ChatStore 并入长期记忆；
- 不改 prompt 文案/顺序、模型/参数/预算、自主调度、DSH Session；
- 不要求领域内部函数都调用 Core；只统一跨领域入口。

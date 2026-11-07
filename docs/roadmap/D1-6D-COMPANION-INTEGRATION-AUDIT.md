# D1-6D：统一伙伴核心集成审计（只读）

> 时间：2026-11-04
> 性质：只读源码调查；**未改 prompt、未改调度、未增加模型调用**
> 目标：确认是否存在重复状态、重复写入、绕过 Core 的读取路径

## 一、现状架构

```
                 ┌─────────────────────────────┐
                 │ companion-core/index.js      │ 门面（memory/state/goals/pending/diary/activity/context）
                 └───────────┬─────────────────┘
      ┌──────────────────────┼──────────────────────────┐
      │                      │                          │
 plugins/autonomous     chat/orchestrator          dsh-gateway
 (core.state/pending)   (直接 companion/state、     (learnedSnapshot、persona patch、
                        直接 diary/index、           companionText 由 orchestrator 传入)
                        this.memory)
```

- Memory Hub：`src/memory-hub/index.js`（read-only 聚合 learned/impression/diary/activity/companion）
- 持久状态：`companion-state.json`（`withState` 文件锁）
- 日记：`src/diary/index.js`（文件锁 + 原子写）
- 聊天存档：`src/store.js`（逐会话锁）

## 二、发现（按风险）

| # | 发现 | 证据 | 风险 | 判定 |
|---|---|---|---|---|
| 1 | **Core 门面存在，但仅 autonomous 使用** | `plugins/autonomous/index.js:38,40-45` 创建并使用 core.state/pending | 统一入口名存实亡，聊天路径完全绕过 | **高** |
| 2 | 聊天路径直接读 Companion State | `src/orchestrator.js:64,570` 直接 `companionPromptSection()` | 与 core.state.prompt 两套调用；未来改一处漏一处 | 中 |
| 3 | 聊天路径直接写日记 | `orchestrator.js:1063-1074` 直接 `diary/index.write` | 绕过 core.diary；与 autonomous 日记写入路径不同 | 中 |
| 4 | autonomous 仍直接 import companionState | `plugins/autonomous/index.js:37,46-48`（clearGoal/setGoal/bumpAskCount） | 同一状态两种入口；审计/锁策略可能分叉 | 中 |
| 5 | autonomous 直接写/删/改级日记 | `plugins/autonomous/index.js:52`（writeDiary/removeLine/relevel） | 绕过 core.diary 与 Memory Hub 写入口 | 中 |
| 6 | Core 的 memory/diary/activity/context 方法基本未被生产调用 | 仅 core.state/pending/goals 被 autonomous 使用；聊天不用 | 存在“未使用门面”，无法证明其行为与真实路径一致 | 中 |
| 7 | 记忆读取层多源 | Memory Hub 读 learned/impression/diary/activity/companion；DSH `learnedSnapshot` 另读日记；聊天 prompt 用 learned | 未来若把 hub 注入 prompt，可能重复注入 | 中（当前未重复） |
| 8 | Goal/Pending/Action/Activity 语义分散 | `companion/state.js` goals/pending；`autonomous.json` history.actions；`memory-hub/adapters.js` activity/goal/pending 统一成 item | 同名不同物（Action=自主行动，Activity=历史记录，Pending=待办） | 中 |
| 9 | 并发写入有锁，但无跨域事务 | `updateCompanion`（withState）、日记文件锁、chat 锁各自独立 | 聊天与自主同时写不同域可交错；同域有锁，不会文件级损坏 | 低 |
| 10 | 人格/状态不依赖 DSH Session | companion-state/learned/diary 均为文件；DSH 只承载对话连续性 | 新 Session 仍有同样人格/状态；prompt 独立 | **符合** |

## 三、八项重点核对

| 重点 | 结论 | 证据/说明 |
|---|---|---|
| 1. 聊天与自主读同一伙伴状态 | **是（同一文件）**，但入口不同 | 两者都最终读 `companion-state.json`；聊天直接 promptSection，自主走 core.state |
| 2. 日记/长期记忆/聊天历史边界 | 基本清晰，但存在交叉读取 | 日记=日记文件；learned=提炼经验；聊天=store；DSH learnedSnapshot 会扫日记提炼（只读） |
| 3. Goal/Pending/Action/Activity 语义 | 有分散，未统一 | Goal/Pending 在 companion-state；Action 在 autonomous history；Activity 是 history 聚合视图 |
| 4. 插件只通过领域接口 | **否** | autonomous 直接 import companionState 与 diary；无能力/端口隔离 |
| 5. 并发聊天/自主不覆盖状态 | 同域有锁，跨域无事务 | `withState` + 日记锁；最后写入按域独立，不会互相覆盖整个文件 |
| 6. 活动结果可被后续聊天检索 | 部分 | 自主 activity 通过 `buildAutonomousNote` 注入 DSH；Memory Hub `readActivities` 可检索；普通聊天 prompt 不直接读 hub |
| 7. 人格/行为状态不依赖某 DSH Session | 是 | 状态文件 + prompt 独立；DSH Session 只保存对话 |
| 8. 读 Memory Hub 不会重复注入/改 prompt | 是（当前） | 聊天/DSH 不调用 hub.search；hub 只读；无 prompt 变更 |

## 四、重复状态/重复写入结论

- **没有第二份状态副本**：companion state 只有 `companion-state.json`，日记只有日记文件，learned 只有 `learned.json`；
- **存在重复入口**：同一个文件既有 direct import，也有 core 门面；不是重复存储，但会导致行为分叉；
- **没有发现同一事件被双写**：聊天写日记走 orchestrator；自主写日记走 plugin；两条路径由不同触发器驱动，未见同一 action 双写；
- **活动结果**：autonomous history 是唯一来源；Memory Hub 只读聚合，不复制。

## 五、当前不能证明/UNKNOWN

1. 未做真实并发聊天+自主的端到端压力（仅有锁级测试）；
2. Core.memory/diary/activity 未在生产路径使用，行为一致性无法由现有测试证明；
3. DSH 内部是否缓存 persona patch 未验证；
4. 插件是否存在未搜索到的动态 import 路径（已静态扫描，未运行全插件）。

## 六、结论

统一门面已存在但**接线不完整**：autonomous 部分使用，chat 完全绕过，插件可直接访问领域模块。没有重复状态/重复写入证据；主要风险是“双入口漂移”和“未使用门面”。人格/状态不依赖 DSH Session，符合目标。

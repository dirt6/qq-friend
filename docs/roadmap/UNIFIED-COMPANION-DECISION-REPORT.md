# 统一 AI 伙伴架构决策 · 文档修订验收报告

> 时间：2026-11-03
> 性质：**架构决策 + 文档修订**；未修改生产代码、未改生产数据
> 决策文件：`docs/roadmap/ARCHITECTURE-UNIFIED-COMPANION.md`

---

## 一、新架构定义（一句话）

**小鲸鱼只有一个核心 AI 伙伴。聊天、自主活动和未来新增行为都是这个伙伴的不同活动方式，共同使用一套记忆和伙伴状态。PROFILE 只是运行隔离机制，不是伙伴身份。跨 PROFILE 记忆共享不属于当前建设范围。**

分层：

```
默认 PROFILE → QQ-agent 主进程（伙伴主体）
  ├── 聊天行为（收消息/上下文/模型回复/更新记忆）
  ├── 自主行为（空闲活动/兴趣/整理记忆/继续未完成/记录结果）
  ├── 未来行为（主动分享/自主学习/…）
  └── 统一伙伴核心（人设/Memory Hub/日记/Goal/Pending/Action/Round/兴趣/历史）
```

**QQ-agent 是伙伴主进程，DSH 只是它调用的推理工具**；DSH 推理子进程不是第二个 AI 伙伴。

---

## 二、修改的文件列表与原因

| 文件 | 修改 | 原因 |
|---|---|---|
| `docs/roadmap/ARCHITECTURE-UNIFIED-COMPANION.md` | **新增** | 正式架构决策记录（ADR）：伙伴定义、QQ-agent/DSH 区分、统一记忆 7 条、PROFILE 定位、现有工作定位、路线四步、禁止事项 |
| `docs/roadmap/ROADMAP-4.0-5.0.md` | 头部加架构决策注记；4.0 目标补"共享记忆 = 同一伙伴内"；R8 段加"同一伙伴"说明；约束表加第 10 条 | 让 4.0/5.0 路线与统一伙伴决策对齐，避免"共享记忆"被误读成跨 PROFILE |
| `docs/roadmap/MEMORY-DATA-MODEL.md` | 头部加"适用范围（单默认 PROFILE 的单个伙伴）" | 记忆模型只服务单伙伴；跨 PROFILE 共享不在范围 |
| `docs/roadmap/MIGRATION-PLAN.md` | 头部加"范围限定：不做跨 PROFILE 迁移/合并/同步" | 防止后续把迁移计划误用为多实例合并 |
| `docs/roadmap/IMPLEMENTATION-BATCHES-R6-R10.md` | R8 段加"同一伙伴的自主行为；R8-C 保留" | 明确 R8 定位，不新建第二套记忆 |
| `docs/roadmap/IMPLEMENTATION-BATCHES.md` | 头部加"早期草案；细化以 R6-R10 为准；跨 PROFILE 不在范围" | 旧批次文档与现行决策对齐 |
| `docs/roadmap/ROADMAP-ARCHIVE-3.0-5.0-v0.md` | 头部加"已被取代（2026-11-03）" | 按"标记废弃、不删历史"的要求处理旧路线 |

> **R8-M 跨 PROFILE 共享记忆计划**：全仓库检索 `R8-M` **无结果**，该计划不存在于当前文档/代码；无需删除，已在 ADR 明确"不建设"。

---

## 三、当前聊天与自主行为真实的记忆访问路径

> 以下来自代码只读检查（2026-11-03）。**不是设计，是现状。**

### 3.1 聊天

```
orchestrator.wake()
  ├─ companionPromptSection()      ← companion/state.js（读 Goal/Pending）
  ├─ prompt.buildUserPrompt()
  │    ├─ ctx.memory.formatForPrompt()  ← memory.js（MemoryStore，群友印象）
  │    ├─ store.recent() / peekUnread() ← store.js（聊天历史）
  │    └─ learned 写入：orchestrator → learned.addExperience()（经验库）
  └─ DSH 推理
```

### 3.2 自主活动（`plugins/autonomous`）

```
autonomous.runCycle()
  ├─ readCompanion() / goal / pending   ← companion/state.js
  ├─ readRecentDiary()                 ← 直接读日记 .md 文件
  ├─ writeDiary()                      ← diary/index.js（直接写）
  ├─ lastUserMessageAt() / readRecentChat() ← 直接读 data/messages/private_*.json
  └─ config / settings                 ← config.js
```

### 3.3 插件（qqzone / qq-self / moderation / tools）

```
ctx.store.recent() / findByMid()   ← 聊天存档（直接）
ctx.memory.append/query/remove()   ← MemoryStore（直接）
```

### 3.4 Memory Hub

`src/memory-hub/index.js` 提供只读 `search/get`，**但业务代码没有 import**（仅测试 `stage30r4-memory-hub-test` 调用）。`memory-hub/diary-write.js` 是日记写入口（R5），但 `plugins/autonomous` 仍直接 `writeDiary`。

---

## 四、尚未接入 Memory Hub 的行为与风险

| 行为 | 现状 | 风险 |
|---|---|---|
| 聊天读取 | 直接 `MemoryStore` / `store` | 检索规则分散，无法统一按可信度/时间过滤 |
| 自主读取 | 直接 `companion` / 日记文件 / messages | 与聊天口径可能不一致（例如印象、日记的可见范围） |
| 插件读取 | `ctx.store` / `ctx.memory` | 插件可绕过统一入口；未来新增行为会复制这套路径 |
| 日记写入 | `autonomous` 直写 `diary/index.js` | 与 Memory Hub 的 writer 并存，存在双写口径 |
| 记忆写入门禁 | R8-B 三态只在 learned 生效 | 其他层（memory/日记）没有同等的状态门禁 |

**结论**：Memory Hub 是"已建好、未接线"的读取层。统一入口检查（ADR 3.2 第一步）是后续工作，不是已完成状态。

---

## 五、R8-C 状态

- **保留，未启动**。
- 前置：R8-B 三态已完成（`105d4bf` / `0e6a560` / `a644e7b`）。
- 内容：记忆可信度、晋升、归档、检索策略。
- 约束：不得自动覆盖用户纠正过的内容；不得把 `unknown` 当已解决。
- 等待单独授权，本任务不启动。

---

## 六、3.0 / 4.0 / 5.0 路线调整结果

| 版本 | 原定位 | 调整后 |
|---|---|---|
| 3.0 | 记忆可信化（R2/R3 完成） | 不变；记忆模型标注"仅单伙伴" |
| 4.0 | 统一伙伴架构（R6/R7） | 明确"共享记忆 = 同一伙伴内"；PROFILE 仅运行隔离 |
| 5.0 | 长期自主伙伴（R8/R9/R10） | R8 是同一伙伴的自主行为；R8-C 保留；跨 PROFILE 不建设 |
| 旧版 | `ROADMAP-ARCHIVE-3.0-5.0-v0.md` | 标记"已被取代"，保留历史 |

---

## 七、仍然存在的架构缺口

1. **Memory Hub 读取未接线**：聊天/自主/插件都绕过它。
2. **记忆写入口分散**：learned / memory / diary / companion 各自为政；R5 只统一了日记 writer，autonomous 仍直写。
3. **缺少统一"伙伴核心"对象**：Goal/Pending/Round/Action 与聊天上下文没有共享的生命周期入口。
4. **PROFILE 边界未在代码层强制**：数据目录已隔离（R8-0），但跨 PROFILE 的记忆访问没有代码级禁止（靠目录隔离）。
5. **可信度/纠正门禁只覆盖 learned**：memory/日记没有同等门禁。

---

## 八、本次未做的事（边界自查）

- 未修改生产记忆数据、未迁移、未合并 PROFILE；
- 未修改 DSH Session 存储；
- 未修改自主调度、未启用 `selfWake`；
- 未删除多 PROFILE 隔离（R8-0 成果保留）；
- 未实现 Memory Hub 接入（只记录现状）；
- 未把设计写成已实现。

---

## 九、交付

- 文档修改独立 commit（见 git log）。
- 工作区状态：干净。
- 未触碰生产代码与 `data/`。

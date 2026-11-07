# COMPANION CORE 4.0 迁移报告（阶段 0–6）

> 时间：2026-11-04
> 起始 HEAD：`e9e7eba`
> 代码 commit：`6300c64`（Core/聊天/自主接线）
> 测试 commit：`1193ae6`（golden + 16 项）
> 测试隔离修复：见最终报告 "事故" 一节

## 阶段 0：基线与只读 parity

- 文档：`COMPANION-CORE-4.0-BASELINE.md`；
- golden：`test/fixtures/companion-4.0-prompt-golden.json`（empty/goal 字节 + SHA256）；
- 调用链、读取入口、空/缺失/损坏行为已记录；
- 验证：`test/companion-core-4.0-test` golden 2 项通过；未改 prompt/运行时。

## 阶段 1：聊天读取接入 Core

变更：

- `Orchestrator` 构造时创建 `this.core = createCompanionCore({chatStore: store})`（可注入）；
- `wake` 从 `this.core.readChatSnapshot({chatKey}).companionText` 取快照（内部仍 `companion.promptSection()`）；
- 删除对 `companion/state.js` 的直接 import。

验证：

- 空状态/有 Goal 状态 `companionText` 与旧入口**字节一致**（golden + 直接比对）；
- 不同 chatKey 的 companionText 一致（同一伙伴主体）；
- 未改 system prompt 拼接顺序/其他字段。

## 阶段 2：自主活动读取接入 Core

变更：

- autonomous 删除 `companionState` 直接 import；`clearGoal/setGoal/bumpAskCount` 经 `core.goals`；
- `readRecentDiary` 改经 `core.diary.readRaw`（diary 新增 `readRawDay`，返回原文字节）；
- 日记写/删/改级经 `core.diary.*`；
- `autonomous.json` 的 Round/Action 仍由 autonomous 领域维护；
- `private_*.json` 直读保留为**兼容例外**（ChatStore 历史，插件未注入 store）。

验证：

- `readRecentDiary` 与旧 fs 读取字节一致（专项）；
- autonomous-test 97/0；companion-core-integration 12/12；
- 未改调度/模型调用。

## 阶段 3：统一写入协调

变更：

- 聊天日记写入 → `core.diary.write`；autonomous 写/删/改级 → Core；
- Core 仅委托，不写文件；领域模块仍是唯一维护者；
- learned/impression/chat store 仍走各自领域管理入口（admin/DSH/Store）；
- 跨文件仍由 outbox/Saga 领域机制负责，Core 不声称事务。

验证：

- diary 幂等（同内容重复写仅 1 行）；
- 并发 pending 写入可读、无文件损坏；
- reset barrier 由领域模块检查，Core 不绕过。

## 阶段 4：Goal/Pending/Action/Activity 语义

- 沿用既有领域规则：Goal 长期方向；Pending 具体事项；Round/Action 在 autonomous history；
- Activity 是只读聚合视图，不单独存储；
- 新增测试：读取 Activity 不改变 Goal 数量；一次 Action 不会自动成为 Goal；
- 旧 `companion-core-test`（18）与 integration（12）覆盖 Goal 终态/权限/重复；
- 未改生产历史数据。

## 阶段 5：插件端口

- 新增 `createCompanionPorts(core,{allowWrite})`：memory/state/goals/pending/activity/diary；
- 默认只读；`allowWrite:true` 才有 diary 写方法；端口不含 fs/路径；
- autonomous 已直接使用 Core；旧插件/技能保留兼容（skills/diary 直接 diary 写为领域工具）。

## 阶段 6：直接入口收口

保留的直接入口：

| 入口 | 分类 | 理由/退出条件 |
|---|---|---|
| `dsh-gateway.js → learned` | 领域/DSH 工具 | DSH 推理工具读写经验，非伙伴跨域入口；保持 |
| `routes.js → learned` | 管理 API 领域 | UI 管理 learned；保持 |
| `memory.js → learned` | 领域内部 | 印象修正状态；保持 |
| `memory-hub/adapters → learned` | Hub 领域 | 只读聚合；保持 |
| `skills/diary → diary/index` | 技能兼容适配器 | 领域工具直接写日记；后续可走 ports，当前行为不变 |
| `autonomous → private_*.json` | 兼容例外 | 插件未注入 ChatStore；后续通过 Core.context/端口迁移 |

- 新增代码无第二套状态/双写；
- 未为“零直接访问”破坏领域边界。

## 阶段 7：集成测试

见 `COMPANION-CORE-4.0-TEST-REPORT.md`（16/16 + 既有 18/12/97 + 全量 82）。

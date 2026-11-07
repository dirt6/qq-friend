# COMPANION CORE 4.0 最终报告

> 时间：2026-11-04
> 起始 HEAD：`e9e7eba`
> 最终代码 HEAD：`1248d35` + 本报告 commit
> 工作区：最终 commit 后干净
> 范围：阶段 0–7 连续实施；未部署生产、未重启、未 reset、未改配置/prompt/调度/预算/DSH Session

## 一、提交

| 内容 | commit |
|---|---|
| Core 快照/委托 + 聊天/自主接线 | `6300c64` |
| prompt golden + 16 项专项 | `1193ae6` |
| autonomous-test 隔离修复（事故） | `1248d35` |
| 4.0 六份文档 | 见最终 commit |

## 二、核心调用链（最终）

### 聊天

```
Orchestrator.wake
  → this.core.readChatSnapshot({chatKey})
      → companion.readCompanion / promptSection（companionText，字节不变）
      → activeGoal/pausedGoals/activePending
      → diary.readDay(today)
      → readActivities（只读视图）
      → memoryHub.stats
      → chatStore.recent（可选）
  → buildSystemPrompt(extraSections: companionText)
  → buildUserPrompt(memory: MemoryStore.formatForPrompt)
  → #askDsh(companionText) → dsh-gateway
  → 日记写：core.diary.write → diary/index → writer
```

### 自主活动

```
autonomous
  → core.state/pending/goals（读与写）
  → core.diary.readRaw/write/removeLine/relevelLine
  → autonomous.json history[].actions（Round/Action 领域写入）
  → 兼容例外：DATA_DIR/messages/private_*.json（ChatStore 历史直读）
```

### 插件

```
createCompanionPorts(core,{allowWrite:false|true})
  → memory/state/goals/pending/activity/diary
  → 无 fs/路径；写方法需显式 allowWrite
```

## 三、数据唯一维护者

| 数据 | 唯一维护者 |
|---|---|
| learned | learned.js |
| 成员印象 | memory.js |
| 日记正文/meta | diary 模块 |
| Goal/Pending/伙伴状态 | companion/state.js |
| Round/Action/Activity | autonomous（history） |
| 聊天历史 | ChatStore |
| Memory Hub | 只读聚合，不存储 |

## 四、保留的兼容入口

1. `autonomous → private_*.json`：插件未注入 ChatStore；后续通过 Core.context/端口迁移，当前行为不变；
2. `skills/diary → diary/index`：领域技能直接写日记；后续可走 ports；
3. `dsh-gateway → learned`、`routes → learned`、`memory.js → learned`、`memory-hub → learned`：领域/管理/DSH 工具内部，保留；
4. Core 委托领域模块，不直接写文件。

## 五、测试

| 项 | 结果 |
|---|---|
| 4.0 专项 | **16/16** |
| Core 旧测试 | 18/18 |
| Core 集成 | 12/12 |
| autonomous | 97/97（隔离修复后） |
| 全量 | **82 项：78 PASS / 4 FAIL**（既有基线） |
| prompt parity | empty/goal 字节+SHA256 一致；readRecentDiary 原文一致 |
| 并发/隔离 | pending 并发可读、diary 幂等、端口只读、临时目录 |

## 六、生产 hash 与事故（重要）

4.0 开始时（`e9e7eba`）与结束时：

| 目标 | 开始 | 结束 | 归因 |
|---|---|---|---|
| memory | `ee772eb3…` | `ee772eb3…` | 未变 |
| 日记 | `1ec13e8a…` | `1ec13e8a…` | 未变 |
| sessions | `4d1f43d7…` | `4d1f43d7…` | 未变 |
| learned | `b12d3e62…` | `b12d3e62…` | 未变 |
| pending | `01c2a25d…` | `c0a379cf…` | **测试事故写入 2 条 completed 10-20 记录（21:39:59）** |
| idem | `3f6f12eb…` | `3cb7f9f2…` | **同事故新增 2 条 10-20 幂等键** |
| DSH 映射 | `49078d2c…` | `49078d2c…` | 未变 |
| dsh-home | `9e9d17cd…` | `9e9d17cd…` | 未变 |
| reset 备份 | 不存在 | 不存在 | 未 reset |

**事故**：全量回归的 `test/autonomous-test.mjs` 只隔离日记 root，未隔离 `QQ_AGENT_DATA_DIR`；`appendDiaryLine` 向生产 pending/idem 写入 2 条 completed 测试记录。**不是 4.0 业务代码写入，也不是机器人业务写入**。

**已做**：测试在导入插件前设置临时 `QQ_AGENT_DATA_DIR` 并动态 import；复跑 97/0；生产 pending/idem hash 前后一致。**未回滚/删除**生产记录（需单独授权）。

## 七、4.0 完成标准评估

| 标准 | 结果 |
|---|---|
| 聊天与 autonomous 伙伴状态读取规则统一 | PASS（同一 Core 快照/prompt；不同 chatKey 同主体） |
| 主要跨领域访问经 Core | PASS（state/goals/pending/diary）；例外已列出 |
| 领域数据唯一维护者 | PASS |
| Goal/Pending/Action/Activity 语义一致 | PASS（既有规则+边界测试） |
| 插件统一能力接口/兼容策略 | PASS（ports；旧技能/插件例外） |
| 无重复状态副本/双写 | PASS（审计未发现） |
| prompt 行为兼容 | PASS（golden 字节/hash） |
| 调度/预算/DSH Session 未变 | PASS（未改配置/调用策略） |
| 集成测试通过 | PASS（82/78/4 既有基线） |
| 剩余例外有原因/方案 | PASS（见 §四） |
| 完整 diff 已审查 | PASS（`git diff --check`/diff review） |
| 生产数据未被本轮开发工具误写 | **FAIL**（§六事故） |

**结论**：4.0 架构实现与集成测试完成；但按本任务书完成标准，**不能无条件宣布 4.0 完成**——唯一未满足项是测试隔离缺陷导致的生产 pending/idem 写入。该写入是 2 条 completed 测试记录，无正文/会话/DSH 变化；处置需用户授权（保留/标注/清理）。

## 八、未完成 / INCONCLUSIVE

- 生产新 UI/API 未部署（需重启授权）；
- 真实浏览器渲染、symlink/ACL/磁盘满/Electron 窗口/asar 仍 UNKNOWN（D1-6B/A）；
- autonomous `private_*.json` 直读为兼容例外；
- 无真实多进程聊天+自主压力测试；
- DSH 内部 persona 缓存未验证。

## 九、进入 5.0 前

1. 先处理本次生产写入事故（用户决定保留/标注/清理；任何清理需授权）；
2. 把 autonomous `private_*.json` 迁移到 Core.context（需插件注入 ChatStore，行为 parity）；
3. skills/diary 迁移到 ports（可选）；
4. 在可用 Chromium/ACL 环境补 D1-6 UNKNOWN；
5. 生产部署/重启另行授权；
6. 5.0（Purpose Engine/Closure/主动策略）在 4.0 事故收口后立项，不扩大本批范围。

# COMPANION CORE 4.0 基线（阶段 0）

> 时间：2026-11-04
> HEAD：`e9e7eba`（实施前）；工作区干净
> 性质：只读基线；未改 prompt/调度/模型/生产数据
> 生产 hash：实施前已因机器人正常活动变化（D1-6 报告已归因），本阶段未写生产

## 一、实施前调用链

### 聊天

```
app → Orchestrator.wake(chatKey)
  → companion.promptSection()                     [直接读取]
  → buildSystemPrompt({ extraSections: companion })
  → buildUserPrompt({ memory: this.memory })      [MemoryStore.formatForPrompt]
  → #askDsh({ companionText })
      → dsh-gateway.personaPatchFile(..., companionText)
      → learnedSnapshot() 读 learned/日记            [领域只读]
  → ChatStore.recent / append                     [领域]
```

### 自主活动

```
plugins/autonomous
  → companionCore.state.get()/pending.active()/goals.*   [部分经 Core]
  → companionState.clearGoal/setGoal/bumpAskCount        [直接读取，4.0 前]
  → writeDiary/removeLine/relevel                         [直接 diary]
  → readRecentDiary → fs.readFileSync                     [直接读日记原文]
  → DATA_DIR/messages/private_*.json                      [直接读聊天历史]
  → autonomous.json history[].actions                     [Activity/Round 领域]
```

## 二、读取入口标记（4.0 前）

| 数据 | 聊天 | 自主 | 标记 |
|---|---|---|---|
| Companion State | `promptSection()` 直接 | `core.state` + 直接 `companionState` | 直接 + Core |
| Goal/Pending | 不直接读 | Core + 直接 | 直接 + Core |
| 日记正文 | 不读 | `readRecentDiary` 直接 fs | 直接 |
| 日记 meta | 不读 | 不读 | — |
| learned | DSH `learnedSnapshot` 读文件 | 不直接 | 领域只读 |
| 成员印象 | `this.memory` / formatForPrompt | 不直接 | 领域 |
| 聊天历史 | ChatStore 直接 | `private_*.json` 直接 | 领域 + 直接 |
| Activity/Round | 无 | `autonomous.json`（领域） | 领域 |
| Memory Hub | 不注入 | 不直接（Core.memory 可用） | 未使用 |

## 三、旧行为（空/缺失/损坏/失败）

- 空 companion state：`promptSection()` 返回空串（golden `empty`）；
- companion-state 缺失/损坏：`readCompanion` 返回默认状态，`promptSection` 空串；聊天继续；
- 日记缺失：`readRecentDiary` 跳过该日；`readDay` 返回 `[]`；
- 聊天历史缺失：`private_*.json` 读取抛错时自主路径按无数据处理；
- 自主 Core 初始化失败：抛 `ECOMPANION_CORE_INIT`（原有约束）。

## 四、Golden fixture

`test/fixtures/companion-4.0-prompt-golden.json`：

| case | 文本 | SHA256 |
|---|---|---|
| empty | `""` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| goal | `【你现在】\n现在的方向：D1-7 统一伙伴架构` | `f0279e3d4e1dfe998f707bf5567780b7d30598a6198fa55f8fac0715e516b1aa` |

`test/companion-core-4.0-test.mjs` 逐字节比对；不修改 fixture 掩盖差异。

## 五、基线结论

- 聊天与自主确实存在**双入口**（尤其 companion state、日记原文）；
- 无重复状态副本；Activity/Round 由 autonomous 唯一维护；
- 4.0 目标：把跨领域读取/写入统一到 Core，同时保持领域模块唯一维护者与 prompt 字节不变。

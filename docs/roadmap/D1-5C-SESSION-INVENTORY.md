# D1-5C：DSH Session 清单

> 时间：2026-11-04
> 性质：只读；**未隔离/删除/移动任何生产 Session，未终止进程，未改映射**
> 范围：本项目 `--E-dsh-QQ-agent--` 的 10 个孤儿 + 1 个映射中 Session；外部项目 `--E-dsh--` 单独列出、不纳入本项目计划。

## 一、逐条清单

| Session ID | 创建（birth） | 最近修改 | 年龄 | 大小 | 本地映射 | 聊天引用 | Companion/Goal 引用 | 本地 Session 引用 | 可恢复备份 | 状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| `session-00d07d97-…` | 10-31 08:41Z | 10-31 08:41Z | 4.2d | 27,271B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-372fc8ee-…` | 10-31 08:47Z | 10-31 08:47Z | 4.2d | 10,363B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-44163cb5-…` | 10-31 08:50Z | 10-31 08:50Z | 4.2d | 23,851B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-73416e99-…` | 10-31 08:47Z | 10-31 08:47Z | 4.2d | 20,082B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-78e240cf-…` | 10-31 08:05Z | 10-31 08:05Z | 4.2d | 21,243B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-8050a49f-…` | 10-31 08:45Z | 10-31 08:45Z | 4.2d | 19,953B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-b1268be4-…` | 10-31 08:51Z | 10-31 08:51Z | 4.2d | 53,341B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-bf7952ef-…` | 10-31 08:46Z | 10-31 08:46Z | 4.2d | 66,512B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-ea427e73-…` | 10-31 08:51Z | 10-31 08:51Z | 4.2d | 15,686B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-f7cdd460-…` | 10-31 17:45Z | 10-31 17:45Z | 3.8d | 10,677B | 无 | 无 | 无 | 无 | 无 | unmapped_project_owned |
| `session-2de90a0a-…` | 10-28 12:42Z | 10-28 12:42Z | 7d | 23,304,707B | `private:1846383180` | 有 | 无 | 无 | 无 | mapped_active |
| `session-30465ba3-…`（外部 `--E-dsh--`） | 10-31 09:03Z | 10-31 09:03Z | 7d | 13,524B | 无 | 无 | 无 | 无 | 无 | external |

> 所有 Session 目录仅含 `session.v4.jsonl.zstd`（zstd 内容未解析）；10 个孤儿均为 10-31 同一时段创建的小会话。

## 二、判定依据

- **项目归属**：目录位于本项目 `data/dsh-home/sessions/--E-dsh-QQ-agent--/`；外部项目目录 `--E-dsh--` 单独排除；
- **本地映射**：`dsh-sessions.json` 中无这些 sid（仅 `private:1846383180 → session-2de90a0a…`）；
- **聊天引用**：无 `data/messages` 对应文件引用；
- **Companion/Goal/Pending/Action**：`companion-state.json`/`autonomous.json` 字符串无 sid；
- **本地 Session 引用**：深度扫描 `data/sessions/*.json` 无 sid；
- **可恢复备份**：`data/dsh-home/.session-backups/<sid>/manifest.json` 不存在；
- **进程**：无持久子进程注册表 → `process_unknown`；未发现锁/句柄证据。

## 三、状态与隔离资格

- 10 个孤儿：`unmapped_project_owned`，但**全部不满足 quarantine_candidate**：
  - 年龄 4.2/3.8 天 < 7 天阈值；
  - 无可验证备份；
  - 进程归属 unknown；
  - zstd 内容 unknown（无法证明无价值）；
- `session-2de90a0a…`：`mapped_active`，永不自作主张隔离；
- `session-30465ba3…`：`external`，不属于本项目，**不纳入**本项目计划；
- 计划：**quarantine=0，manual=10**（全部需人工/先补备份）。

## 四、工具与测试

`scripts/session-inventory.mjs`：只读清单 + `planSessionQuarantine`；带 manifest/hash 的 `quarantineSessionOwned` / `restoreOwnedQuarantine` 仅供隔离测试；
`test/session-inventory-test.mjs`：**8/8**（状态分类、备份/引用/年龄门槛、映射拒绝、隔离/恢复 hash、冲突、只读性）。

## 五、结论

10 个本项目孤儿均为项目内、无映射、无引用的小型 Session，但**当前不满足隔离条件**（未满 7 天、无备份、进程/内容 unknown）。本批不隔离任何生产 Session；外部项目不处理。

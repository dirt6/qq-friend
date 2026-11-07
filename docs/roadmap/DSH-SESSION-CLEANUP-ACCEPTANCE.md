# DSH Session 清理/恢复验收（隔离）

> 时间：2026-11-04
> 方式：隔离 fixture + 真实文件移动；**未在生产隔离/删除任何 Session，未终止进程**
> 结果：专项 **8/8 通过**；生产只读审计完成，计划不动作。

## 一、专项测试（`test/dsh-session-audit-test.mjs`，8/8）

| 检查 | 结果 |
|---|---|
| 映射缺失、孤儿、重复映射、无本地聊天、闲置映射、本地僵尸 | PASS |
| 只读性：审计前后 DSH 目录树 hash 不变 | PASS |
| 计划：仅“本项目 + 未映射 + 超期”进入 quarantine；映射/外部/新目录不入选 | PASS |
| dryRun 不移动 | PASS |
| 映射引用中的 Session 拒绝隔离 | PASS |
| orphan 同卷移动到 quarantine、源消失、审计写入 | PASS |
| 恢复回原路径、内容树 hash 不变 | PASS |
| 目标已存在时恢复拒绝覆盖 | PASS |

## 二、生产只读审计（不改数据）

```
映射=1  会话目录=12  被引用=1
critical=0  warn=11（全部 dsh_orphan_session）  info=0
默认计划：quarantine=0  manual=1（外部项目 --E-dsh--，人工确认）
```

- 唯一映射：`private:1846383180 → session-2de90a0a-…`；
- 10 个孤儿属 `--E-dsh-QQ-agent--`（约 4 天未改），1 个属 `--E-dsh--`（外部项目，约 7 天）；
- **未执行任何隔离/删除/进程终止**；`dsh-sessions.json` 与 `dsh-home` hash 未变。

## 三、已验证 / 未验证

**已验证**：只读审计六类异常、项目过滤、映射引用保护、quarantine 同卷移动（不删除）、restore 冲突拒绝与 hash 不变、审计记录。

**未验证 / 限制**：
- DSH zstd 内容未解析（无法证明孤儿“无价值”）；
- 进程归属 `unknown`；未实现/未验证任何 kill 方案（设计为多因子 + fail-closed）；
- 映射重建/清空聊天联动未改（人工方案，见 Recovery Design）；
- 外部项目 `--E-dsh--` 未处理（人工）；
- 生产未执行清理（未授权）。

## 四、残留风险

1. 孤儿 Session 长期占用磁盘（当前 11 个目录；大小未统计到本报告）；
2. “清空聊天后仍复用旧 DSH session”语义未变；
3. 进程异常退出后可能残留持锁子进程（无可靠 kill 方案）；
4. 生产 CLI 不提供 apply，后续若需要清理，必须：
   - 先备份 `dsh-sessions.json`；
   - 人工确认项目归属与候选清单；
   - 只做 quarantine（可恢复），不直接删除；
   - 记录 planHash/审计。

## 五、下一步依赖

- P3 清理依赖“DSH 侧确认目录语义/可验证删除接口”或“人工确认项目归属”；
- 清空聊天联动依赖 UI/产品授权（独立入口）；
- 进程所有权实现依赖 Windows 启动时间/命令行读取的可靠方案（本批未实现）。

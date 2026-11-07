# D1-4 P1–P3 汇总：结果、依赖与风险

> 时间：2026-11-04
> 范围：P1 幂等告警复核、P2 备份保留、P3 DSH Session 治理
> 性质：只读调查 + 设计 + 隔离实现/测试；**未执行生产清理/删除/隔离、未终止进程、未重启、未 reset**

## 一、提交

| 批次 | commit |
|---|---|
| P1 11 条告警逐条复核 | `4f45525` |
| P1 审计工具升级 | `6505078` |
| P2 备份策略 + inspect/plan/隔离 archive/delete | `3b99ddf` |
| P3 DSH 审计 + 隔离 quarantine/restore + 三份设计/验收文档 | `25f3d5f` |

## 二、P1 结果

- 11 条告警：**confirmed_consistent 10 / historical_unverifiable 1 / confirmed_anomaly 0**；
  - 测试残留 3（`source=test`）；
  - 重复键/测试写入 4（10-20 同 day+hash 两种键形态，正文无对应测试行）；
  - 合并改写 3（20b1/ce44/e762，后继 `d9fd6fea…`，事件+正文 hash 对上）；
  - `d9fb…`：事件与 `.trash` 证明曾写入，后续消失且无删除记录 → historical_unverifiable；
- 工具升级：hash 优先、12 字族合并链、测试残留/重复键分类；
- 生产只读审计从 `0/11/17` 变为 **`0 critical / 5 warn / 24 info`**（4 条重复键 + 1 条 historical；测试残留/合并链转入 info）；未改任何生产数据。

## 三、P2 结果

- 策略：`BACKUP-RETENTION-POLICY.md`（来源/状态/保留规则/保护/审计/失败恢复）；
- 工具：`scripts/backup-retention.mjs`——inspect（reset/memory/chat/learned/sessions/diary.trash）、plan（最低完整/时间/数量/容量；恢复锁全保护）、apply（默认 dryRun；archive 同卷移动；delete 仅归档副本；失败保留 + 审计）；
- 专项 **10/10**：只读巡检、restore 锁保护、corrupted/unknown 不入选、archive/delete、注入失败保留、审计；
- 生产只读巡检：仅 **13 个 diary `.trash`（unknown，永久保护）**；reset/memory/chat/learned/sessions 备份均为 0；无清理候选，未执行清理。

## 四、P3 结果

- 只读审计：`scripts/dsh-session-audit.mjs`（映射缺失/孤儿/重复映射/无本地聊天/闲置/本地僵尸；`processOwnership=unknown`，不依赖 PID 判归属、不 kill）；
- 隔离流程：plan 仅“本项目 + 未映射 + 超期”进入 quarantine；quarantine/restore 同卷移动、不删除、映射引用拒绝、冲突拒绝、审计；专项 **8/8**；
- 生产只读审计：**1 个映射 / 12 个会话目录 / 11 个孤儿**（10 个本项目约 4 天、1 个外部项目 `--E-dsh--` 约 7 天）；默认计划 **quarantine=0，manual=1（外部项目人工确认）**；
- 未删除/隔离任何生产 Session、未终止进程、未改 `dsh-sessions.json`。

## 五、全量回归

**77 项：71 PASS / 6 FAIL**。4 项既有基线（`selftest`、`tools-skill-audit`、`gallery-test`、`setup-qq-version` 偶发）；2 项环境偶发：

- `learned-concurrent-test`：首次 EPERM 打开 `.lock`；单独复跑 **3/3 通过**；
- `deploy-acceptance-test`：首次 POST reset 200/data 删除断言失败；单独复跑 **17/17 通过**；
- 首次失败均保留，未改判 PASS、未改代码掩盖；后续需关注高负载下测试互扰。

## 六、生产数据核对（含正常业务写入）

| 目标 | 变化 | 说明 |
|---|---|---|
| memory | `ee772eb3…` 不变 | 工具未写 |
| 日记树 | `fb5cfac7…` 不变 | 未补写/删除 |
| pending | `ca880159…` 不变 | 未改 |
| idempotency | `96d610c4…` 不变 | 未删键 |
| learned | `af040667…` → `f9f754a9…` | **机器人 20:56:01 正常对话更新 hits/lastUsedAt**（mtime 一致），非工具写入 |
| sessions | `11f52253…` → `ff13eb83…` | **机器人 20:56:30 新增 1 个会话文件**（1526→1527），非工具写入 |
| DSH 映射/目录 | `42bb56e8…` / `4147b1b0…` | 只读审计；未改 |
| reset 备份 | 不存在 | 未 reset |

> 两个 hash 变化已定位到运行中的机器人正常业务写入；本批所有工具对生产只读。

## 七、下一阶段依赖关系

```
P1（告警语义稳定）
  └─ 依赖：无（已完成）；后续若修数据需单独授权
P2（保留策略）
  ├─ 依赖 P1 的只读审计稳定性（避免误清）
  ├─ 生产 apply 依赖：独立授权 + 备份盘余量确认 + 先 quarantine 而非 delete
  └─ 依赖：sessions/chat/learned 备份 manifest 化（当前 sessions 无 manifest → unknown 保护）
P3（DSH 治理）
  ├─ 生产 quarantine 依赖：确认项目归属（本项目 vs --E-dsh--）+ 备份 dsh-sessions.json
  ├─ 清空后复用依赖：产品/UI 授权（显式「重置 DSH 会话」入口）
  └─ 进程终止依赖：Windows 进程启动时间/命令行/ nonce 的可靠所有权验证（当前 UNKNOWN，fail-closed）
```

## 八、风险清单

1. **P1**：5 条 warn 仍未消除（4 重复键 + 1 historical），工具按启发式分类，人工复核仍需进行；
2. **P2**：生产 13 个 diary `.trash` 永久保护（无 manifest，无法自证）；备份保留未在生产启用；
3. **P2**：sessions 备份无 manifest，按 unknown 保护，无法自动清理；
4. **P3**：11 个孤儿 Session 占用磁盘；`--E-dsh--` 外部项目不能自动处理；
5. **P3**：清空聊天仍复用旧 DSH Session（语义未改）；进程异常退出可能残留持锁子进程，无可靠 kill；
6. **回归**：高负载下 `learned-concurrent` / `deploy-acceptance` 出现 EPERM/超时类偶发；需在低负载或隔离资源下复跑确认稳定性；
7. 生产机器人持续写入 learned/sessions，后续 hash 对比需按“业务写入”解释，不能当作工具副作用。

## 九、结论

P1–P3 的只读调查、设计、隔离实现与测试完成；生产未执行任何清理/删除/隔离/终止/reset。下一阶段若要动生产，必须先取得单独授权，并按 P2/P3 的 quarantine/人工确认/审计流程执行。

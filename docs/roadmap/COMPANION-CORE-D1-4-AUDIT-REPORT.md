# D1-4 审计报告：数据生命周期与只读一致性

> 时间：2026-11-04
> 性质：只读审计 + 工具；**未修复/删除/迁移任何生产数据**
> 结论：生产一致性审计 **0 critical / 11 warn / 17 info**；无自动修复。

## 一、交付

- 设计：`COMPANION-CORE-D1-4-DATA-LIFECYCLE.md`（14 类资产、三语义、硬规则）；
- 工具：`scripts/data-consistency-audit.mjs`（只读；`--json`/`--deep-backup`/`--fail-on`）；
- 专项：`test/data-consistency-audit-test.mjs`（9/9）。

## 二、工具检查项

| 类别 | 检查 | 级别 |
|---|---|---|
| 正文/meta | 有正文无 meta（meta 开关关闭时属预期）、meta 无正文、meta 损坏、条目 stale、paragraphIndex 越界、quoteHash 与正文不一致 | info/warn |
| pending | 未完成数量/阶段/年龄（超 `--max-pending-hours`）；文件损坏 | warn/info；critical |
| 幂等键 | pending 且正文无行、pending 且正文已有行、done 但正文找不到行、day 文件缺失、记录缺 day | info/warn |
| sessions | running/waiting 超期（`--max-session-days`）、文件损坏、索引缓存缺失/引用不存在 | warn/info |
| DSH | 映射的 sessionId 在 `dsh-home/sessions` 找不到、映射无本地聊天文件 | warn/info |
| 备份 | reset manifest 不可读/自校验失败（critical）、`--deep-backup` 逐文件 hash、会话备份空目录 | critical/warn |
| 只读性 | 测试断言审计前后文件内容一致 | — |

## 三、生产只读审计结果（2026-11-04 20:3x）

```
critical=0  warn=11  info=17
```

- **critical=0**：pending 可读、幂等表可读、现有 reset 备份 manifest 无损坏（当前无 reset 备份）；
- **warn=11：全部为 `idem_done_line_missing`**（done 但正文找不到对应行/前 20 字）。分类：
  - 3 条为 2026-11-03 测试写入（`source=test`：第一条/同步成功条目/未启用条目），正文本就没有；
  - 2 条为 2026-10-20 的重复键（同 hash 两个 key，历史测试/迁移造成）；
  - 其余为 `merged=true` 的自主日记：记录行在后续合并/改写后不再精确匹配，属**审计启发式**告警，不等于数据损坏；
  - **未做任何修复**；需要时由人工逐条核对（可结合 B4/调查方法）；
- **info=17：`meta_missing`**，与既有状态一致（meta 写入开关关闭），按授权**不批量处理**。

## 四、三语义落地状态

| 语义 | 已有实现 | 本阶段动作 |
|---|---|---|
| expire | diary-meta `stale` 标记；idempotency 30 天键清理；image-cache 配额淘汰 | 只定义与审计，不扩大自动过期范围 |
| archive | learned `archiveStale`（archived 状态）；companion 事件 90 天 gzip；sessions 留档 | 只审计；终态 Goal/会话不默认删除 |
| delete | chat clear/delete、learned 单条、memory remove、sessions 用户删除、reset（跨目录备份） | 已有备份/锁/审计；本阶段不新增删除入口 |

**硬规则核对**：重要日记无按时间删除路径；未完成 pending/outbox 不会被自动清理（B2/B5/B6 已验证）；终态 Goal 无默认删除路径。

## 五、测试与回归

- `data-consistency-audit-test`：**9/9**（干净场景、正文/meta 三类、pending 超期、幂等三态、sessions 僵尸/缓存、DSH 孤儿、备份 manifest 损坏、损坏 pending critical、只读性）；
- 全量：**75 项，71 PASS / 4 FAIL**（`selftest`、`tools-skill-audit`、`gallery-test` 既有基线失败；`setup-qq-version` 既有偶发）；新增 `data-consistency-audit-test` 通过，其余相关用例全过。

## 六、残留风险 / 未做

1. `idem_done_line_missing` 是启发式（精确行或前 20 字匹配），合并/改写会误报；工具不自动修复；
2. `--deep-backup` 默认关闭（全量 hash 可能较慢）；reset 备份保留策略仍未实现；
3. DSH 孤儿检测只查目录名，不解析 zstd 内容；`dsh_session_missing` 在 `dsh-home` 不存在时不告警（避免误报）；
4. sessions 僵尸检测依赖 `startedAt` 字段；旧文件缺字段时不做判定；
5. 未实现 expire/archive/delete 的新接口；后续必须落在各领域模块（不新增通用文件操作）；
6. 生产 17 条 meta_missing 与 11 条 warn 均保持原样。

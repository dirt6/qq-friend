# D1-3c / D1-3d / D1-4 总体验收报告

> 时间：2026-11-04
> 授权范围：只读调查、文档/设计、隔离实现与测试、故障注入、只读审计；**不含生产 reset、不含生产 Electron 重启、不含生产配置/NapCat/DSH 变更**
> 结论：三批工程工作完成；生产数据 hash 未变；生产 reset 未执行。

## 一、批次与 commit

| 批次 | 内容 | commit |
|---|---|---|
| D1-3c C1 | 部署只读预检（运行实例 vs 仓库） | `32c3eb1` |
| D1-3c C2 | 可复现部署清单/回退方案 | `33b92a3` |
| D1-3c C3/C4 | 隔离启动验收 17 项 + 生产部署报告 | `80251d1` |
| D1-3d 设计 | reset 安全专项场景矩阵 | `0a5931f` |
| D1-3d 实施 | 恢复中途失败语义 + 隔离演练 24 项 | `9c30266` |
| D1-4 设计 | 数据资产生命周期/三语义 | `d4858b5` |
| D1-4 实施 | 只读一致性审计工具 + 生产审计 | `29ad869` |

## 二、D1-3c 结论

- **实际基线**：HEAD `792beed`（比任务书 `0156c98` 多一个 docs 调查提交，无运行时代码差异）；工作区干净；
- **运行实例**：20:26:54 由机主重启（本会话未重启），PID `25300`，20:26:58 监听 3210；最新运行时代码 mtime 20:01 < 启动，工作区无未提交代码 → **已加载当前 HEAD 运行时代码**；`/api/version=0.4.0`、`/api/reset-data/preflight` 200；
- **C2**：`deploy-manifest.mjs` 生成 254 文件 / 4.74MB 代码 hash 清单（不含 data/）+ 生产关键 hash/计数 + 回退 ref（运行时回退点 `0156c98`）；`--verify` 可检测缺失/多余/hash 不符；
- **C3**：隔离 bootApp 验收 **17/17**（版本/UI/preflight 门禁/屏障/隔离 reset 备份 manifest+逐文件 hash/日记保留/日志）；
- **C4**：新版本已在生产运行，部署物与验收就绪；后续重启/生产 reset 仍需独立授权。

## 三、D1-3d 结论（24/24）

已验证：preflight 5 类拒绝；manifest v2 自校验 + 逐文件 hash；**真实 junction** 不跟随；Windows 文件句柄占用 → `needs_manual_recovery` 后 resume；模拟 I/O/权限失败 → 不删除；写入屏障/备份后并发写拒绝；真实子进程删除崩溃 → resume；**完整恢复 8/8 文件 hash 一致**、空目录重建、日记未动、审计；损坏备份/目标冲突拒绝；恢复中途失败 → `ok:false/needsManual/partial`，不自动回滚。

未验证/INCONCLUSIVE：文件 symlink（Windows 权限不足，已标 INCONCLUSIVE）；真实磁盘满（用注入失败模拟，标 UNKNOWN）；junction/symlink 恢复未实现（已知限制）。

## 四、D1-4 结论

- 完成 14 类数据资产的生命周期表（维护者/入口/锁/备份/保留/恢复/reset/隐私）与 expire/archive/delete 三语义；
- 只读审计工具 `scripts/data-consistency-audit.mjs`（9/9 测试）：正文/meta、pending、幂等三态、sessions 僵尸/缓存、DSH 映射、备份 manifest/hash；**不写、不修复**；
- 生产只读审计：**critical=0，warn=11，info=17**；
  - warn 全部 `idem_done_line_missing`（测试残留 3 条、10-20 重复键 2 条、merged 改写导致不精确匹配的自主记录若干）——需人工复核，未修复；
  - info 17 条 `meta_missing`（meta 开关关闭，按授权不批量处理）；
- 硬规则核对：重要日记无按时间删除；未完成 pending/outbox 不自动清理；终态 Goal 无默认删除路径。

## 五、回归与偶发

- 新增专项：`deploy-manifest` 7/7、`deploy-acceptance` 17/17、`reset-safety-drill` 24/24、`data-consistency-audit` 9/9；
- 全量：**75 项，71 PASS / 4 FAIL**；4 项均为既有基线（`selftest`、`tools-skill-audit`、`gallery-test`、`setup-qq-version` 偶发）；
- 过程记录：C3 后首次全量出现 `store-concurrent-test` EPERM，单独复跑 **4/4 通过**；判定环境偶发，首次失败已保留，未改判为 PASS。

## 六、生产数据前后 hash（未变）

| 目标 | 批次前 | 批次后 |
|---|---|---|
| memory 聚合 | `ee772eb3…` | 一致 |
| 日记树聚合（31 文件） | `fb5cfac7…` | 一致 |
| learned | `af040667…` | 一致 |
| pending | `ca880159…` | 一致 |
| idempotency | `96d610c4…` | 一致 |
| sessions 聚合 | `11f52253…` | 一致 |
| `data.reset-backups/` | 不存在 | 不存在 |

未执行：生产 reset、生产 Electron 重启、配置/NapCat 修改、DSH Session 删除/迁移、selfWake/调度/预算修改、17 条 meta_missing 批量处理。

## 七、已验证 / 未验证能力

**已验证**：运行时代码与 HEAD 一致性（文件/启动时间/路由）、部署清单与回滚点、隔离 UI/API/preflight 门禁、写入屏障、跨目录备份 manifest/hash、真实 junction 删除安全、Windows 句柄失败恢复、真实崩溃恢复、完整恢复逐文件核对、恢复中途失败语义、只读一致性审计。

**未验证**：Electron shell（窗口/托盘/权限/单实例）行为、packaged asar 布局、真实磁盘满、文件 symlink（权限）、junction/symlink 的恢复重建、生产 reset 本身。

## 八、残留风险

1. 生产 11 条 `idem_done_line_missing` 需人工复核（多为历史测试/merged 改写，不等于损坏）；
2. reset 备份与各类删除备份**无保留策略**，会持续增长；
3. DSH 孤儿 Session 无清理接口；`dsh-home` 与映射的一致性只做了目录名级检查；
4. learned 删除跨进程复活窗口（D1-3b 遗留）；
5. Chromium/dsh 子进程持句柄导致 reset EPERM 的可能（未实机验证）；
6. 运行实例确切镜像路径 UNKNOWN；若启动自其他副本，需在该目录重新 `--verify`；
7. symlink 场景 INCONCLUSIVE、真实磁盘满 UNKNOWN。

## 九、后续建议

1. 先人工复核 11 条幂等告警；不自动修复；
2. 为 reset/sessions/chat/learned 备份设计保留策略（按 N 份/天数，先只读预检再启用）；
3. DSH 孤儿 Session 与“清空聊天后复用”单独工作包（需可验证接口）；
4. learned 删除锁内化/tombstone；
5. 需要生产 reset 时，另立授权并在维护窗口执行（先确认备份盘余量、日记备份、pending/幂等状态）。

**本阶段不自动进入下一阶段，等待机主确认。**

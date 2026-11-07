# COMPANION CORE 4.0 最终验收报告

> 时间：2026-11-04
> 起始 HEAD：`a39bfee`；最终 HEAD：本报告 commit
> 工作区：干净
> 生产：未删除/修改/标注/归档/恢复/重置任何事故记录；未部署/重启/reset

## 一、提交

| 工作包 | commit |
|---|---|
| P0 生产污染只读核验 | `9fcc118` |
| P1 统一隔离工具 + 静态审计 | `a3e7f3d` |
| P2 隔离防护 11 项 + token-ledger 隔离修复 | `7ce6727` |
| P3 4.0 验收（本报告） | 本 commit |

## 二、P0 事故核验（只读）

- 事故不是新增 2 条 pending/2 条 idem；是 **2 条 11-03 既有测试 pending** 的 `updatedAt/completedAt` 被刷新，和 **2 条既有 idem 键** 的 `at` 被刷新；
- pending 总数 13、idem 57 不变；10-20 正文无对应行；无 21:39:59 新 `diary.written` 事件；
- 无其他记录引用这些 ID/key；无真实业务关联；
- 影响：这两条 idem 为 done 但正文无行；若未来回填 10-20 同内容会被跳过；对当前日常写入影响低；
- 未做任何生产写操作。

## 三、P1/P2 隔离闭环

### 工具

- `test/_isolation.mjs`：隔离根、生产路径拒绝、清理；
- `test/_isolation-preload.mjs`：在任何数据模块前建立临时 DATA_DIR/diary、写最小 config；
- `test/_isolation-probe.mjs`：子进程 env/模块路径/拒绝验证；
- `scripts/test-isolation-audit.mjs`：静态扫描。

### 修复

- `autonomous-test`：导入插件前设置临时 DATA_DIR（`1248d35`）；
- `token-ledger-concurrent-test`：原硬编码生产 `data/`，改为隔离 DATA_DIR（P2）；
- 全量回归默认 `--import` 预加载；6 个只读生产检查测试显式豁免。

### 防护测试

`test/test-isolation-guard-test.mjs` **11/11**：缺 env 拒绝、生产 DATA/DIR 拒绝、子进程拒绝、模块路径一致、并发隔离、生产 hash、越界拒绝、异常清理、清理失败报告、env 缺失抛错。

### 静态审计

```
tests=172 isolated=143 noMarker=29 hardcoded=6 directProductionWrite=0 envAfterStaticImport=0
```

高风险 legacy（未纳入 regression，仍需改造）：`companion-events-archive-test`、`token-ledger-test`、`usage-health-test`（会备份/写生产路径）。

## 四、P3 测试

| 项 | 结果 |
|---|---|
| 4.0 专项 | **16/16** |
| Companion Core | **18/18** |
| Core 集成 | **12/12** |
| autonomous | **97/97** |
| 全量 | **83 项：79 PASS / 4 FAIL**（既有基线） |
| 隔离防护 | **11/11** |

### 失败分类

| 类型 | 项 |
|---|---|
| 既有基线 | `selftest`、`tools-skill-audit`、`gallery-test`、`setup-qq-version`（偶发） |
| 新增失败 | 首次全量出现 `token-ledger-concurrent-test` 总数 0：其硬编码生产 `data/`，与预加载隔离冲突；已修为隔离 DATA_DIR，复跑 PASS；**首次失败保留记录** |
| 环境失败 | 无 |
| 隔离失败 | 无（修复后全量通过） |

## 五、生产 hash（P3 前后）

| 目标 | P3 前 | P3 后 | 归因 |
|---|---|---|---|
| pending | `c0a379cf…` | `c0a379cf…` | 未变 |
| idem | `3cb7f9f2…` | `3cb7f9f2…` | 未变 |
| token-usage | `be1c63e2…` | `be1c63e2…` | 未变 |
| 日记 2026-11-04 | `4335f4cd…` | `4335f4cd…` | 未变 |
| companion-state | `009bc64d…` | `009bc64d…` | 未变 |
| learned | `c75aa21b…` | `05e21fb7…` | 机器人 21:52–21:55 私聊使用计数 |
| DSH 映射 | `39c71976…` | `cfd49318…` | 机器人同一私聊 turns 951/lastUsedAt |
| companion-events | `d06bd62b…` | `8955fd20…` | 机器人同一私聊 `chat.reply_sent` |

日志 21:52–21:55 可见 `发送 -> private:1846383180`；**不是测试写入**。P3 未改变 pending/idem/token/日记/companion-state。

**B 处置后最终值**：idem `e4cee3e2…`（仅删除 2 条 10-20 测试键，剩余 55；备份 `data/backups/idem-cleanup/2026-11-04T14-00-14-716Z/`，sha=`3cb7f9f2…`）；pending 仍 `c0a379cf…`。

## 六、4.0 完成标准评估

| 标准 | 结果 |
|---|---|
| 聊天与 autonomous 伙伴状态读取统一 | PASS |
| 主要跨领域访问经 Core | PASS（例外已记录） |
| 领域唯一维护者 | PASS |
| Goal/Pending/Action/Activity 语义 | PASS |
| 插件统一端口/兼容策略 | PASS |
| 无重复状态/双写 | PASS |
| prompt 兼容 | PASS（golden 字节/hash） |
| 调度/模型/DSH 未变 | PASS |
| 集成测试通过 | PASS |
| 残例外有原因/方案 | PASS |
| diff 已审查 | PASS |
| **生产数据未被本轮开发工具误写** | **PASS（B 处置后）**：2 条测试 idem 键已按授权清理；pending 历史按 B 保留 |

## 七、最终结论

**4.0 架构与集成：PASS。**

**4.0 最终验收：PASS（B 处置后，附保留项）。**

处置：机主选择 **B**，已仅删除 2 条 10-20 测试 idem 键（`auto:2026-10-20:8968…`、`1cec…`），保留 pending 历史。执行前后：idem `3cb7f9f2…→e4cee3e2…`，剩余 55 键；逐键比对无新增/无其他字段变化；pending `c0a379cf…`、10-20 正文 `bcfb78d1…` 未变；备份与 ops 审计已写入。清理后审计 `0 critical / 1 warn / 27 info`（唯一 warn 为既有 `d9fb…` historical）。

保留项：pending 中 2 条 completed 测试历史按 B 不删除/不修改/不标注，作为已知历史残留保留。

## 八、处置执行（B）

| 选项 | 状态 |
|---|---|
| A 保留并标注 | 未采用 |
| **B 清理幂等键** | **已执行**（仅 2 条 10-20 测试 idem；pending 保留） |
| C 清理 pending+idem | 未执行 |
| D 不动 | 未采用 |

详见 `D1-6-4.0-IDEM-CLEANUP-RESULT.md`。

## 九、进入 5.0 前

1. B 已执行；pending 历史按选择保留（不再回滚）；
2. 改造 3 个高风险 legacy 测试（companion-events/token-usage/usage-health）为隔离根后再纳入回归；
3. autonomous `private_*.json` 迁移 Core.context（插件注入 ChatStore）；
4. 补 D1-6 浏览器/ACL/满盘/Electron/asar UNKNOWN；
5. 生产部署/重启另行授权；
6. 5.0 Purpose/Closure/主动策略在 4.0 事故处置后立项。

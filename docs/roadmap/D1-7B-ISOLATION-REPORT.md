# D1-7B：三个高风险测试隔离报告

> 时间：2026-11-04
> 基线：HEAD `9014a42`；本批仅测试隔离，不改业务逻辑/生产数据
> 结果：三个测试已使用临时 DATA_DIR；专项 22/13/12 通过；全量首次 86 项 81 PASS/5 FAIL（4 基线 + 1 环境偶发）；生产 hash 全部 SAME

## 一、阶段 1：只读预检

| 测试 | 读取/写入路径 | import 顺序 | 子进程 | 旧清理/风险 |
|---|---|---|---|---|
| `companion-events-archive-test` | 生产 `data/companion-events/active.ndjson`、`archive/*.gz`；备份到 `data/.events-test-backup` | `import` 仅 fs/path/url；业务模块在写生产后动态 import | 无 | 直接删除/恢复生产事件目录；失败可能丢生产事件 |
| `token-ledger-test` | 生产 `data/token-usage.json`；备份 `.token-usage-test-backup.json` | 仅 fs/path/url；`token-ledger.js` 动态 import | 无 | 直接覆盖生产账本，finally 依赖备份还原 |
| `usage-health-test` | 生产 `data/token-usage.json`、`data/usage-days/*.json`、`data/usage-backfill-state.json`；备份 `.health-test-auto.json` | 仅 fs/path/url；`token-ledger.js` 动态 import | 无 | 直接写生产账本/日文件；清理只还原 AUTO |

共性问题：

- 硬编码 `ROOT/data`；
- 在隔离前就写入/备份生产；
- 清理逻辑若中途失败可能误删/覆盖生产；
- 无子进程，因此无 env 继承问题；但 token-ledger-concurrent 是另一测试（已在 P2 修复）。

## 二、阶段 2：实施隔离

改动（三个文件）：

1. 静态导入 `_isolation.mjs`（只含 fs/os/path，不加载业务/config）；
2. 在任何业务 import 前：
   - 若 `QQ_AGENT_TEST_ISOLATION !== 1` 或无 `QQ_AGENT_DATA_DIR`，调用 `createIsolationRoot` 并设置 env；
   - 调用 `assertIsolatedPaths`，生产路径直接抛错；
3. `DATA`/`AUTO`/`EV`/`DAYS` 全部从 `process.env.QQ_AGENT_DATA_DIR` 派生；
4. 删除生产备份/还原逻辑；
5. 业务模块仍动态 import（在 env 生效后）；
6. finally 只清理本测试自建的临时根；清理失败输出 `[isolation]` 并计入 fail；
7. 预加载清理失败也输出错误（`_isolation-preload.mjs`）。

## 三、阶段 3：专项验证

| 检查 | 结果 |
|---|---|
| 正常执行 | 22/22、13/13、12/12 |
| 临时 DATA_DIR 写入 | 事件/账本/日文件均在 `%TEMP%`；生产 hash 不变 |
| 生产路径拒绝 | 以 `QQ_AGENT_TEST_ISOLATION=1 + 生产 DATA_DIR` 运行 → exit 1（assertIsolatedPaths） |
| 子进程环境继承 | 三个测试均无子进程，N/A；token-ledger-concurrent 已单独验证 |
| 动态 import 顺序 | 业务模块动态 import 在隔离 env/assert 之后 |
| 异常退出与清理失败 | finally 清理；失败会 `[isolation]` 报错并 fail |
| 并发运行 | 三进程并行均 exit 0；互不污染 |
| 结果与原有断言一致 | 通过数 22/13/12，与原测试一致 |
| 临时目录残留 | 无 `events-archive-*`/`token-ledger-*`/`usage-health-*` 残留 |

## 四、阶段 4：全量回归

**首次结果（86 项）：81 PASS / 5 FAIL**

| 失败 | 分类 |
|---|---|
| `selftest` | 既有基线 |
| `tools-skill-audit` | 既有基线 |
| `gallery-test` | 既有基线 |
| `setup-qq-version` | 既有基线（偶发） |
| `deploy-acceptance-test` | **环境偶发**：POST reset 200/data 断言失败；单独复跑 **17/17 PASS** |

- 三个改造测试在全量中均 PASS；
- 首次失败保留，不以重跑覆盖；`deploy-acceptance` 归类环境偶发（此前多次同类）。
- 未删除/排除任何测试换全绿。

## 五、阶段 5：生产安全核验

全量前后（同一批）：

| 文件 | 结果 |
|---|---|
| `data/token-usage.json` | **SAME** `be1c63e2…` |
| `data/companion-events/active.ndjson` | **SAME** `b1362a65…` |
| `data/learned.json` | **SAME** `7fa172e0…` |
| `data/diary-meta/pending.json` | **SAME** `c0a379cf…` |
| `data/diary-idempotency.json` | **SAME** `e4cee3e2…` |
| `data/dsh-sessions.json` | **SAME** `95bfd664…` |
| `data/companion-state.json` | **SAME** `009bc64d…` |
| `日记/每日/2026-11-04.md` | **SAME** `4335f4cd…` |

- 未发现机器人业务写入与测试写入混淆；本批三个测试未改生产；
- 未执行生产清理/重启/reset。

## 六、静态审计

改造后：

```
tests=172 isolated=146 noMarker=26 hardcoded=6 directProductionWrite=0
```

三个目标测试不再出现在 hardcoded/direct 风险列表；仍剩 26 个 no-marker（多为纯解析/UI/worker/只读检查），不在本批范围。

## 七、未解决风险

1. `deploy-acceptance-test` 在高负载下仍有环境偶发（已复跑 17/17，但首次失败保留）；
2. 26 个 no-marker 测试中仍可能有只读生产检查/worker，后续应继续静态审计；
3. 预加载临时根被强制 kill 时可能残留（系统 temp，可清理）；
4. 三个测试无子进程，本批未新增子进程继承验证（已有 P2 工具覆盖）。

## 八、提交

本批独立 commit（测试文件 + 回归列表 + 本报告）。工作区在 commit 后干净。

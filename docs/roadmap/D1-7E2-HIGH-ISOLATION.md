# D1-7E2：两个 HIGH 测试隔离 + E3 诊断准备

> 时间：2026-11-04
> 性质：测试隔离改造；未改业务逻辑/生产数据
> 结果：两个 HIGH 已隔离；专项 7/7、16/16；三进程并发 3/3；生产路径拒绝 exit 1；全量 89 项 85 PASS/4 既有基线；生产 hash 全 SAME

## 一、只读预检

| 测试 | 旧读写路径 | 旧风险 |
|---|---|---|
| `companion-events-test.mjs` | 入口静态 import `src/companion/events.js`；`ACTIVE_FILE` = 生产 `data/companion-events/active.ndjson`；备份为 `.test-bak`、删除、写、恢复；spawn 2 个 worker | 直接改生产事件文件；失败时可能丢失事件 |
| `prompt-version-test.mjs` | 入口静态 import `src/prompt-version.js`；`TURNS` = 生产 `data/prompt-archive/turns.ndjson`；写入 `test:unit` 后按行删除 | 直接改生产 prompt 档案；清理失败会留下测试行 |

共同点：业务模块在隔离前静态 import；路径硬编码 `ROOT/data`；无 `_isolation` 标记。

## 二、隔离改动

### companion-events-test

- 先建隔离根/设置 `QQ_AGENT_DATA_DIR`，`assertIsolatedPaths` 通过后**动态 import** events；
- 删除生产备份/rename/恢复；隔离根内清空 `active.ndjson`；
- worker 由父进程 spawn，**继承隔离 env**；子进程启动后同样 assert；
- 清理只删隔离根内 ACTIVE + 自有临时根；清理失败计 fail；
- 原 7 条断言全部保留。

### prompt-version-test

- 先隔离 env，再动态 import prompt-version；
- `TURNS`、snapshots 路径由 `QQ_AGENT_DATA_DIR` 派生；
- 删除生产 turns 的写/删清理逻辑；测试行保留在隔离 turns；
- 原 16 条断言保留（“测试行已清理”改为“测试行只写入隔离 turns”）；
- 清理只处理自有临时根；失败计 fail。

## 三、专项验证

| 项 | 结果 |
|---|---|
| companion-events 正常 | **7/7 PASS** |
| prompt-version 正常 | **16/16 PASS** |
| 临时 DATA_DIR 写入 | 事件/turns 均在 `%TEMP%`；生产 hash 不变 |
| 生产路径拒绝 | 两个测试在 `QQ_AGENT_TEST_ISOLATION=1 + 生产 DATA_DIR` 下均 **exit 1** |
| 子进程环境继承 | companion 两个 worker 均成功写入 100 条；prompt 无子进程（证据：源码无 spawn） |
| 动态 import 顺序 | events/prompt-version 均在隔离后动态 import |
| 清理失败 | 明确 `[isolation]` 并计 fail |
| 三进程并发 | companion ×2 + prompt ×1 并发 **3/3 exit 0**，生产 events/turns/pending/idem 未变 |
| 断言语义 | 无减少；prompt 的“清理”语义改为“隔离写入” |

## 四、全量回归

**89 项：85 PASS / 4 FAIL**。

既有基线（与本批无关）：

- `selftest`
- `tools-skill-audit`
- `gallery-test`
- `setup-qq-version`（偶发）

两个改造测试均 PASS；无新增失败；未删除/排除测试。

## 五、生产 hash

| 文件 | 前后 |
|---|---|
| companion-events | **SAME** `b1362a65…` |
| prompt turns | **SAME** `97b39e03…` |
| learned | **SAME** `7fa172e0…` |
| pending | **SAME** `c0a379cf…` |
| idempotency | **SAME** `e4cee3e2…` |
| dsh-sessions | **SAME** `95bfd664…` |
| companion-state | **SAME** `009bc64d…` |
| token-usage | **SAME** `be1c63e2…` |
| 11-04 日记 | **SAME** `4335f4cd…` |

## 六、E3 诊断准备

- 只读检查 `deploy-acceptance-test`：失败断言已包含 `r.text`（HTTP body）和 `data 已删除` 的 left 列表；
- `activeRuns`/`quiesce` 结果未通过 API 暴露；增加需改业务/API，超出“只加诊断”边界；
- 本批**不修改**该测试，不放宽断言；E1 压力 10 独立 + 5 并发均 200，未复现，保持 FLAKY/INCONCLUSIVE；
- 后续若再失败，建议在测试内记录 `r.status/r.text/stages` 与请求耗时（不改断言）。

## 七、静态审计

```
tests=173 isolated=149 noMarker=24 hardcoded=6 directProductionWrite=0
```

两个 HIGH 已从 noMarker/风险列表消失；剩余 HIGH 为 0（26 → 24 noMarker，均为 LOW/MEDIUM 或只读）。

## 八、剩余风险

1. 运行态热重载版本不一致（E1）仍 UNKNOWN，需机权重启授权；
2. `companion-events-test` worker 依赖父进程 env；若单独运行 `--worker` 且无 env，会自建隔离根（不会写生产）；
3. prompt-version 原“清理生产行”语义已移除；隔离根由进程退出/显式 cleanup 清理；
4. 其余 24 noMarker 按 D1-7D 清单继续维护（无 HIGH）。

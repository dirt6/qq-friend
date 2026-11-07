# D1-7E7：deploy-acceptance 偶发失败诊断

> 时间：2026-11-04
> 性质：只读分析 + 隔离压力；未修改断言/reset 语义/生产数据
> 结论：**FLAKY / INCONCLUSIVE**（未复现，无根因证据）

## 一、失败调用链

```
POST /api/reset-data
  → 安全门禁
  → preflightReset()                  // pending/idem/unfinished
  → quiesceForReset()                 // orchestrator.abortAll + 5s drain + 停定时器/插件
     · drained !== true → 409
  → resetData()                       // backup → verify → delete → manifest
     · !ok → 500
  → updateConfig(loadConfig())
  → 200 { ok, status:completed, backupDir, manifestPath, atomic:false, stages }
```

测试断言：

1. `r.status === 200`（失败信息已带 `r.text`）；
2. `r.data.status === 'completed'`；
3. data 目录只剩 lock + 重建的 config；
4. 日记正文 hash 不变。

任一失败都会触发 1/2 或 3 的断言；历史全量失败呈现两项同时失败，说明 POST 未返回 200 completed（409/500/异常）或未完成删除。

## 二、只读检查点

| 点 | 现状 |
|---|---|
| 测试隔离 | 独立 bootApp/随机端口/临时 DATA_DIR；无共享端口/DATA_DIR |
| 共享负载 | 全量回归顺序执行；但前序测试进程/插件 timer 可能残留资源 |
| quiesce | `timeoutMs=5000`；`running=[]` 才 drained；失败返回 409 |
| activeRuns | `/api/status` 可见 `running/activeSessions`（只读） |
| reset stages | 成功响应含 stages；失败响应含 stages；测试失败信息未展开 stages |
| 超时 | 测试 request 默认无显式超时；reset 内部锁等待可能 >5s |
| 异步清理 | `app.stop()` 与 reset 无关；quiesce 停 loop/deactivate 同步 |
| 失败响应 | 现有断言 `r.text` 已包含 HTTP body；data-left 已含目录列表 |

**现有诊断已足够看 body/left，不需要改 API**；activeRuns 已由 `/api/status` 暴露（只读）。

## 三、隔离压力

在临时 DATA_DIR/新进程：

| 方式 | 次数 | 结果 |
|---|---|---|
| 独立子进程 bootApp + POST reset（顺序） | 10 | **10/10 200 completed** |
| 并发独立子进程 bootApp + POST reset | 5 | **5/5 200 completed** |
| 全量回归（89 项） | 1 | deploy-acceptance **PASS** |

- 未记录到 409/500，未复现失败；
- 独立子进程避免同进程模块缓存/多实例干扰，仍不复现。

## 四、可能原因（未证实）

1. 全量回归前序测试留下 CPU/IO 负载，使 quiesce 5s drain 超时（409）；
2. 临时目录/端口资源竞争导致 resetData 备份阶段失败（500）；
3. 测试请求在异常时未捕获 body/stages，历史证据不足；
4. 现有失败样本仅有两项断言名，无法区分 409/500。

均属假设，**不构成根因结论**。

## 五、建议（不改变断言/安全语义）

- 如再次失败，测试内记录：
  - `Date.now()` 耗时；
  - `r.status`、`r.text`、`r.data.stages`；
  - 失败时 `/api/status.running`（只读）；
  - 当前 PID/临时目录，关联日志标识；
- 不延长 quiesce 超时掩盖竞争，不放宽 409/500；
- 不跳过 reset 保护。

## 六、结论

**FLAKY / INCONCLUSIVE**；保留原始失败记录（历史两次全量失败）与本次 10+5 压力通过证据；需后续在失败时采集 body/stages 才能定位。

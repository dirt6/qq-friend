# D1-7F6：deploy-acceptance 状态

> 时间：2026-11-04
> 状态：**FLAKY / INCONCLUSIVE**（独立治理，不与 F 重启混同）

## 一、当前证据

- D1-7E7：10 次独立 + 5 并发 POST reset 均 200 completed；全量 deploy-acceptance PASS；
- 历史首次全量失败：POST reset 200/data 删除断言失败；单独复跑 17/17；
- 失败样本未保留 HTTP body/stages（旧断言只有 r.text，未展开 stages）；
- 现有 409/500 断言、reset 安全语义、失败判定**未修改**。

## 二、边界

- 本批不修 flaky 根因；
- 不放宽/跳过/延长超时；
- 不改 reset 保护；
- 不与生产重启耦合。

## 三、后续证据采集（若再失败）

- 保存 `r.status`、`r.text`、`r.data.stages`；
- 保存 `/api/status.running/activeSessions`（只读）；
- 请求耗时、临时 DATA_DIR、PID、时间戳、关联日志；
- 保留原始失败样本，不重跑覆盖。

## 四、结论

**FLAKY / INCONCLUSIVE**；D1-7F 不因它阻塞（独立治理），但最终验收仍单独列出。

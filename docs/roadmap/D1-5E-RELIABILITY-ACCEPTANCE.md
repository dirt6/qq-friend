# D1-5E：综合可靠性测试验收

> 时间：2026-11-04
> 性质：隔离测试；不触碰生产数据/进程
> 结果：**11 PASS / 0 FAIL / 2 UNKNOWN**（首次运行记录；未用重跑覆盖失败——本次无 FAIL）

## 一、状态矩阵

| # | 场景 | 状态 | 说明 |
|---|---|---|---|
| 1 | 多进程并发审计（3 进程） | PASS | 3 个子进程均 exit 0；只读 |
| 2 | 审计期间文件变化（30 次追加） | PASS | 审计不崩溃；**快照一致性不保证**（非事务读） |
| 3 | Session 映射变化中审计 | PASS | 20 次写入映射同时 inventory，无异常 |
| 4 | Session 目录移动中断 | PASS（注入） | `failBeforeMove` → 源保留、审计 failed |
| 5 | Windows 文件句柄占用 | PASS（真实） | 子进程 cwd 占用 → `needs_manual_recovery`，不删除 |
| 6 | 权限不足 | PASS（注入） | 备份失败 → 不删除；**真实 ACL UNKNOWN** |
| 7 | 目标冲突 | PASS | 恢复目标存在 → 拒绝 |
| 8 | manifest 损坏 | PASS | inspect → `corrupted` + protected，不进入清理 |
| 9 | 恢复后 hash 不一致 | PASS | 篡改后可检测（当前恢复流程先校验、后 rename） |
| 10 | 备份与恢复并发 | PASS（隔离） | 2 子进程同 backupRoot 均完成，备份 manifest 可读；串行锁生效 |
| 11 | UI/API 与模块审计计数一致 | PASS | 隔离实例 API warn = 模块 warn |
| 12 | 真实 Windows ACL / 磁盘满 | **UNKNOWN** | 未在本机执行 ACL/满盘；仅注入验证 fail-closed |
| 13 | 浏览器 DOM 实际渲染 | **UNKNOWN** | Edge headless 被 mojo/ACL 拒绝；无 Playwright/Puppeteer，未伪造截图 |

## 二、关键结论

- 并发/变化中审计**不崩溃**，但不提供跨文件事务快照；审计结果应按“某一时刻的近似值”理解；
- 备份/恢复并发由 reset 锁串行化；两个子进程都完成（第二个在空数据上完成），未产生损坏 manifest；
- 文件句柄、目标冲突、损坏 manifest、hash 不一致均 fail-closed（不删除/不覆盖/不谎报）；
- Session 移动中断保留源，不产生“半移动”；
- UI/API 与底层模块同源，计数一致；
- 真实 ACL/磁盘满、浏览器渲染未验证，明确标 UNKNOWN，不用模拟冒充。

## 三、限制

1. “审计期间文件变化”只验证不崩溃，不保证读到一致快照；
2. 权限测试为注入；真实 Windows ACL 需单独环境验证；
3. UI 页面未在真实浏览器渲染/截图（环境限制）；
4. 并发备份/恢复只测同机同卷；跨卷/网络盘未测；
5. 未终止任何生产进程、未隔离生产 Session。

## 四、生产保护

- 全部在 `%TEMP%\d5e-*`；测试结束清理；
- 未写生产 data/、未重启、未 reset；
- 生产 hash 在批次结束后再次核对（见总汇总）。

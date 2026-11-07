# D1-7G 最终验收报告

> 时间：2026-11-04
> HEAD：`ce8664a`（G5 提交后为最终 HEAD）
> 性质：G1–G5 收尾；**未重启/未改生产配置/未写生产数据/未触发 tick**
> 结论：**D1-7G CONDITIONAL PASS**；生产运行态仍 UNKNOWN，5.0 可并行启动

## 一、阶段提交

| 阶段 | commit |
|---|---|
| G1 qq-process-detect 调查+测试修复 | `4df73dc` |
| G2 授权闸门审查+加固 | `337d5c6` |
| G3 可观测性检查清单 | `65e0683` |
| G4 人工重启流程 | `d21118a` |
| 路线对齐/冲突清单 | `d057fe2` |
| 5.0-R0 设计基线 | `ce8664a` |
| G5 本报告 | 最终 commit |

## 二、验收状态

| 项目 | 状态 | 依据 |
|---|---|---|
| 数据完整性 | **PASS** | 全量前后 10 类 hash 全 SAME；未写生产 |
| 测试隔离 | **PASS** | E2 后 HIGH=0；静态 noMarker 24、directProductionWrite=0 |
| 进程检测 | **INCONCLUSIVE** | pid/乱码/可读路径 QQ.exe 通过；3/4 ExecutablePath 因普通权限不可读；测试 16/16，明确 INCONCLUSIVE，不提权 |
| 重启执行器授权闸门 | **PASS** | marker 绑定 scope/action/HEAD/PID/startTime/configSha256/nonce/issuedAt/expiry；一次性消费；执行前重验；身份 UNKNOWN 拒绝；专项 19/19 |
| 运行时版本一致性 | **UNKNOWN** | 进程 20:26 启动，HEAD 更新；22:11 热重载混合；无运行期模块观测 |
| Core/ChatStore 接线 | **UNKNOWN** | `/api/chats` PASS，但不能证明 Core context 注入/单例 |
| autonomous 生命周期 | **UNKNOWN** | 无 tick/实例 ID；仅 log 计数不可靠 |
| 真实自主活动 | **UNKNOWN** | 未触发/未观察 tick；不伪造 |
| deploy-acceptance | **FLAKY / INCONCLUSIVE** | 10 独立+5 并发 200；历史失败未复现；断言未改 |
| **D1-7G** | **CONDITIONAL PASS** | G1–G4 完成；生产重启未授权，运行态 UNKNOWN 不阻塞 5.0 |

## 三、全量回归

**90 项：87 PASS / 3 FAIL**：

- `selftest`（既有基线）
- `tools-skill-audit`（既有基线）
- `gallery-test`（既有基线）

- 本批 G1 修复后 qq-process-detect **PASS**（16/16，含 INCONCLUSIVE 说明）；
- 新增工具测试 `d1-7f-tools-test` **PASS 19/19**；
- 无新增失败；未删除/放宽安全断言；`qq-process-detect` 未以提权掩盖。

## 四、生产 hash（全量前后）

| 文件 | 结果 |
|---|---|
| companion-events | SAME `b1362a65…` |
| prompt turns | SAME `97b39e03…` |
| learned | SAME `7fa172e0…` |
| pending | SAME `c0a379cf…` |
| idempotency | SAME `e4cee3e2…` |
| dsh-sessions | SAME `95bfd664…` |
| companion-state | SAME `009bc64d…` |
| token-usage | SAME `be1c63e2…` |
| ChatStore messages | SAME `ff2680f4…` |
| 11-04 日记 | SAME `4335f4cd…` |

## 五、G1 结论

- 根因：普通权限下 `Get-CimInstance` 对部分 QQ.exe 不返回 ExecutablePath；
- 不是 wmic 乱码、不是 32/64 位、不是进程不存在；
- 测试原先把“路径不可读”当成“检测失败”；修复后显式 INCONCLUSIVE；
- 生产匹配只用可读 path；空 path 不会误匹配便携 QQ，但若便携 QQ 恰不可读会误判未运行（已知 UNKNOWN；现有 spawn pid 优先兜底）。

## 六、G2 结论

- 原闸门缺 config/action/nonce/issuedAt/一次性；
- 已加固并测试；当前 Path/CommandLine UNKNOWN，`--execute` 仍 fail-closed；
- 正常重启仍需机主托盘退出；脚本不自动 Stop-Process/不杀 NapCat。

## 七、G3/G4

- G3：只读检查清单/脚本可用；模块实例/版本/loop 唯一仍 UNKNOWN，不推断 PASS；
- G4：人工重启/异常停止/回滚流程可执行；未执行；回滚 `c9c06ac` 需执行前再核验。

## 八、5.0-R0

已完成设计基线：架构、生命周期、对象关系、Purpose、沉默权、活动选择、回执、连续性、分享、记忆治理、聊天协调、预算、异常、批次验收；明确 Purpose≠Goal、不新增存储、不复制 SurfCore 代码。

## 九、仍 UNKNOWN / INCONCLUSIVE

1. 生产运行时模块版本/单例；
2. Core context 注入与 autonomous 真实读取；
3. 真实自主活动；
4. deploy-acceptance 根因；
5. 进程 executable/命令行（权限）；
6. 回滚未实际演练。

## 十、需要机主授权

- 停止/重启生产 QQ-agent；
- 修改 hotReload（可选，B 级）；
- 触发/观察可能写入的生产 tick；
- 生产部署/模型调用/主动消息（5.0-E 另行申请）。

## 十一、结论

- D1-7G 的代码/测试/流程准备完成，**CONDITIONAL PASS**；
- 生产运行态一致性未恢复，但不再无限阻塞：5.0-R0 已完成，A1–A4 可在隔离环境继续；
- 未执行任何生产操作；所有 UNKNOWN 原样保留。

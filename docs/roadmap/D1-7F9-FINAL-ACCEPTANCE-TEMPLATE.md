# D1-7F9：最终运行态验收模板（当前 HOLD）

> 时间：2026-11-04
> 性质：模板；**生产重启未授权，当前不得判 PASS**
> 当前 HEAD：F7 提交后；生产进程仍是 20:26 旧实例

## 一、当前（重启前）状态

| 项目 | 结论 | 依据 |
|---|---|---|
| 数据完整性 | **PASS** | F1 基线 → 当前关键 hash 全 SAME；未写生产 |
| 代码版本一致性 | **UNKNOWN** | PID 25300 启动 20:26 早于 HEAD；22:11 热重载混合 |
| Core / ChatStore | **UNKNOWN** | `/api/chats` PASS，但运行时模块实例/readPrivateHistory 无观测证据 |
| autonomous 生命周期 | **UNKNOWN** | 无 22:11 后 tick；loop 唯一性无证据 |
| 真实自主活动 | **UNKNOWN** | 未观察自然 tick；未授权主动 tick |
| 服务运行 | **PASS** | 3210/OneBot/NapCat 3001/6099；running=[] |
| **D1-7F** | **HOLD** | 重启未授权，运行态一致性未恢复 |

## 二、重启后填写（模板）

| 项目 | 结论（PASS/FAIL/UNKNOWN） | 证据 |
|---|---|---|
| 代码版本 |  | boot-diag/日志/HEAD/关键文件 hash；进程从目标版本启动 |
| 进程身份 |  | PID+start+Path+CommandLine；NapCat 独立 |
| Core API |  | 日志/受控 tick 无 Core 错误；如有诊断接口则记录 |
| ChatStore |  | `/api/chats`；读取正常；无第二实例证据 |
| 模块实例 |  | 无重复 Core/ChatStore；否则 UNKNOWN |
| autonomous 生命周期 |  | 仅一个 loop；deactivate/重复 activate 验证（隔离/日志） |
| 真实自主活动 |  | 至少一次自然 tick 或获授权真实 tick；fake 不算 |
| 数据完整性 |  | 重启前后 hash；逐项归因 |
| 服务状态 |  | 3210/OneBot/NapCat |
| 回滚 |  | 已演练/保留未验证风险 |

## 三、判定规则

- 无真实自主活动证据 → **不得**把运行态一致性判 PASS；
- 仅 API 健康 → 不能证明 Core/ChatStore/autonomous；
- 仅 loop 启动 → 不能证明 Core 读取；
- 仅函数静态存在 → 不能证明单例/注入；
- Fake tick/单元测试 → 不能代替生产；
- 生产 hash 非预期变化 → FAIL/UNKNOWN，不忽略。

## 四、当前结论

- **数据完整性：PASS**
- **代码版本一致性：UNKNOWN**
- **Core / ChatStore：UNKNOWN**
- **autonomous 生命周期：UNKNOWN**
- **真实自主活动：UNKNOWN**
- **服务运行：PASS**
- **D1-7F：HOLD**

授权重启并完成真实 tick/验收后，用本模板重填；在此之前不得发布 PASS。

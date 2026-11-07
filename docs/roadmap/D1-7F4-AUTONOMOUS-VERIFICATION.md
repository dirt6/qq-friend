# D1-7F4：自主活动验证方案

> 时间：2026-11-04
> 性质：方案；**未触发生产 tick**
> 当前：22:11 热重载后无 autonomous tick 证据；自主活动状态 UNKNOWN

## 一、首选：自然 tick

重启后优先观察自然调度，不主动触发：

- 观察 `data/logs/qq-agent-<date>.log` 中 autonomous 启动/tick 日志；
- 只有一个 `自主活动已启动`/一个 loop（重复即 WARN/FAIL）；
- tick 无 `readPrivateHistory is not a function`、Core/context 错误；
- tick 正常读取 Goal/Pending/ChatStore（通过日志/无异常间接证明；运行时无方法观测 API）；
- 不出现重复活动/重复 Action；
- 记录 tick 前后生产 hash 与写入内容（日记/聊天/Goal/Pending/token）。

**若自然 tick 未发生，不得声称自主活动通过**。

## 二、如需主动触发（需单独授权）

当前无生产安全只读触发入口；`runSession({dryRun})` 仅测试进程，不能替代生产 tick。若机主批准：

- 触发入口：现有管理 API/内部调度（不得新增后门）；
- 条件：无在跑会话、无模型请求、工作区干净、hash 已记录；
- 模型调用上限：按当前配置；不增加预算；
- 工具权限：沿用生产权限；禁止发帖；
- **允许写入范围必须明确**：
  - 不创建测试 Goal/Pending；
  - 不写测试日记；
  - 不修改用户印象；
  - 不自动发帖；
  - 不 reset/清理；
- 退出条件/失败处理：异常立即停止、保存日志/hash、不回滚数据（除非单独授权）；
- 不重复执行有副作用的 Action。

默认建议：**只观察自然 tick**；若需要验证 Core 读取，先接受可能产生一次正常自主写入，并由机主指定允许范围。

## 三、证据分级

| 证据 | 能证明 |
|---|---|
| `/api/status` 正常 | 仅服务 |
| 日志显示 loop 启动 | 仅启动 |
| `readPrivateHistory` 函数存在（静态） | 仅代码存在 |
| 一次自然 tick 无错误、hash 变化可解释 | 运行态（可接受） |
| Fake tick/单元测试 | 仅测试逻辑，不能代替生产 |

## 四、判定

- 观察到正常自然 tick：可作为运行态证据；
- 仅 API 健康/loop 启动/函数存在：不能证明 Core/ChatStore 注入正确；
- 无 tick：**UNKNOWN**，D1-7F 不得 PASS。

当前：**UNKNOWN**（未 tick）。

# D1-7F7：生产操作授权申请

> 时间：2026-11-04
> 当前 HEAD：`b25064c`（F4–F6 文档）；运行时 `src/**` 与 `6cf48bc` 相同
> **提交后停止，不执行生产重启/配置修改/tick**

## 一、申请事项

请机主明确授权以下动作（可逐项批准/拒绝）：

1. **停止并重启生产 QQ-agent**（一次维护窗口）；
2. **是否允许同时把 `extensions.hotReload` 改为 false**（推荐；见 §四）；
3. **是否允许观察一次自然 autonomous tick 及其正常写入**（见 §五）；
4. **是否允许由 Agent 使用现有桌面快捷方式启动**（停止/退出由机主托盘操作，或另行授权强制停止）。

## 二、当前现场

| 项 | 值 |
|---|---|
| QQ-agent PID | 25300；启动 2026-11-04 20:26:53 |
| 身份验证 | PID+启动时间+端口一致；**Path/CommandLine UNKNOWN**（权限），四要素不完整 |
| 运行版本 | 混合：主进程 20:26 代码 + 22:11 热重载 autonomous |
| 3210 | LISTEN 25300；OneBot connected；running=[] |
| NapCat/QQ | PID 33480；3001/6099 LISTEN；独立于 Electron |
| hotReload | true（config hash `fcab76c3…`） |
| 数据基线 | F1：events `b1362a65…`、turns `97b39e03…`、learned `7fa172e0…`、pending `c0a379cf…`、idem `e4cee3e2…`、dsh `95bfd664…`、companion `009bc64d…`、token `be1c63e2…`、messages `ff2680f4…`、日记 `1ec13e8a…` |

## 三、停止/启动方式

- **正常停止**：机主托盘/窗口“退出”（`app.stop()`）；Agent 无法程序化点击托盘；
- F2 `d1-7f-restart.mjs --execute` 当前会 **fail-closed 拒绝**（Path/CommandLine UNKNOWN），不会自动 Stop-Process；
- 若机主授权强制停止，必须单独批准 `force` 路径，并确认 PID 25300 与启动时间；禁止按进程名批量 kill；
- **启动**：桌面快捷方式 `electron.exe "E:\dsh\QQ-agent\." --no-sandbox`，cwd `E:\dsh\QQ-agent`；
- 启动前确认 3210 无监听、旧 PID 消失、无第二个实例；
- NapCat PID 33480 不应被关闭；若 NapCat 断开，由机主按既有 launcher 单独处理。

## 四、hotReload 配置（B 级）

| 项 | 值 |
|---|---|
| 文件 | `data/config.json` → `extensions.hotReload` |
| 原值 | `true` |
| 建议新值 | `false` |
| 理由 | 避免重启后再次出现新插件+旧 Core 混合 |
| 备份 | `data/backups/config/d1-7f-<stamp>/config.json` + SHA256（执行时创建） |
| 回滚 | 恢复备份 → 重启 |
| 影响 | 仅插件/技能自动加载；不影响聊天/autonomous/NapCat/UI |
| 生效 | 需重启（运行中改文件不会立即关闭 watcher） |

若拒绝修改：可保留 true 重启，但重启窗口内不得编辑 `src/**`/`plugins/**`/`skills/**`，否则再次混合。

## 五、autonomous tick / 允许写入

- 首选：重启后**只观察自然 tick**，不主动触发；
- 自然 tick 可能在启动后 15s~数分钟内发生，且**可能正常写日记/聊天/Goal/Pending/token/events**；
- 请明确：
  - 允许自然 tick 及其正常写入（不制造测试数据）；
  - 或不允许任何自主写入 → 则无法获得真实运行态证据，D1-7F 只能 UNKNOWN/HOLD；
- 禁止：测试 Goal/Pending、测试日记、用户印象修改、自动发帖、reset、预算/调度修改、重复有副作用 Action。

## 六、回滚版本

- 候选：`c9c06ac`（D1-7B，D1-7C 前）；
- F2 rollback preflight：存在；package version 0.4.0 与当前一致；关键文件存在；`compatible=true`；
- 回滚仅代码 checkout + 重启；**禁止 reset/删 Session/清 Goal/Pending/日记/覆盖数据**；
- 若 `c9c06ac` 不适用，执行前再确认另一版本。

## 七、执行器行为

- 默认 preflight（只读）；
- `--execute` 需要外部授权 marker（scope/authorizedBy/targetHead/pid/startTime/expiresAt），脚本不创建 marker；
- 本轮 Path/CommandLine UNKNOWN → 即使 `--execute` 也拒绝停止；
- 因此实际停止需机主托盘退出（或批准 force），Agent 只负责预检/启动/验收；
- 不自动结束 NapCat、不批量 kill。

## 八、停机时间与失败恢复

- 预计停机 1–3 分钟（退出+启动+健康检查）；
- 启动失败：保留日志；按 E6 回滚 `c9c06ac` + 重启；不 reset；
- 数据非预期变化：停止写操作，保留现场，按备份/审计流程处理；
- NapCat 意外退出：用既有 launcher 单独启动（需授权）。

## 九、申请结论

**请批准：重启窗口 + 是否关闭 hotReload + 是否允许自然 tick 正常写入 + 是否允许 Agent 启动快捷方式。**

未获明确授权前：不停止、不重启、不改配置、不触发 tick。

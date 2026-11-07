# D1-7E4：生产重启前只读预检

> 时间：2026-11-04 22:36–22:40
> HEAD：`9688d0f`；分支 main；工作区干净
> 性质：只读；未停止/重启进程、未改配置、未写数据
> 结论：**技术预检完成；运行态一致性 BLOCKED（进程仍为 20:26 旧实例 + 22:11 热重载插件），需授权重启后才能继续**

## 一、代码与进程基线

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | `9688d0f` | `git rev-parse` |
| 工作区 | 干净 | `git status` |
| 生产 PID | **25300** | `data/qq-agent.lock`（mtime 20:26:56）、netstat 3210 |
| 进程名 | electron | `Get-Process` |
| 启动时间 | **2026-11-04 20:26:53** | `Get-Process StartTime`；boot-diag 20:26:54/58 |
| 可执行路径 | **UNKNOWN** | `Get-Process.Path` 为空（权限） |
| 启动命令 | 快捷方式：`electron.exe "E:\dsh\QQ-agent\." --no-sandbox` | 桌面 `QQ Agent.lnk` |
| 工作目录 | `E:\dsh\QQ-agent` | 快捷方式 WorkingDirectory |
| 父进程 | **UNKNOWN** | CIM 查询被拒绝；禁止按进程名批量 kill |
| 端口 | 3210 LISTENING（25300） | netstat |
| API | `/api/version=0.4.0`；OneBot connected；orchestrator running=[] | 只读 GET |
| hotReload | **true** | `data/config.json.extensions.hotReload` |
| 目标版本 | `9688d0f`（E2 完成） | git |

### 关键：进程早于目标版本

- 启动 20:26:53，早于 `9688d0f`（22:33 左右提交）；
- 22:11:08/15 发生 autonomous 热重载；
- 因此当前进程**不是**纯目标版本：主进程 Core/ChatStore 仍是 20:26 代码，autonomous 入口可能是 22:11 磁盘版本；
- `/api/version` 只证明 package.json 版本，**不能证明材料模块一致**；
- 是否存在多个 autonomous loop：loader 先 deactivate 旧实例再 setup；未观察到重复日志；但依赖版本不一致 → **UNKNOWN**。

## 二、进程拓扑

| 组件 | PID | 归属 | 说明 |
|---|---|---|---|
| QQ-agent Electron | 25300 | 本项目 | 3210；启动 20:26:53 |
| NapCat/QQ | **33480**（ProcessName QQ） | 外部 QQ/NapCat | 监听 3001 + 6099；启动 16:20:11；注入式 |
| QQ 另一进程 | 22968（QQ.exe） | 外部 | 16:20:11 |
| SnowLuma | 无 | 未内置运行 | `/api/status` running=false, embedded=false |
| Node/其他 Electron | 未发现（当前权限范围内） | — | 不排除不可见进程 |

- NapCat 与 QQ-agent 是**独立进程**；停止 Electron 不会自动停 QQ/NapCat；
- 禁止 `taskkill /IM QQ.exe /T` 或按名字批量杀；如确需停止 NapCat，必须由机主按既有 launcher 流程单独处理。

## 三、生产数据只读基线（2026-11-04T22:36:56Z）

| 文件/目录 | 存在 | 文件数 | 字节 | SHA256 |
|---|---|---|---|---|
| companion-events | 是 | 1 | 335,992 | `fc2142f8…`（active `b1362a65…`） |
| prompt-archive | 是 | 1 | 180,482 | `d4fd440c…`（turns `97b39e03…`） |
| learned | 是 | 1 | 7,549 | `7fa172e0…` |
| pending | 是 | 1 | 7,264 | `c0a379cf…` |
| idempotency | 是 | 1 | 16,801 | `e4cee3e2…` |
| dsh-sessions | 是 | 1 | 196 | `95bfd664…` |
| companion-state | 是 | 1 | 9,695 | `009bc64d…` |
| token-usage | 是 | 1 | 1,300 | `be1c63e2…` |
| diary-meta | 是 | 1 | 7,264 | `62e6143b…` |
| 日记正文 | 是 | 32 | 40,329 | `1ec13e8a…` |
| ChatStore messages | 是 | 1 | 1,765,900 | `68ef2603…`（private `ff2680f4…`） |
| usage-days | 是 | 23 | 158,146 | `6486e93b…` |

- 区分：以上均存在且非空；`prompt-archive/snapshots` 未纳入（不存在/空需区分，当前未发现）；
- 仅记录 hash/大小，未读取/输出 API Key、Cookie、Token、聊天正文；
- 未调用会更新状态的接口。

## 四、重启影响面

1. **如何停止**：优先托盘/窗口“退出”触发 `app.stop()`；若必须命令，只能按 PID 25300 精确停止，禁止按进程名批量。
2. **如何启动**：桌面快捷方式（管理员）→ `electron.exe "E:\dsh\QQ-agent\." --no-sandbox`，工作目录 `E:\dsh\QQ-agent`。
3. **自动拉起**：启动目录无 QQ Agent 项；未发现计划任务/服务。判定：无自动拉起（当前证据）。
4. **NapCat 是否一起退出**：否；QQ/NapCat 独立 PID 33480/22968，停止 Electron 不应影响。
5. **误杀风险**：高；禁止按 `QQ.exe`/`electron.exe`/`node.exe` 批量 taskkill。
6. **未完成自主/模型/工具**：`/api/status` orchestrator.running=[]；autonomous-log 最后 21:23；22:11 后无 tick。判定：当前无在跑自主轮次（快照时点）。
7. **重启后积压任务**：autonomous loop 启动后可能按 nextWakeAt 执行积压；pending 当前 0 未完成（13 条 completed）；Goal 状态需只读确认。存在重启触发自主写日记/聊天的可能 → 必须单独授权“受控 tick/允许写入范围”。
8. **重启写入**：`app.stop()` 会 flush sessions index；启动会加载 config/插件；正常启动不应写 pending/Goal/日记，但 autonomous tick 可能写。

## 五、未确认项 / 阻断

| 项 | 状态 |
|---|---|
| 进程 executable/父进程 | **UNKNOWN**（权限拒绝） |
| 当前进程内模块版本是否一致 | **UNKNOWN**（热重载混合；无 tick 证据） |
| 是否存在不可见 Node/Electron 实例 | **UNKNOWN** |
| 停止 Electron 是否会被 NapCat/QQ 影响 | 结构上独立；未实测（禁止重启） |
| 重启后 autonomous 是否立即写数据 | **UNKNOWN**（取决于 nextWakeAt/积压） |
| 运行态一致性 | **BLOCKED**（需重启授权） |

## 六、是否具备执行条件

- 只读预检：**完成**；
- 技术重启条件：基本具备（入口/进程/端口/数据基线/回滚版本/健康检查可定义）；
- 但：**生产运行态一致性 UNKNOWN**，且本轮未授权重启；
- 结论：**暂不具备执行条件**；待机主授权后按 E6 执行，且首次 autonomous tick 需单独授权写入范围。

# D1-7F1：执行当天生产只读预检

> 时间：2026-11-04T22:42:41+08:00
> HEAD：`6cf48bc`；分支 main；工作区干净
> 性质：只读；未重启/未改配置/未写数据
> 结论：**进程身份 UNKNOWN；重启执行 BLOCKED**（F2 执行器必须 fail-closed）

## 一、进程身份（当天重新采集）

| 项 | 值 | 证据 |
|---|---|---|
| `data/qq-agent.lock` | `25300` | 文件内容 |
| QQ-agent PID | 25300 | 启动 2026-11-04 **20:26:53** |
| 进程名 | electron | Get-Process |
| 可执行路径 | **UNKNOWN** | `Path` 为空（权限拒绝） |
| 命令行 | **UNKNOWN** | CIM 查询被拒绝；快捷方式记录 `electron.exe "E:\dsh\QQ-agent\." --no-sandbox` 仅为启动配置，不等于当前进程证据 |
| 父/子进程 | **UNKNOWN** | 权限拒绝 |
| cwd | 推测 `E:\dsh\QQ-agent`（快捷方式）；当前进程 **UNKNOWN** |
| 端口 3210 | LISTENING 25300 | netstat |
| 3210 连接 | 25300 ↔ 33480（3001）等 | netstat |
| API | 0.4.0；OneBot true；running=[] | 只读 GET |
| hotReload | true | config hash `fcab76c3…` |
| NapCat/QQ | PID 33480；3001/6099 LISTENING | 独立于 25300 |

### 联合验证结论

- PID 25300 + 启动时间 + 端口三者一致；
- 但 executable path/命令行为 UNKNOWN，**无法联合验证可执行文件与父进程**；
- 按任务书：身份证据不足 → 保留 UNKNOWN，**不得停止该进程**；
- 不能仅凭 PID/进程名决定停止对象。

## 二、代码基线

| 项 | 值 |
|---|---|
| 磁盘 HEAD | `6cf48bc` |
| 分支 | main |
| 工作区 | 干净 |
| 目标启动版本 | `6cf48bc`（当前 HEAD，docs/E2 后） |
| src/app.js | `18b252cd…` |
| companion-core/index.js | `63fa64be…` |
| companion-core/context.js | `b75ef9bb…` |
| plugins/autonomous/index.js | `bd4a0b6c…` |
| plugin-loader.js | `063a0bf8…` |
| store.js | `3400675d…` |
| config.json | `fcab76c3…`（hotReload=true） |

### 运行版本判定

- 进程启动 20:26:53 **早于** HEAD `6cf48bc`；
- 22:11:08/15 热重载 autonomous；
- 因此当前进程不是单一目标版本：主进程 Core/ChatStore 仍是 20:26 代码，插件入口可能是 22:11 磁盘版本；
- `/api/version=0.4.0` 不能证明模块一致；
- 是否存在多个 autonomous loop：未观察到重复日志，但无 tick 证据 → **UNKNOWN**。

## 三、生产数据基线（2026-11-04T14:42:41Z）

| 数据 | 存在 | 文件数 | 字节 | SHA256 |
|---|---|---|---|---|
| companion-events | 是 | 1 | 335,992 | `fc2142f8…`（active `b1362a65…`） |
| prompt-archive | 是 | 1 | 180,482 | `d4fd440c…`（turns `97b39e03…`） |
| learned | 是 | 1 | 7,549 | `7fa172e0…` |
| pending | 是 | 1 | 7,264 | `c0a379cf…` |
| idempotency | 是 | 1 | 16,801 | `e4cee3e2…` |
| dsh-sessions | 是 | 1 | 196 | `95bfd664…` |
| companion-state | 是 | 1 | 9,695 | `009bc64d…` |
| token-usage | 是 | 1 | 1,300 | `be1c63e2…` |
| messages | 是 | 1 | 1,765,900 | `68ef2603…`（private `ff2680f4…`） |
| diary-meta | 是 | 1 | 7,264 | `62e6143b…` |
| 日记正文 | 是 | 32 | 40,329 | `1ec13e8a…` |
| usage-days | 是 | 23 | 158,146 | `6486e93b…` |
| config.json | 是 | 1 | 20,203 | `fcab76c3…` |

- 均为存在且非空；未读取/输出聊天正文、密钥、Cookie、Token；
- 未调用会改状态的接口。

## 四、当前运行态

| 项 | 值 |
|---|---|
| 3210 | 正常 LISTEN |
| OneBot | connected=true |
| NapCat 3001/6099 | LISTEN（33480） |
| orchestrator.running/activeSessions | 0 / 0 |
| 未完成模型请求/工具 | 无可见（API/log 只读） |
| pending 未完成 | 0（13 条 completed） |
| 未完成 outbox/事务 | 未发现；preflight 只读可判 |
| 多个 autonomous loop | UNKNOWN（无 tick；日志无重复启动） |

## 五、阻断项

1. **进程身份 UNKNOWN**（executable/命令/父进程）→ 禁止停止；
2. 运行态版本不一致 UNKNOWN；
3. 无重启授权；
4. autonomous 真相未验证（热重载后无 tick）；
5. 父/子进程不可见。

**F2 执行器必须在身份 UNKNOWN 时拒绝停止；本阶段无法进入执行路径。**

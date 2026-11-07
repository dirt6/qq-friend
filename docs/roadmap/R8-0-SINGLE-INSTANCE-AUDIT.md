# R8-0：QQ-agent 单实例与记忆共享架构核查（只读）

> 时间：2026-11-03
> 状态：**只读核查，未改任何代码 / 未碰生产数据**
> 触发：机主决定先保证"生产只有一个 QQ-agent 实例"，再让 Memory Hub 管记忆
> 目的：查清 20:13 事故的锁生命周期、启动入口、数据目录、`killStaleSiblings` 误杀风险，再决定修锁生命周期还是引入 OS 级单实例

---

## 一、结论（先看这里）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 谁删了锁？ | **没有第三方删除**。锁只有三个写点：`acquire` 写、`release` 删（只删自己的）、`acquire` 的残留回收删。web-panel 只读锁，启动器只杀进程不删锁，重置功能显式跳过锁 |
| 2 | 是否存在不同启动入口？ | **至少 5 个**（见第四节），其中 `node src/server.js` 是 headless 入口，Electron 的 `requestSingleInstanceLock` 管不到它 |
| 3 | 是否存在不同数据目录？ | **dev 模式一致**（都是 `ROOT/data`）；**打包模式不一致**（Electron 用 exe 旁 `data`，node 用 `resources/app/data`）——潜在双实例/记忆分裂 |
| 4 | `killStaleSiblings` 会误杀吗？ | 不按进程名扫全盘，只杀命令行含 `appRoot` 的进程；**盲区是 `node src/server.js` 命令行不含绝对路径 → 漏杀 headless**。它不删锁 |
| 5 | **20:13 时的 33200 是第二核心吗？** | **证据不支持**。33200 比 15:58 的主进程晚 3 秒启动、孤立无兄弟进程；16:00–18:10 的多次"控制台已就绪"不在 `boot-diag.log`（不是 Electron 主进程）。**原报告"双进程覆盖"的根因判断证据不足** |
| 6 | 该修锁还是上 OS 级？ | **先做端口守门 + 统一入口/数据目录**（零依赖、跨入口）；锁生命周期可以修，但单独不够；OS 级原生互斥暂不必要 |

---

## 二、20:13 的时间线（用 boot-diag 校正）

`data/boot-diag.log` 的时间戳是 **UTC**（本地 +8）。关键点：

| UTC | 本地 | 事件 |
|---|---|---|
| 07:51:24 | 15:51 | Electron 主进程启动，gotLock=true |
| 07:58:40 | 15:58 | Electron 主进程启动，gotLock=true（15:51 实例已退出） |
| 11:47:34 | 19:47 | Electron 主进程启动，gotLock=true |
| 11:48:43 | 19:48 | Electron 主进程启动，gotLock=true（19:47 实例已退出） |

**今天 `main.js 已加载` 共 75 次**（多次重启），但 08:00–10:00 UTC（16:00–18:10 本地）**没有任何 `main.js` 记录**——而这期间访问日志有 9 次"控制台已就绪"。

→ 这 9 次不是 Electron 启动，**只可能是 `node src/server.js`（headless）**（或同进程重建，但两个入口都只调一次 `createApp`）。

`web-panel.log`（19:47 附近）：

```
[19:47:53] 控制面板已启动：http://127.0.0.1:8899
[19:48:19] 启动 NapCat
[19:48:49] 已通过 explorer 以普通权限启动机器人
```

19:48:45 的 3210 启动比面板"启动机器人"早 4 秒，说明 19:48 那次是独立启动（不是面板触发的那次）。

### 33200 的身份

- 主进程启动于 15:58:40，`33200` 启动于 **15:58:43**（晚 3 秒）→ 不可能是主进程，更像主进程的子进程（GPU/渲染/utility）。
- 19:49 杀它之前，进程列表是：`33200`（15:58）单独一个；`25984/27508/1912`（19:48:43）+ `1416`（19:48:45）是一组。
- 一个孤立的 Electron 子进程、没有同组兄弟、不持有 `qq-agent.lock`、不监听 3210 → **不是活跃核心**。

**因此**：20:13 时很可能只有 19:48 的 25984 一个活跃核心。杀 33200 前后"3210 正常"这件事本来就该正常。20:13 的丢消息**不是双进程覆盖**，需要按"单实例内的发送/落盘失败"重查（见第六节）。

---

## 三、锁的生命周期（代码级）

`src/instance-lock.js` + 调用点：

| 动作 | 位置 | 行为 |
|---|---|---|
| 写锁 | `acquireInstanceLock()` `:156` | `writeFileSync(LOCK_FILE, pid, { flag: 'wx' })` 原子创建 |
| 拒绝 | `:176-178` | 锁存在且 pid 活着 → 返回失败，`app.js:130` 抛错退出 |
| 残留回收 | `:180` | pid 死或锁内容是自己 → `unlinkSync` 后重试 wx |
| 释放 | `releaseInstanceLock()` `:187-193` | 只在 `stop()`（`app.js:1702`）和 `exit` 钩子；**只删内容等于自己 PID 的锁** |
| 退出钩子 | `registerLockCleanup()` `:196-214` | SIGINT/SIGTERM 不提前释放，等 `exit` |

**没有发现第三方删锁**：

| 候选 | 实际 |
|---|---|
| `web-panel-server.mjs` | 只 `readFileSync(LOCK)` 显示状态（`:110`），不删 |
| `快速启动人设.ps1` | `Test-BotRunning` 只读；`Do-StopBot` 只 `Stop-Process -Id`，**不删锁**；杀完锁残留，下次启动由 `acquire` 回收 |
| `routes.js` 重置数据 | 显式 `if (name === 'qq-agent.lock') continue`（`:1578`） |
| `重启控制面板.bat` | 只 taskkill 面板 PID，不碰锁 |
| `sanitize-release.mjs` | 发布时清理清单，运行时不执行 |

**所以"锁消失"的正常解释只有两个**：进程正常退出（`exit` 删锁）或下一个实例的残留回收删锁。没有神秘第三方。

---

## 四、启动入口清单

| # | 入口 | 形态 | DATA_DIR 来源 | 单实例检查 |
|---|---|---|---|---|
| 1 | `npm start` / `electron .` | Electron | `main.js:resolveDataDir()`（dev → `ROOT/data`） | Electron lock + instance-lock |
| 2 | `启动QQ机器人.bat` | `start electron.exe "%~dp0." --no-sandbox` | 同 1 | 同 1 |
| 3 | `快速启动.bat` → `快速启动人设.ps1` → `cmd /c 启动QQ机器人.bat` | Electron | 同 1 | 同 1 |
| 4 | `启动控制面板.bat` → 8899 面板 → `/api/ops/bot/start` → explorer 打开 bat | Electron | 同 1 | 同 1 |
| 5 | `npm run server` / `node src/server.js` | Node headless | `config.js` 的 `DATA_DIR`（env 或 `ROOT/data`） | **只有 instance-lock** |

### 数据目录的不一致点

- **dev 模式**：Electron 的 `resolveDataDir()` 返回 `ROOT/data`；node 的 `DATA_DIR` 也是 `ROOT/data` → 一致 ✅
- **打包模式**：Electron 用 `path.dirname(exe)/data`；node server 用 `resources/app/data` → **两个不同目录**。若同时启动，两套 `qq-agent.lock`、两套 `messages`，谁都不拦谁；即使不覆盖，记忆也会分裂。

---

## 五、`killStaleSiblings` 审查

`instance-lock.js:81-137`：

- 只在 Windows；用 PowerShell CIM 查 `electron.exe / QQ Agent.exe / node.exe`。
- 过滤条件：命令行**包含 `appRoot`**（`E:/dsh/QQ-agent` 归一化后）。
- 只杀**启动时间早于自己**的。

| 风险 | 结论 |
|---|---|
| 误杀别的 Electron 应用 | 不会：命令行不含项目路径就跳过 |
| 漏杀 headless | **会**：`node src/server.js` 的 CommandLine 通常只有相对路径 `src/server.js`，不含 `E:\dsh\QQ-agent` → 不匹配 |
| 误杀正常在跑的旧实例 | 不会：旧实例活着时新实例拿不到锁，根本走不到这一步；能走到说明锁已释放，旧进程是 stop 后的残留 |
| 会不会删锁 | 不会（只 `process.kill`） |

---

## 六、20:13 丢消息的重新判断（未定论）

原报告的因果是"33200 是旧核心 → 两个进程各写一份 → 覆盖"。按本次核查，33200 不像活跃核心，因此**该因果链证据不足**。

单实例下仍可能丢的路径（需要下一轮专门查）：

1. `sender.js` 里 `sendText` 成功 → `appendSelf` 抛错（rename EPERM/EBUSY）→ `onSent` 不执行 → **QQ 有、store 无、日志无**。这与当时"日志里没有 `[发送 -> ...]`"吻合。
2. 进程在 `sendText` 返回后、`appendSelf` 前被强杀（窗口极小）。
3. 19:47 实例退出（19:48 被新实例替代）时，最后一批写入未落盘。

**这三条都还没有证据能排除。** 需要看 19:48 实例的运行时日志/临时文件，或加发送路径的失败日志（但那是修改代码，不在本只读核查范围）。

---

## 七、建议（供拍板）

### 方案 A（推荐先做）：端口守门 + 统一入口

- **以 3210 端口绑定作为唯一守门**：核心本来就监听 3210；启动时 `EADDRINUSE` → 直接退出并提示"已有实例"。
  - 零依赖、跨 Electron/Node、不受锁文件被删影响。
  - 需要处理"端口被别的程序占用"的提示（区分自身实例与外部占用）。
- **统一入口**：所有启动方式最终都走同一个 launcher（设置同一 `QQ_AGENT_DATA_DIR`），禁止直接 `node src/server.js`。
- **统一数据目录**：让 Electron 与 node 都用 `config.js` 的 `DATA_DIR`（打包模式也一致），而不是各自推导。

### 方案 B：修锁生命周期（辅助）

- 锁文件里加 `{ pid, startedAt, argvHash, dataDir }`，避免 PID 复用歧义。
- `killStaleSiblings` 增加"按 `dataDir`/cwd 匹配 node 进程"，覆盖 headless。
- 锁只是辅助（记录 PID 供面板"停止"用），**不把正确性押在锁文件存在性上**。

### 方案 C：OS 级单实例（暂不必要）

- Windows 命名互斥（`CreateMutex`）能根治，但 Node 无内置，需要原生模块；Electron 的 `requestSingleInstanceLock` 只覆盖 Electron。
- 在方案 A 已能可靠守门的前提下，引入原生依赖的收益不足以抵消打包复杂度。

### 顺序建议

1. 先做方案 A（端口守门 + 统一入口/数据目录）——这是"生产只有一个实例"的最小可靠保证。
2. 再把 Memory Hub 定为唯一记忆入口（各实例不再各自维护缓存）。
3. 最后按需补方案 B 的诊断字段。

---

## 八、未验证 / 边界

| # | 未验证 | 说明 |
|---|---|---|
| 1 | 16:00–18:10 的 9 次启动具体是哪个入口 | boot-diag 无记录 → 非 Electron；最可能是 `node src/server.js`，但没有直接命令行证据 |
| 2 | 33200 的确切命令行 | 进程已死，`Get-CimInstance` 在沙箱被拒；只能靠启动时间/同组关系推断 |
| 3 | 20:13 的真因 | 三种候选都未排除（见第六节） |
| 4 | 打包模式下两条入口的实际 DATA_DIR | 只做了代码推导，未在打包版实测 |

**本次核查没有修改任何代码、没有重启/停止生产实例、没有碰 `data/` 内容。**

---

## 九、给 R8 的结论

- 不应该为了"支持两个 QQ-agent 同时运行"继续复杂化记忆系统——本次核查支持机主的判断。
- 但"双进程覆盖"这个 20:13 的根因判断需要撤回/降级为"未证实"；下一步应先做单实例守门，再按单实例路径重查 20:13。
- R8-B 三态实现已完成（`105d4bf` / `0e6a560` / `a644e7b`），不受本次影响。

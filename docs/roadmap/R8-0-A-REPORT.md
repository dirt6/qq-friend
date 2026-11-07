# R8-0-A 验收报告：单实例守门与统一数据目录

> 时间：2026-11-03
> 授权：机主拍板「方案 A（保留 PROFILE 多开）+ killStaleSiblings 降级为诊断」
> 前置：R8-0 只读核查 `82ff7a9`
> 边界：未改生产记忆、未杀任何生产进程、未重启生产机器人

---

## 零、结论（逐条回答验收问题）

| # | 问题 | 答案 |
|---|---|---|
| 1 | 五个入口是否全部经过同一守门？ | **是**。`npm start` / `启动QQ机器人.bat` / `快速启动.ps1` / 8899 面板启动 / `node src/server.js` 最终都走 `createApp() → start() → listenExclusive(3210+PROFILE×100)`。8899 面板本身不是实例（不跑 createApp），它启动 bot 仍走 bat → Electron → 同一守门 |
| 2 | 开发与打包模式是否使用同一 DATA_DIR？ | **是**。统一 `src/data-dir.js`：`env > 打包(安装目录/data) > 开发(项目根/data)`；`resources/app` 与 `resources/app.asar` 都推到安装目录。Electron 与 Node 用同一函数 |
| 3 | 第二个实例是否能在任何业务副作用发生前被拒绝？ | **是**。`start()` 第一步独占 bind；`EADDRINUSE` → `INSTANCE_ALREADY_RUNNING` 退出；`acquireInstanceLock` 移到 listen 成功之后；listen 失败时不碰锁、不连 QQ、不加载 Skill、不起定时器 |
| 4 | 是否仍存在直接启动业务而绕过守门的路径？ | **没有**（代码内）。端口顺延 3211–3219 已删；`QQ_AGENT_PORT` 已移除；`node src/server.js` 与 Electron 同守门。**已知限制**见第五节 |
| 5 | `qq-agent.lock` 当前还承担什么职责？ | **只记录 PID / 实例信息**，供面板查询与“停止”用；不再作为排他保障。退出清理仍校验“锁内容 == 自己 PID” |
| 6 | `killStaleSiblings` 是否仍有必要？ | **作为自动清理没必要**，已降级为 `diagnoseSiblings`：只记录 PID / 命令行 / 启动时间 / 是否早于本实例，不执行任何终止 |
| 7 | 生产数据是否完全未变？ | **是**（见第四节 hash） |
| 8 | 所有测试是否通过？ | 见第三节 |

---

## 一、三个批次与 commit

| 批次 | commit | 内容 |
|---|---|---|
| A1 | `ea552ef` | 统一 DATA_DIR 解析（`src/data-dir.js`）；config/main 接入；移除静默迁移 |
| A2 | `1eb55a7` | 3210(+PROFILE) 独占守门；删端口顺延；acquire 移到 listen 后；端口固定 |
| A3 | 本次 | 锁降级为诊断；面板/启动器按 PROFILE；入口一致性测试；回归 |

---

## 二、改后的启动链

```
入口（5 个）
  ↓
Electron main.js / Node server.js
  ↓
resolveDataDir()  → 同一 DATA_DIR（env > 打包安装目录 > 项目根；PROFILE 后缀）
  ↓
createApp()   ← 只构造对象/日志，不连 QQ、不起定时器
  ↓
start()
  ├─ listenExclusive(server, 3210 + (PROFILE-1)*100, '127.0.0.1')
  │    ├─ EADDRINUSE → 抛 INSTANCE_ALREADY_RUNNING → 进程退出（不碰锁/不启动业务）
  │    └─ 成功 → 继续
  ├─ acquireInstanceLock()        ← 此时才写 qq-agent.lock（PID 记录）
  ├─ registerLockCleanup()
  ├─ telemetry / reconcile / image-cache / usage
  ├─ reloadSkills（插件 activate）
  ├─ SnowLuma
  ├─ onebot.connect()
  └─ proactive / reminder 循环
```

---

## 三、测试结果

### 3.1 专项

| 套件 | 结果 |
|---|---|
| `r8-0-data-dir-test` | 13 / 13 |
| `r8-0-single-instance-test` | 13 / 13 |
| `r8-0-entry-consistency-test` | 17 / 17 |
| `instance-lock-sibling-test`（诊断版） | 18 / 18 |
| `usage-e2e`（端口隔离后） | 23 / 23 |

单实例专项覆盖：首实例成功、第二实例 EADDRINUSE、并发只一个成功、释放后可绑、无关服务占端口同样拒绝、源码无顺延、listen 在 acquire 之前、PROFILE=2 → 3310/data-2。

### 3.2 全量回归

**51 项：47 PASS / 4 FAIL**。4 项全部是基线既有失败（与 W5/R8-B 时相同的 `selftest` / `tools-skill-audit` / `setup-qq-version` / `gallery-test`），本轮没有新增失败。

**A2 的连带修复**：删掉 3210–3219 顺延后，`render-test` 不再能"借"到 3211，第一次回归时因 3210 被生产实例占用而失败（`INSTANCE_ALREADY_RUNNING`）。已改为在临时 `config.json` 里写 `server.port=40991`（与 `usage-e2e` 同法），修复后单跑 85 项全过、复跑回归通过。这是守门生效后的必要回归适配，不是放水。

---

## 四、生产数据

| 项 | 实施前 | 实施后 |
|---|---|---|
| `data/learned.json` sha256 | `A065EFE2…D193` | `A065EFE2…D193` |
| `data/memory` 文件数 | 1 | 1 |
| `data/memory` 聚合 sha256 | `5D4B8C9E…7C56` | `5D4B8C9E…7C56` |
| `data/qq-agent.lock` | `25984` | `25984`（未改动） |

**未修改生产记忆、未迁移、未杀生产进程、未重启生产机器人。**

---

## 五、已知限制 / 未验证

| # | 限制 | 影响 | 建议 |
|---|---|---|---|
| 1 | **8899 面板“启动机器人”不继承面板的 PROFILE** | 面板用 `spawn('explorer.exe', [bat])`，explorer 用系统环境，PROFILE 丢失 → 启动的是默认实例 | 后续改为 `spawn(cmd, ['/c', bat], { env: {...process.env}, windowsHide })`，需单独验证不破坏原有启动能力 |
| 2 | 打包模式未实测 | DATA_DIR 统一只有代码推导 + 单元模拟（`resources/app(.asar)` 两种布局） | 下次打包后跑一次 `resolveDataDir` 实测 |
| 3 | Electron `requestSingleInstanceLock` 仍存在 | 它以 `DATA_DIR/electron-user-data` 为界；不同 PROFILE 可并存（设计如此），同 PROFILE 在端口前再被它拦一次 | 保留（双保险），不冲突 |
| 4 | 端口被外部程序占用 | fail-closed，QQ-agent 不能启动 | 预期行为；日志会明确 `INSTANCE_ALREADY_RUNNING` |
| 5 | 20:13 事故真因 | **仍未查清**，本工作包不解释、不标记已查明 | 另立调查（单实例路径下的发送/落盘失败） |

---

## 六、分类

| 项 | 分类 |
|---|---|
| A1 统一 DATA_DIR | PASS |
| A2 3210 守门 | PASS |
| A3 入口/旧锁/诊断 | PASS |
| 生产数据未变 | 见第四节 |
| 20:13 真因 | **INCONCLUSIVE**（不在本工作包范围） |

---

## 七、本轮明确没做

- 未改 Memory Hub 内部结构；
- 未改生产记忆文件、未迁移；
- 未实施 OS 原生互斥 / fencing token；
- 未改聊天存档锁；
- 未杀任何生产进程、未重启生产机器人；
- 未处理 R8-B 三态（已完成，未再动）、未启动 R8-C。

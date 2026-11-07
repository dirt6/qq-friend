# R8-0-A2 实施前调查：3210 守门与启动顺序

> 时间：2026-11-03
> 状态：**只读调查，未改代码**
> 前置：A1（统一 DATA_DIR）已完成 `ea552ef`
> 结论：**发现一处方案假设与现有结构的冲突（PROFILE 多开），A2/A3 暂停等拍板**

---

## 一、启动调用链（当前真实路径）

```
入口 1  npm start
          → electron .  →  electron/main.js
入口 2  启动QQ机器人.bat
          → electron.exe "%~dp0." --no-sandbox  →  main.js
入口 3  快速启动.bat
          → 快速启动人设.ps1  →  cmd /c 启动QQ机器人.bat  →  入口 2
入口 4  启动控制面板.bat
          → 8899 scripts/web-panel-server.mjs
            → POST /api/ops/bot/start  →  explorer 打开 启动QQ机器人.bat  →  入口 2
入口 5  npm run server / node src/server.js
          → src/app.js createApp()
```

共同路径：

```
main.js / server.js
  ↓
resolveDataDir()                         ← A1 已统一（env > 打包安装目录 > 开发项目根）
  ↓
[仅 Electron] app.requestSingleInstanceLock()
  （userData = DATA_DIR/electron-user-data，仅拦 Electron 之间）
  ↓
createApp()
  ├─ logger.prune()                      ← 写日志（副作用，但非业务）
  ├─ acquireInstanceLock()               ← 写 qq-agent.lock（早于 listen！）
  ├─ new ChatStore / MemoryStore / Orchestrator / OneBot / SendQueue
  ├─ http.createServer()
  └─ 路由装配
  ↓
start()
  ├─ for (p = 3210; p < 3220; p++) listenOn(p)   ← **端口顺延**
  ├─ telemetry / sessions.reconcile / image-cache / usage 预热
  ├─ reloadSkills()                      ← 插件 activate（autonomous / silence-ping 定时器）
  ├─ SnowLuma 启动
  ├─ onebot.connect()                    ← 连 QQ
  └─ proactive / reminder 定时器
```

---

## 二、确认存在的绕过路径

| # | 路径 | 现状 |
|---|---|---|
| 1 | **3210 被占后顺延 3211–3219** | `app.js:1510` 的 `for (p = basePort; p < basePort + 10; p++)` 会一直试到 3219，第二个实例能完整启动业务 → **真实双开** |
| 2 | **`node src/server.js` 无 Electron 锁** | 只靠 `instance-lock`；锁被删 / DATA_DIR 不同时直接启动 |
| 3 | **打包模式 DATA_DIR 不一致** | A1 已修；修复前 Electron=安装目录/data，Node=resources/app/data → 两套锁 |
| 4 | **PROFILE 端口偏移** | `portOffset()`：PROFILE=2 → 3310 + data-2/；这是**设计上的多开**，与"所有实例同端口"冲突 |

---

## 三、冲突点：`QQ_AGENT_PROFILE` 多开

`src/profile.js`：

```js
export function profileSuffix() { return isSecondary() ? `-${PROFILE_ID}` : ''; }
export function portOffset() { return isSecondary() ? Number(PROFILE_ID) * 100 : 0; }
```

`config.js:24` 用它改数据目录，`app.js:1507` 用 `portOffset()` 改端口。也就是说：

- 同一份代码，`QQ_AGENT_PROFILE=2` 会得到 `data-2/` + 3310；
- 两个 PROFILE 实例**本来就不会共享记忆或端口**；
- 但你的 A2 要求「所有 QQ-agent 实例使用完全相同的绑定地址和端口」。

这两件事不能同时成立。需要你选：

### 选项 A（推荐）：保留 PROFILE，守门端口 = `3210 + portOffset()`

- 同一 PROFILE（同一 `DATA_DIR`）只能有一个实例 → 解决"意外双开"。
- 不同 PROFILE 是**显式选择**的独立实例（不同数据目录/端口/锁），不属于"两个实例写同一份记忆"。
- 生产（PROFILE 为空）= 3210，完全满足"生产只有一个实例"。
- 改动小，不破坏现有功能。

### 选项 B：废除端口偏移，所有实例一律 3210

- 任何第二个实例（包括 PROFILE=2）都会在 3210 上失败 → PROFILE 多开实际被禁用。
- 数据目录仍按 PROFILE 分开，但第二个永远起不来。
- 符合字面要求「所有实例同端口」，但会**移除一个现有能力**。

**我的建议是 A。** 但这是产品决策，不由我定。

---

## 四、A2 必定要做的改动（与选项无关）

1. 删除 `app.js:1510` 的端口顺延循环：只绑 `3210 + portOffset()`；`EADDRINUSE` → 抛 `INSTANCE_ALREADY_RUNNING`，进程退出。
2. `listen` 成功之前不启动业务：把 `acquireInstanceLock()` 从 `createApp` 移到 `listen` 成功之后（第二个实例失败时完全不碰锁）。
3. `start()` 的顺序保持：listen → telemetry/skills/SnowLuma/onebot/loops（当前已经如此，只需确保 listen 失败时不再往下走）。
4. 监听地址固定 `127.0.0.1`（不读配置），避免 IPv4/IPv6 双绑绕过。
5. 端口被无关程序占用：同样 fail-closed，日志区分 `INSTANCE_ALREADY_RUNNING`（若是 `EADDRINUSE` 但无法确认占用者，仍拒绝启动）。

## 五、A3 需要先拍板的点

1. **`killStaleSiblings` 是否降级为诊断**（只记录、不杀）？
   - 理由：3210 守门后，能走到 acquire 的进程说明端口空闲，残留进程没有业务价值；杀进程的风险大于收益。
   - 若保留自动清理，需要扩大匹配范围（node 的 cwd），而那是"扩大杀进程范围"，按你的规则要单独授权。
2. 旧 `qq-agent.lock` 的职责：建议保留为 PID 记录（面板"停止"按钮要用），但**不再作为单实例保障**；退出时仍校验所有权。

---

## 六、需要你拍板

1. **选项 A（保留 PROFILE 端口 offset）还是选项 B（一律 3210，禁用多开）？**
2. **A3 的 `killStaleSiblings`：降级为诊断，还是保留自动清理（需授权扩大匹配）？**

拍板后我继续 A2 → A3，每个独立 commit，最后跑全量回归。

---

## 七、本轮已完成（A1）

- `src/data-dir.js`：唯一解析函数（env > 打包安装目录 > 开发项目根；缺 appRoot fail-closed）。
- `src/config.js` / `electron/main.js`：都改用该函数；移除 `%APPDATA% → 安装目录` 的静默复制，只读报告。
- `test/r8-0-data-dir-test.mjs`：13 项通过。
- 相关回归：learned 46、state-store 22、message-id、web-panel 53、prompt-anchor 全过。

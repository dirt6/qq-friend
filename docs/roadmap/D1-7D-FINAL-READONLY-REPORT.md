# D1-7D：4.0 最终只读核验与遗留风险归档

> 时间：2026-11-04
> 基线：HEAD `fe95596`，工作区干净
> 性质：只读；**未修改/删除/恢复/标注生产数据**
> 结论：数据层核验全 SAME；架构一致性基本成立；但发现**生产热重载导致插件/Core 运行时版本不一致**，D1-7E 建议 **HOLD**

## 一、核验窗口与进程

| 项 | 值 |
|---|---|
| 开始 | 2026-11-04T22:16:52.894+08:00 |
| 结束 | 2026-11-04T22:26:33.469+08:00 |
| 进程 PID | `25300`（electron） |
| 进程启动 | 2026-11-04 20:26:53（boot-diag 20:26:54/58 核心启动） |
| 运行版本 | `/api/version=0.4.0`（与 package.json 一致） |
| 端口/实例 | 3210，PID 与 lock 一致 |

## 二、生产数据核验（开始/结束 SHA256）

| 数据 | 路径 | 大小 | 开始 SHA256 | 结束 |
|---|---|---|---|---|
| token-usage | `data/token-usage.json` | 1300 | `be1c63e2…` | **SAME** |
| companion-events | `data/companion-events`（1 文件） | 335992 | `fc2142f8…`（active `b1362a65…`） | **SAME** |
| learned | `data/learned.json` | 7549 | `7fa172e0…` | **SAME** |
| pending | `data/diary-meta/pending.json` | 7264 | `c0a379cf…` | **SAME** |
| idempotency | `data/diary-idempotency.json` | 16801 | `e4cee3e2…` | **SAME** |
| dsh-sessions | `data/dsh-sessions.json` | 196 | `95bfd664…` | **SAME** |
| companion-state | `data/companion-state.json` | 9695 | `009bc64d…` | **SAME** |
| diary-meta | `data/diary-meta`（1 文件） | 7264 | `62e6143b…` | **SAME** |
| 日记正文 | `E:/dsh/日记`（32 文件） | 40329 | `1ec13e8a…` | **SAME** |
| ChatStore 私聊 | `data/messages`（1 文件） | 1765900 | `68ef2603…`（private `ff2680f4…`） | **SAME** |
| usage-days | `data/usage-days`（23 文件） | 158146 | `6486e93b…` | **SAME** |

- 核验窗口内**没有**生产 hash 变化；没有正常业务写入需要归因；
- 未发现开发工具写入。

## 三、关键发现：生产热重载导致运行时版本不一致（UNKNOWN 风险）

生产日志：

```
22:11:08 检测到变化：autonomous，重新扫描… 14 成功
22:11:15 检测到变化：autonomous，重新扫描… 14 成功
```

- 本批 D1-7C 修改了 `plugins/autonomous/index.js` 与 `src/**`；生产 app 开启了 hotReload watcher，编辑插件触发热重载；
- `plugin-loader` 只对**入口 URL** 加时间戳（`import(entryUrl?t=...)`），依赖模块（`src/companion-core/index.js`）仍在主进程 20:26 的 ESM 缓存中；
- 因此生产当前可能处于：**新 autonomous 插件 + 旧 Core（无 `context.readPrivateHistory`）**；
- 下一次自主运行若调用 `lastUserMessageAt/readRecentChat/chatTopicsToday`，可能抛 `readPrivateHistory is not a function`，影响自主轮次（进程未崩溃，尚未观察到，因为 22:11 后没有自主运行记录）。
- 这是**运行态版本不一致**，不是数据污染；生产数据 hash 仍全部 SAME。
- 状态：**UNKNOWN/INCONCLUSIVE**（未实际触发下一次自主运行；未重启验证；未修改生产）。

> 本批禁止重启/部署，因此不做修复动作。D1-7E 前必须由机主授权重启（加载一致版本），或提供兼容补丁（会让插件继续走旧文件回退，违背 4.0 私有历史统一，仅作应急）。

## 四、deploy-acceptance-test 偶发失败调查

- 历史失败：全量回归中 `POST /api/reset-data` 的 200/data 删除断言失败；单独复跑 17/17 通过。
- 只读检查：
  - reset 路由顺序：preflight → `quiesceForReset()`（5s 超时）→ `resetData`；
  - 若 quiesce 未 drain（409）或 resetData 失败（500），两项断言都会失败；
  - 测试使用独立 bootApp/随机端口/临时数据；无共享端口/DATA_DIR；失败时未保留响应体细节。
- 压力测试（独立临时 DATA_DIR，未碰生产）：
  - 10 次**独立子进程**启动 + POST reset：**10/10 200 completed**；
  - 5 个并发独立子进程：**5/5 200 completed**。
- **未能确定性复现**。倾向环境/负载下 quiesce 5s 或 reset 备份时序，但无直接证据。
- 结论：**FLAKY / INCONCLUSIVE**；不放宽断言、不跳过 reset 保护。后续建议在失败时记录 `r.text`/stages/activeRuns，以定位 409 vs 500。

## 五、26 个 noMarker 测试风险分类

> 来源：`scripts/test-isolation-audit.mjs`。本批只读，不改造。

| 风险 | 测试 | 说明 |
|---|---|---|
| **HIGH** | `companion-events-test.mjs` | 备份/重命名/写/恢复**生产** `data/companion-events/active.ndjson`；worker 子进程 |
| **HIGH** | `prompt-version-test.mjs` | 向生产 `data/prompt-archive/turns.ndjson` 写测试行并删除清理；失败可能污染 |
| MEDIUM | `autonomous-memory-test.mjs` | 写 `os.tmpdir` 临时文件；无 DATA_DIR |
| MEDIUM | `diary-edit-worker.mjs` | worker 写 outFile（由测试传入，需确认在临时根） |
| MEDIUM | `memory-port-lock-worker.mjs` | worker 写临时文件 |
| MEDIUM | `setup-qq-version.mjs` | spawn `scripts/setup.mjs --check`，网络/外部状态 |
| LOW | `_ui-load`, `autonomous-2.1`, `autonomous-2.3`, `autonomous-actions`, `card-parse`, `coverage-ui`, `intent`, `now-playing`, `qq-process-detect`（wmic 只读）, `scroll`, `sender-file-uri`, `skill-modal-ui`, `speech-to-text`, `stage26b4`, `sticker-context`, `token-replace`, `vendor-mirror`, `web-search-parse`, `xhh-sign` | 纯函数/解析/UI/只读 |
| LOW（只读生产） | `instance-lock-sibling-test` | 读 `data/qq-agent.lock`；不写 |

- HIGH 两项**均未纳入 regression**；建议独立整改为 `_isolation` 临时根后再启用。
- MEDIUM 进入维护清单，确认 worker outFile 在临时根、setup --check 不写账户。

## 六、D1-7C 遗留风险复核

| 项 | 结论 |
|---|---|
| autonomous 是否仍有私聊文件直读 | **无**（静态扫描无 `private_*.json`/messages 读；3 处均 `core.context.readPrivateHistory`） |
| ChatStore 是否唯一维护者 | **读侧是**；但发现 `plugins/silence-ping` 直接读/写 `data/messages`（用同一 `.lock` + 原子写）——兼容例外，非第二存储 |
| Core 未注入 store 时是否危险回退 | **无文件回退**；`readPrivateHistory` 返回 `{ok:false}`；autonomous warn 后空 |
| 损坏存档是否被当正常空 | **不会**：`chatStatus` 检测结构，Core 返回 `ok:false`；autonomous warn（旧 helper 静默空，已记录有意差异） |
| 旧数组格式 | 仅历史兼容限制：旧 helper 接受数组，ChatStore 只接受 `{messages}`；生产为对象 |
| setChatStore/clear 生命周期 | app 单例注册；测试可 clear；无多 app 并发；热重载不重载 Core（见 §三风险） |
| ChatStore 写入原子/读取半写 | `withFileLockAsync` + `writeFileAtomic`（tmp+rename）；读取可能看到旧/新完整版本，不会半 JSON |

## 七、4.0 架构一致性

### 实际调用图

```
聊天 Orchestrator.wake
  → Core.readChatSnapshot
      → companion.state/promptSection
      → activeGoal/pausedGoals/activePending
      → diary.readDay
      → activity (readActivities)
      → memoryHub.stats
      → chatStore.recent
  → buildSystemPrompt/UserPrompt（MemoryStore 群友印象）
  → 日记写：Core.diary.write

自主 autonomous
  → Core.state/pending/goals
  → Core.diary.readRaw/write/removeLine/relevelLine
  → Core.context.readPrivateHistory
  → autonomous.json Round/Action（领域）

插件
  → Core ports（默认只读）/ 领域兼容
```

- 聊天/自主伙伴状态：统一经 Core；
- Goal/Pending：`companion/state.js` 唯一维护；
- Round/Action：autonomous 领域；
- Memory Hub：只读聚合，无新存储；
- 无平行长期记忆/重复写入；
- prompt 文案与顺序未变（4.0 golden 16 项仍过）；
- 调度/模型/预算/DSH Session 未变（无配置/代码调用变更）。

### 例外清单

1. `plugins/silence-ping` 直接读写 `data/messages`（同一锁/原子写；兼容，非第二存储）；
2. `skills/diary` 直接写 diary 领域；
3. `dsh-gateway`/`routes`/`memory.js` 对 learned 的领域/管理访问；
4. `autonomous` 的 `autonomous.json` Round/Action 仍由自身领域维护（设计如此）；
5. **运行态热重载版本不一致（§三）**。

## 八、UNKNOWN / INCONCLUSIVE

1. 生产热重载后新插件 + 旧 Core 的实际影响（下一次自主运行未发生）——**UNKNOWN**；
2. deploy-acceptance 失败——**FLAKY/INCONCLUSIVE**（15 次复跑未复现，缺失败响应体）；
3. 26 noMarker 中 HIGH 两项未隔离；MEDIUM 4 项待确认；
4. D1-6 的浏览器/ACL/满盘/Electron/asar 仍 UNKNOWN（不影响本批数据核验）。

## 九、D1-7E 结项准入建议

**建议：HOLD（暂缓结项）。**

必须前置：

1. 由机主授权**重启生产**（或提供兼容应急补丁），消除 §三热重载版本不一致；重启后验证 autonomous 一次正常运行（不触发生产数据写入风险）；
2. 将 `companion-events-test`、`prompt-version-test` 改造为隔离根（HIGH）；
3. 对 deploy-acceptance 失败增加响应体/stages 记录，再观察 1–2 次全量；
4. 将 `silence-ping` 直写 messages 列入 5.0 前端口化清单（不阻塞 4.0 数据层核验，但应记录）。

满足 1–3 后，4.0 数据/架构层可结项；否则 D1-7E 不能声明“生产运行态一致”。

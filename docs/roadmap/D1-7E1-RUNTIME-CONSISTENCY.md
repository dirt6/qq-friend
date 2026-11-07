# D1-7E1：生产热重载运行态一致性调查（只读）

> 时间：2026-11-04
> HEAD：`590370b`
> 性质：只读源码/日志；未重启、未部署、未改配置
> 结论：热重载**不能保证依赖图版本一致**；生产 22:11 已发生新 autonomous + 旧 Core 的混合状态（UNKNOWN 影响）；建议以完整进程重启作为生产代码更新边界

## 一、机制事实

### plugin-loader

- `loadSkillDir()` 对入口 URL 加时间戳：`import(\`${entryUrl}?t=${Date.now()}\`)`（`src/plugin-loader.js:303-305`）；
- 该时间戳只作用于**插件入口文件**；其静态 import 的 `src/**` 依赖按原 URL 缓存，不会重新求值；
- watcher 监听 `plugins/`、`skills/`，变化后整体重新扫描（`fs.watch` + 600ms 防抖）；
- 旧实例退役顺序：setup 前 `deactivate`（停副作用）→ 新 setup → 成功才摘旧实例/清能力；setup 失败则 `activate` 旧实例并保留注册表；
- 加载失败（语法/导入错误）走 `hadPrevious` 分支保留旧实例；
- 新 setup 若已注册工具后抛错，会 `unregisterToolsBySkill` 回滚；**不调用新模块 dispose**（新模块尚未进入 registry）。

### 依赖缓存

Node ESM 缓存按 URL；`?t=` 只让入口成为新 URL，依赖（如 `src/companion-core/index.js`）仍命中旧缓存。生产 20:26 启动的进程里，Core 是旧版本；22:11 重载的新 autonomous 入口 import 的仍是旧 Core。

### Core 单例状态

- `src/companion-core/context.js` 的 `store` 是模块级单例；app 在创建 `ChatStore` 后 `setChatStore(store)`；
- 旧进程（20:26）没有该模块/调用；新 autonomous 与旧 Core 组合时，`core.context` 只有旧的 `recent/meta`，没有 `readPrivateHistory`；
- `createCompanionCore` 本身无全局实例；但 context store 是进程级单例，重载不会创建第二份 ChatStore。

### autonomous 生命周期

- `setup` 只注册工具；`activate` 才 `startLoop()`；`deactivate` 调 `stopLoop()`；
- 加载器在新 setup 前 deactivate 旧实例；失败时 activate 旧实例；成功后才注册新实例；
- 新 setup 不会在失败前启动 loop，故**不会出现两个 autonomous 定时器同时跑**；
- 但新模块的模块级状态（api、缓存）会残留；失败时未调用其 dispose。

### 其他插件

所有插件都通过入口缓存刷新；若其依赖的 `src/**` 在同一次编辑中被修改，同样可能出现混合版本。风险不限于 autonomous。

## 二、生产现场证据

- 日志 `22:11:08`、`22:11:15`：检测到 autonomous 变化，重扫 14 成功；
- 进程 PID 25300 未重启；版本 0.4.0；
- 22:11 后 autonomous-log 最后记录仍为 21:23，**未观察到下一次自主运行**；
- 因此“新插件 + 旧 Core”是否会在下一次 tick 抛 `readPrivateHistory is not a function` 尚未发生 → **UNKNOWN**；
- 生产数据核验窗口 hash 全 SAME（见 D1-7D）。

## 三、设计约束（不递归加时间戳）

递归给所有依赖加时间戳会：
- 使同一模块出现多份实例（context store、缓存、单例分裂）；
- 旧模块无法被回收，定时器/监听器重复；
- 无法保证依赖图一致（传递依赖仍可能旧）。

若设计热重载修复，必须先满足：

1. **依赖图版本一致**：入口与其全部依赖来自同一构建/快照；
2. **单例不分裂**：Core/ChatStore/context 只一份；
3. **旧实例资源释放**：deactivate + dispose 清定时器/监听器；
4. **失败可回滚**：完整旧实例继续运行；
5. **新旧不同时运行**。

当前实现只满足 3–5 的部分（deactivate/activate、失败保留），**不满足 1/2**。

## 四、受控重启方案（建议，不执行）

**以完整进程重启作为生产代码更新边界**：

1. 代码更新前：停止编辑 watcher 监听目录（或设 `extensions.hotReload=false`，需授权/配置变更）；
2. 记录生产关键 hash（pending/idem/learned/diary/events/token/dsh/companion/messages）；
3. 停止/重启 Electron（管理员快捷方式），确认 boot-diag、PID、3210、OneBot；
4. 启动后只读验证：
   - `/api/version`；
   - autonomous 一次 tick（等待或手动触发）无 `readPrivateHistory`/依赖错误；
   - 只有一个 autonomous 定时器/无重复日志；
   - 生产 hash 与重启前一致（正常业务写入除外，逐项归因）；
5. 失败回滚：保留上一版本代码/数据快照，重启回旧版本；
6. 不在热重载后混跑新插件+旧 Core。

**不建议**：递归时间戳、仅重载插件依赖、在 watcher 开启时编辑 `src/**` 后依赖热重载。

## 五、当前处置

- 本批不重启、不改 watcher 配置、不修改生产；
- 生产运行态一致性：**UNKNOWN**，等待机主授权重启/兼容方案；
- 数据完整性：PASS（D1-7D）。

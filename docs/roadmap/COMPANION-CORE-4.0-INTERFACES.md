# COMPANION CORE 4.0 接口

> 时间：2026-11-04
> 入口：`src/companion-core/index.js`

## 一、Core 导出

| 导出 | 说明 |
|---|---|
| `COMPANION_CORE_VERSION` | 当前 1 |
| `createCompanionCore(deps)` | 组合根；deps: memoryHub/companion/diary/readActivities/chatStore |
| `createCompanionPorts(core,{allowWrite})` | 插件最小端口（默认只读） |
| `CompanionCoreInitError` | 初始化失败（ECOMPANION_CORE_INIT） |

## 二、能力面

### memory（只读）
`search(opts)` / `get(type,id)` / `stats()`

### state
`get()` / `update(fn)` / `prompt(opts)`

### goals
`active()` / `paused()` / `create()` / `createUser()` / `update()` / `pause()` / `resume()` / `complete()` / `cancel()` / `supersede()` / `set()` / `clear()` / `bumpAsk()`

### pending
`active()` / `add(opts)` / `settle(id,outcome,opts)`

### diary
`root()` / `readDay(day,root)` / `readRaw(day,root)` / `readLines(file)` / `write(opts)` / `removeLine(opts)` / `relevelLine(opts)`

### activity
`recent(opts)` → `{ok,items}`（Core 快照内转数组）

### context
`recent(chatKey,opts)` / `meta(chatKey)`（需注入 chatStore）

### readChatSnapshot
```js
core.readChatSnapshot({ chatKey, now, contextLimit })
```
返回：
```js
{
  schema: 1,
  generatedAt, chatKey,
  companionText,   // 仍由 companion.promptSection() 生成（字节不变）
  state,           // 原始伙伴状态（只读）
  goals: { active, paused },
  pending: [],
  activity: [],    // readActivities().items
  diary: [],       // readDay(today)
  memoryStats,
  context: []      // chatStore.recent(chatKey,{limit})
}
```
- 任何可选读取失败都降级为空/ null，不抛给聊天；
- 不写盘；不改变 prompt。

## 三、插件端口

```js
const ports = createCompanionPorts(core, { allowWrite: false });
ports.memory / state / goals / pending / activity / diary
```
- 默认只读：`diary` 无 `write/removeLine/relevelLine`；
- `allowWrite:true` 才暴露写方法，仍委托领域模块；
- 端口不含文件路径/fs，不允许任意路径/命令。

## 四、错误契约

| 场景 | 行为 |
|---|---|
| Core init 依赖缺方法 | `CompanionCoreInitError`（ECOMPANION_CORE_INIT） |
| 领域写入失败 | 原样返回领域结果（`{ok:false, code/reason/error}`），Core 不改写 |
| 可选读取失败 | 快照降级为空，不阻断聊天 |
| ports 缺 core | 抛 `CompanionCoreInitError` |

## 五、兼容

- `createCompanionCore` 原有接口保持不变（18 项旧测试通过）；
- 新增方法为增量；旧调用方可继续用 `core.state/pending/goals`；
- `Core.diary.readLines` 参数改为领域真实签名（file），旧无生产调用方。

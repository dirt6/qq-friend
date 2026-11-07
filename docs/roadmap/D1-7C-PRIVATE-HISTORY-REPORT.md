# D1-7C：autonomous 私聊上下文统一入口报告

> 时间：2026-11-04
> 基线：HEAD `c9c06ac`；本批只迁移 autonomous 私聊历史读取
> 结果：Core `readPrivateHistory` 接入；autonomous 不再直接读 `private_*.json`；parity 13/13；全量 87 项 83 PASS/4 既有基线；生产 hash 全 SAME

## 一、阶段 0：只读调查

### 旧读取链（3 处，全部直接文件）

| 函数 | 位置 | 数据流 | 语义 |
|---|---|---|---|
| `lastUserMessageAt()` | `plugins/autonomous/index.js:192` | `DATA_DIR/messages/private_<master>.json` → JSON → messages → 遍历全部 | 取 `!self` 且 `ts>0` 的最大 ts；异常静默返回 0 |
| `readRecentChat(limit)` | 同文件 `:821` | 同文件 → `list.slice(-limit)` → map `{self,text,ts}` | `text` 去空白、截 300、空文本过滤 |
| `chatTopicsToday(max)` | 同文件 `:838` | 同文件 → 全量过滤 `!self && ts>=今日0点 && text` | 取最后 max 条、每条 40 字 |

### ChatStore

- `recent(chatKey,{limit,offset,includeSelf,mine})`：保留插入顺序，取最后 `limit` 条；`offset` 跳过最近 N 条；`mine` 只取自己；
- 文件格式 `{chatKey,nextLocalId,messages:[...]}`；缺失/损坏时 `loadChat` 返回空会话（损坏会备份并 warn）；
- 写入 `appendIncoming/appendSelf`；按 `maxMessagesPerChat` 截断。

### Core context 现状

- 只有 `context.recent/meta`，依赖 `createCompanionCore({chatStore})` 注入；
- autonomous 创建 Core 时未注入 store，因此没有可用 context。

### 调用方依赖

- 无调用方依赖文件路径/原始 JSON 结构；autonomous 三个函数只消费 `{self,text,ts}`；
- 无同步返回值要求（均为同步函数，但 Core 也可同步返回）；
- 读取期间文件可能被 ChatStore 写入；旧路径直接 readFile 有短窗口撕裂风险。

## 二、阶段 1：只读接口

新增：

```js
core.context.readPrivateHistory(chatKey, { limit=40, offset=0, includeSelf=true, mine=false, since=0, all=false })
// → { ok:true, chatKey, messages:[{self,text,ts,mid,id,senderId,recalled}], count }
// → { ok:false, error }  // 非法 chatKey / 未注入 store / 存档损坏
```

- 只接受 `private:<digits>`；非法明确失败；
- 缺失文件 = 正常空（ChatStore 语义）；
- **损坏文件**：通过 ChatStore 新增只读 `chatStatus()` 检测，Core 返回 `ok:false`，不伪装空历史；
- ChatStore 仍是唯一维护者；Core 不写、不建第二份历史；
- `src/companion-core/context.js` 提供 app 级 `setChatStore/getChatStore`，app 在创建 `ChatStore` 后注册；Core 优先用注入实例，其次注册实例。

## 三、阶段 2：Parity

`test/d1-7c-private-history-parity.mjs` **13/13 PASS**：

| 覆盖 | 结果 |
|---|---|
| 空历史 | PASS |
| 单条 / 多条 / self | PASS |
| 同时间戳顺序 | PASS |
| 不同时间戳 / limit 边界 | PASS |
| all / since | PASS |
| 不同 private chatKey | PASS |
| 缺失文件 | PASS（均空） |
| 非法 chatKey | PASS（Core 明确 false） |
| 损坏文件 | PASS（Core 明确 false；旧 helper 静默空，**有意改进**） |
| 注入缺失 | PASS（明确 false） |
| 读取期间并发写入 | PASS（不崩溃，返回一致快照） |
| autonomous `lastUserMessageAt` 实际入口 | PASS（经 Core，最大值正确） |

比较字段：数量、内容、顺序、ts、截取边界、异常语义。

## 四、阶段 3：接线

- autonomous 三处全部改为 `companionCore.context.readPrivateHistory`；
- 删除 `private_*.json` 直接 `fs.readFileSync`；
- 读取失败：`!ok` 时 `warn(...)` 并返回空（不静默；prompt 仍不注入额外内容）；
- 不改变 prompt 文案/顺序、模型调用、调度、ChatStore 写入；
- `text` 归一化/截断仍由 autonomous 侧完成（300/40 字），保持原样。

## 五、阶段 4：验收

| 项 | 结果 |
|---|---|
| D1-7C parity | **13/13** |
| autonomous | 97/97 |
| Companion Core | 18/18 |
| Core 集成 | 12/12 |
| 4.0 专项 | 16/16 |
| 全量回归 | **87 项：83 PASS / 4 FAIL**（既有基线 `selftest`、`tools-skill-audit`、`gallery-test`、`setup-qq-version`） |
| 新增失败 | 无（本批首次全量即通过；此前 D1-7B 的 deploy-acceptance 环境偶发本次未出现） |
| prompt golden | 未改（4.0 16 项继续通过） |
| 直接私聊文件访问 | autonomous 静态扫描无 `private_*.json`/messages 读 |

## 六、生产 hash（全量前后）

| 文件 | 结果 |
|---|---|
| token-usage | **SAME** `be1c63e2…` |
| companion-events | **SAME** `b1362a65…` |
| learned | **SAME** `7fa172e0…` |
| pending | **SAME** `c0a379cf…` |
| idempotency | **SAME** `e4cee3e2…` |
| dsh-sessions | **SAME** `95bfd664…` |
| companion-state | **SAME** `009bc64d…` |
| 11-04 日记 | **SAME** `4335f4cd…` |

未部署/重启/reset；未改 prompt/模型/调度/预算/Goal/Pending 生命周期。

## 七、差异与风险

1. **损坏存档**：旧 autonomous helper 静默空；新 Core 明确 `ok:false`，autonomous warn 后仍返回空。可见 prompt 不变，但日志更明确（有意改进）。
2. **旧数组格式**：旧 helper 接受 `[...]`；ChatStore 只接受 `{messages:[...]}`。生产为对象格式；若未来出现数组存档，Core 会判损坏/空。未做迁移。
3. **master 清洗**：`lastUserMessageAt` 现在与另外两处一致，去掉非数字字符；生产 master 为数字，无影响。
4. **全局注册**：`setChatStore` 是 app 组合根单例；Core 仍以注入优先，测试可 `clearChatStore`。
5. 未做跨进程/多实例测试；ChatStore 写入仍由原锁保证。
6. 旧 helper 的读取缓存无；Core 直接 `recent` 每次读当前内存态，读取期间写入返回一致快照（测试覆盖）。

## 八、提交

本批独立 commit（Core/context、app 注入、autonomous 接线、ChatStore chatStatus、parity 测试、回归列表、本报告）。工作区 commit 后干净。

# C0：自主行为读取路径调查（只读）

> 时间：2026-11-03
> 范围：`plugins/autonomous/` 的全部读取（import + fs）
> 结论：只把「伙伴状态/Goal/Pending」接入 Companion Core；聊天历史与日记保留原接口（格式/通道不兼容，见第四节）

---

## 一、import 清点

| import | 用途 | C1 处理 |
|---|---|---|
| `src/config.js`（DATA_DIR/getConfig） | 配置与数据目录 | 保留（基础设施） |
| `src/companion/state.js`（readCompanion/activePending/settlePending/clearGoal/setGoal/addPending/promptSection/bumpAskCount） | 伙伴状态、Goal、Pending | **状态/Goal/Pending 经 Companion Core**；clearGoal/setGoal/bumpAskCount 仍走领域模块（Core 暂无对应写接口） |
| `src/diary/index.js`（write） | 日记写入 | 保留（写入属 D 批次） |
| `./lib/*`（budget/usage/sources/planner/state/intent/digest/goal-judge/social 等） | 自主活动自身逻辑 | 保留 |
| `src/token-ledger.js`、`src/model-calls.js`、`src/draw.js` | 账本/调用记录/画 | 保留 |

## 二、fs 读取清点（逐项）

| 行 | 读取 | 分类 | C1 处理 |
|---|---|---|---|
| 153/157 | `data/sessions/*.json` 的 mtime | 聊天活动估算 | 保留（元数据，不是长期记忆） |
| 190 | `data/messages/private_*.json` | **聊天历史** | 保留（无 ChatStore 注入通道；不误并入长期记忆） |
| 350 | 日记 `.md`（readRecentDiary） | 日记领域 | 保留（与 `diary.readDay` 返回格式不同） |
| 499 | `STORE`（autonomous 自身状态） | 私有状态 | 保留 |
| 600/613 | 日记目录/行（删除、改级） | 日记领域管理 | 保留（文件管理） |
| 662/675 | 日记目录/行（搜索） | 日记领域 | 保留（同上） |
| 911/928 | `data/messages/private_*.json` | **聊天历史** | 保留 |
| 1103 | `ACTIVITY_LOG` | 自主私有活动日志 | 保留（不是 Memory Hub 的 activity 层） |
| 1982 | `data/social-config.json` | 配置 | 保留 |
| 2149 | 画文件（读 buffer） | 媒体 | 保留 |

## 三、接入结论（C1）

| 数据 | 目标接口 | 是否接入 |
|---|---|---|
| companion state | `core.state.get()` | ✅ 接入 |
| Goal（读取） | `core.state.get()` 的 goals | ✅ 接入（经 state） |
| Pending（读取/结算/新增） | `core.pending.active/settle/add` | ✅ 接入 |
| companion prompt 段 | `core.state.prompt()` | ✅ 接入（新增 Core 方法） |
| 长期记忆检索 | `core.memory.search` | ⏳ 预留（自主当前不读 learned；未来跨层检索用） |
| 聊天历史 | 原 chat store 文件 | ❌ 保留（无注入通道） |
| 日记读取 | `diary/index.js` + 文件 | ❌ 保留（格式不同） |
| Activity | `ACTIVITY_LOG` | ❌ 保留（私有日志） |

## 四、为什么保留原接口（不强行迁移）

1. **聊天历史**：autonomous 是独立 DSH 插件，没有 app 的 `ChatStore` 实例；`lastUserMessageAt/readRecentChat/chatTopicsToday` 读的是同一份 `private_*.json`，由聊天存档维护。将其接入需要给插件注入 store（E 批次），否则会复制数据或引入第二来源。
2. **日记读取**：`readRecentDiary` 返回 `{day, text}`（整段），`diary.readDay` 返回 `{mood, importance, text}`（逐条）。替换会改变自主 prompt 的日记段落。
3. **Activity**：`ACTIVITY_LOG` 是自主插件自己的活动流水，不是 Memory Hub 的 `readActivities`（后者读 sessions round）。

## 五、C1 的行为一致性

`core.state.get()` → `companion.readCompanion()`；`core.pending.*` → 同名领域函数；`core.state.prompt()` → `companion.promptSection()`。**纯转发，无缓存、无格式转换、无额外 IO。** 自主 prompt 内容与决策路径不变。

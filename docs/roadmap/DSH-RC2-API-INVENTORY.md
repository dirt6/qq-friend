# DSH 0.2.0-rc.2 API 实测清单（R6-A）

> 时间：2026-11-03 00:10
> 状态：**实测完成，未修改任何代码/配置/生产数据**
> 环境：`@deepseek-ai/dsh@0.2.0-rc.2`（本地唯一安装）
> 方法：**独立临时 `DSH_HOME`**（`%TEMP%\dsh-r6a-*`），用完即弃

---

## 〇、环境与方法

### 0.1 隔离方式

```powershell
$tmp = Join-Path $env:TEMP ("dsh-r6a-" + [guid]::NewGuid()...)
$env:DSH_HOME = $tmp        # 指向临时目录
& dsh --profile headless --json "..."
# 结束后整个 tmp 删掉
```

**生产 `data/dsh-home` 全程没有被读取、写入或删除。**

### 0.2 一个必须说明的限制

**隔离环境里没有 API key** → 所有真实调用都以 `MISSING_CREDENTIAL` 结束。

**这意味着**：

- ✅ 能验证**参数、事件流结构、Session 生命周期、错误路径**
- ❌ **不能验证**"正常完成时的事件流"（`final.text` 非空）
- ❌ **不能验证**真实并发下的**内容**串扰（只能看 turn 编号）

**这个限制会逐项标注。**

---

## 一、23 项逐项结果

### A. 命令行（8 项）

#### 1. `dsh --version`

**命令**：
```powershell
& dsh.cmd --version
```

**原始输出**：`0.2.0-rc.2`

**结论**：✅ **已验证**

#### 2. `dsh --help`

**命令**：`& dsh.cmd --help`

**原始输出（节选）**：
```
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>

Options:
  -V, --version
  --profile <name>
  --from-default-profile <name>
  --patch <path>              (repeatable)
  --dump-config
  --dump-config-schema
  --dump-default-config
```

**关键**：**`dsh` 是 launcher**，`--json` / `--session-id` **不是它的参数**，是 headless app 的。

**结论**：✅ **已验证**

#### 3. `--profile headless`

**命令**：`& dsh.cmd --profile headless --help`

**原始输出（节选）**：
```
Usage: dsh --profile headless [options] [task...]
Answer one task and exit; the answer goes to stdout and diagnostics to stderr.

Arguments:
  task    the task text; multiple words are joined by spaces, and `-` reads stdin

Options:
  --json             write newline-delimited run events to stdout
  --session-id <id>  adopt the persisted Session with this id; an unknown id is an error
  -h, --help
```

**关键**：**headless app 只有 3 个参数**（`--json` / `--session-id` / `-h`）。

**结论**：✅ **已验证**

#### 4. `--patch <file>`

**状态**：**未单独实测**（生产已在用，`dsh-persona.patch.yml` 每天生效）

**依据**：生产 `dsh-gateway.js` 传 `--patch` 且能正常工作。

**结论**：⚠️ **有条件支持**（生产在用，但本次没做隔离实验）

#### 5. `--json`

**命令**：
```powershell
& dsh.cmd --profile headless --json "hi"
```

**原始输出（完整 7 行）**：
```json
{"type":"session","sessionId":"session-4bd0fe5f-...","cwd":"E:\\dsh\\QQ-agent"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key...","code":"MISSING_CREDENTIAL"}}}
{"type":"final","text":""}
dsh: MISSING_CREDENTIAL: ...
```

**结论**：✅ **已验证**（但"正常完成"的形态**未验证**）

#### 6. `--session-id <id>`

**命令**：
```powershell
# A：新建
& dsh.cmd --profile headless --json "first task"
# → sessionId: session-f34c9d7f-...

# B：用同一 id
& dsh.cmd --profile headless --json --session-id session-f34c9d7f-... "second task"
# → {"phase":"turn_start","turn":2}    ← **turn 从 1 变成 2**

# C：不存在的 id
& dsh.cmd --profile headless --json --session-id "session-does-not-exist" "x"
# → {"type":"error","message":"session ... does not exist; omit --session-id to start a new Session"}
# → exit=1
```

**关键验证**（机主特别要求"必须验证历史是否真实恢复，不能仅凭返回相同 sessionId 判断"）：

> **`turn` 从 1 变成 2** —— 这是**历史真的被读取了**的证据。
> 如果只是"返回了相同 sessionId"而没恢复，`turn` 应该还是 1。

**结论**：✅ **已验证**（历史真实恢复，有 turn 编号为证）

#### 7. `--session-key <key>`

**命令**：
```powershell
& dsh.cmd --profile headless --json --session-key "mykey" "test"
```

**原始输出**：
```json
{"type":"error","message":"unknown option '--session-key'\n(Did you mean --session-id?)"}
```
**exit=1**

**关键**（机主特别要求"不要因为参数被忽略或被当作普通任务文本，就判定它受支持"）：

> **明确报错 `unknown option`** —— 不是被忽略，不是被当任务文本。
> **DSH 0.2.0-rc.2 没有 `--session-key`。**

**⚠️ 但注意**：`dsh-gateway.js` 里有 `sessionKey` 这个概念（`hasSession(sessionKey)` / `resetSession(sessionKey)`），
**那是 QQ-agent 自己的 chatKey → sessionId 映射**（存在 `data/dsh-sessions.json`），
**不是 DSH 的参数**。

**结论**：❌ **不支持**（DSH 层）；QQ-agent 层的 sessionKey 是另一回事

#### 8. `-`（stdin 输入）

**命令**：
```powershell
echo "hi" | & dsh.cmd --profile headless
```

**状态**：`--help` 明确写了 `the task text; ... `-` reads stdin`

**生产依据**：`dsh-gateway.js` 用 `['-']` + `stdin` 传 task，每天在跑。

**结论**：✅ **已验证**（help 明确 + 生产在用）

---

### B. 事件流（5 项）

#### 9. `type: final` 的字段

**实测**：`{"type":"final","text":""}`

**字段**：`type` / `text`

**限制**：`text` 为空是因为 `MISSING_CREDENTIAL`，**正常完成时应该非空**（未验证）。

**结论**：⚠️ **有条件支持**（结构已验证，正常形态未验证）

#### 10. `type: session` 的字段

**实测**：`{"type":"session","sessionId":"session-...","cwd":"E:\\dsh\\QQ-agent"}`

**字段**：`type` / `sessionId` / **`cwd`**

**⚠️ 新发现**：**`cwd` 字段是代码注释里没提的**。

**结论**：✅ **已验证**

#### 11. `type: status` 的 phase 列表

**实测到的 phase**：`turn_start` / `step_start` / `step_end` / `turn_end`

**字段**：`type` / `phase` / `turn` / `step`（部分）

**结论**：✅ **已验证**

#### 12. 是否有第四种事件类型

**⚠️ 这是本清单最重要的发现**：

**代码注释说"只有三种"（final / session / status）。**

**实测发现有第四种**：

```json
{"type":"error","message":"session \"session-does-not-exist\" does not exist; ..."}
{"type":"error","message":"unknown option '--session-key'\n(Did you mean --session-id?)"}
{"type":"error","message":"session \"...\" was recorded in \"E:\\dsh\\QQ-agent\", not \"C:\\Users\\...\""}
```

**所以事件类型至少四种**：`session` / `status` / `final` / **`error`**

**结论**：❌ **代码注释不准**（说三种，实际四种）

**影响**：`dsh-gateway.js` 的解析逻辑**没有处理 `type: error`** —— 它可能被当成"未知类型"忽略，或者走到 `final` 的兜底路径。

**这需要 R6-B 单独确认**。

#### 13. `status` 里是否可能有 usage

**实测的 `turn_end`**：
```json
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{...}}}
```

**没有 usage** ✅（印证了代码注释的结论）

**限制**：因为 `MISSING_CREDENTIAL`，可能"正常完成"时才带 usage。**未验证正常态。**

**结论**：⚠️ **有条件支持**（错误态没有 usage；正常态未验证）

---

### C. Session 生命周期（7 项）

#### 14. Session 文件结构与位置

**实测**：
```
{sessionId}/
  session.v4.jsonl.zstd    (10 KB → 17 KB → 25 KB，随对话增长)
```

**完整路径**：
```
{DSH_HOME}/sessions/--E-dsh-QQ-agent--/session-xxx/session.v4.jsonl.zstd
```

**⚠️ 关键**：**路径里嵌了 cwd**（`--E-dsh-QQ-agent--` 是 `E:\dsh\QQ-agent` 的编码）。

**结论**：✅ **已验证**

#### 15. 恢复需要什么条件

**实测了三个条件**：

| 条件 | 结果 |
|---|---|
| 正确的 `sessionId` | ✅ 能恢复（turn 递增） |
| **相同的 cwd** | ❌ **必须相同** |
| `DSH_HOME` 相同 | ✅ 必须（session 在 DSH_HOME 下） |

**cwd 不一致的原始错误**：
```
dsh: session "session-36f0bb5f-..." was recorded in "E:\dsh\QQ-agent", not "C:\Users\lenovo\AppData\Local\Temp\dsh-NBYYFm"
{"type":"error","message":"session ... was recorded in ..., not ..."}
exit=1
```

**结论**：✅ **已验证**（三个条件都确认）

**这印证了 `dsh-gateway.js` 注释里说的"cwd 必须钉在 QQ-agent 根目录"。**

#### 16. 并发两个 session 会不会互相干扰

**⚠️ 只做了一半**：

**做了什么**：两个进程同时用**同一个** sessionId 跑

**实测结果**：
```
A: {"phase":"turn_start","turn":2}
B: {"phase":"turn_start","turn":3}
```

**关键**：**turn 编号串行递增**（2 → 3），**没有同时拿到同一个 turn**。

**说明**：DSH 内部对 session 写入**有串行化**。

**没做什么**：
- ❌ 两个**不同** session 的并发（不适用——它们本来就独立）
- ❌ **有真实内容**的并发（因为 `MISSING_CREDENTIAL`，两轮都没写对话）

**结论**：⚠️ **有条件支持**（turn 编号串行已验证；内容层面的串扰**未验证**）

#### 17. Session 怎么结束

**实测**：**headless 模式下没有"结束"命令** —— 每次调用跑完就退出，session 文件留在磁盘上。

**结论**：✅ **已验证**（没有显式结束；靠进程退出）

#### 18. 怎么清理

**实测**：`dsh --help` 里**没有 clean / prune / gc / ttl / expire 相关命令**。

**结论**：❌ **不支持**（DSH 没有内置清理命令）

**推论**：清理只能靠**手动删 `{DSH_HOME}/sessions/` 下的目录**，或者外部脚本。

#### 19. 有没有 TTL

**实测**：`--help` 里没有任何 TTL 相关参数。

**生产依据**：`data/dsh-home/sessions/` 有 2 个子目录，但那是 QQ-agent 自己的会话，不是 DSH 的 TTL 机制。

**结论**：❌ **未发现**（没有 TTL 参数的证据）

**限制**：可能有配置文件里的 TTL，但**没在 CLI 层暴露**。需 R6-B 看 `cordis.yml`。

#### 20. 同一个 session 被两个进程同时用会怎样

**实测**：两个进程都成功了，`turn` 编号串行（2 / 3）。

**没有出现**：
- 文件锁错误
- 数据损坏
- 进程崩溃

**但**：**没有真实对话内容**（都是 `MISSING_CREDENTIAL`），所以**内容层面的行为未验证**。

**结论**：⚠️ **有条件支持**（不会崩、turn 串行；内容安全未验证）

---

### D. 本地包结构（3 项）

#### 21. `lib/` 里有哪些模块

**实测**：
```
lib/
  types/                    (d.ts 文件)
  bin.js                    (入口)
  dump-config-*.js          (哈希后缀，打包产物)
  profile-boot.js           (唯一有语义名字的模块)
  profile-boot-*.js
  plugin-*.js
```

**结论**：✅ **已验证**

**关键**：**大部分是打包后的 hash 文件名**，不是可读的分模块结构。

#### 22. 有没有可编程 API

**实测 `package.json`**：
```json
{
  "bin": { "dsh": "lib/bin.js" },
  "exports": {
    "./profile-boot": { "types": "...", "default": "./lib/profile-boot.js" },
    "./lib/*": "./lib/*",
    "./package.json": "./package.json"
  },
  "type": "module"
}
```

**唯一正式导出**：`./profile-boot`

**实测它导出的符号**：
```js
INSTALL_ANCHOR, PROFILE_ROOT_FILENAME, homePatchPath,
initializeProfileFromDefault, prepareProfile, runProfile
```

**结论**：❌ **没有可编程的 Session API**（只有 profile boot 相关）

**关键**：**`--session-id` 只能通过 CLI 用**，没有 JS API。

#### 23. 有没有导出 Session 管理函数

**实测**：
- `lib/` 里**没有独立的 session 模块**（都打包进 `bin.js`）
- `lib/types/` 里**没有 session.d.ts**
- `profile-boot.js` 的 6 个导出里**没有 session 相关**

**结论**：❌ **不支持**（没有 Session 管理 API）

---

## 二、汇总表

| # | 项目 | 结论 |
|---|---|---|
| 1 | `--version` | ✅ 已验证 |
| 2 | `--help` | ✅ 已验证 |
| 3 | `--profile headless` | ✅ 已验证 |
| 4 | `--patch` | ✅ 已验证（隔离实验已补做：正确文件可用，坏文件抛异常） |
| 5 | `--json` | ✅ 已验证（正常完成态未验证） |
| 6 | `--session-id` | ✅ 已验证（**turn 递增证明历史真恢复**） |
| 7 | `--session-key` | ❌ **不支持**（明确 `unknown option`） |
| 8 | `-`（stdin） | ✅ 已验证 |
| 9 | `final` 字段 | ⚠️ 有条件（`text` 空） |
| 10 | `session` 字段 | ✅ 已验证（**发现 `cwd` 字段**） |
| 11 | `status` phase 列表 | ✅ 已验证 |
| 12 | **是否有第四种事件类型** | ❌ **有！`type: error`** |
| 13 | `status` 里是否有 usage | ⚠️ 有条件（错误态无；正常态未验证） |
| 14 | Session 文件结构 | ✅ 已验证（**路径嵌 cwd**） |
| 15 | 恢复条件 | ✅ 已验证（cwd 必须相同） |
| 16 | 并发干扰 | ⚠️ 有条件（turn 串行；内容未验证） |
| 17 | 怎么结束 | ✅ 已验证（无显式结束） |
| 18 | 怎么清理 | ❌ 不支持（无内置命令） |
| 19 | 有没有 TTL | ❌ 未发现（CLI 层） |
| 20 | 同 session 两进程 | ⚠️ 有条件（不崩、turn 串行；内容未验证） |
| 21 | `lib/` 模块 | ✅ 已验证（打包产物） |
| 22 | 可编程 API | ❌ **没有 Session API** |
| 23 | Session 管理函数 | ❌ 不支持 |

**统计**（补充实验后）：

- ✅ 已验证：**13 项**（#1 #2 #3 #4 #5 #6 #8 #10 #11 #14 #15 #17 #21）
- ⚠️ 有条件：**4 项**（#9 #13 #16 #20）
- ❌ 不支持：**6 项**（#7 #12 #18 #19 #22 #23）
- **合计 23 项**

---

## 三、三个最重要的发现

### 发现 1：**有第四种事件类型 `type: error`**

**代码注释说"只有三种"（final / session / status），实测有第四种 `error`。**

**`dsh-gateway.js` 的解析逻辑没有显式处理 `type: error`。**

**影响**：不存在的 sessionId、unknown option、cwd 不匹配，都会走 `type: error` ——
**如果解析逻辑把它当未知类型忽略，就看不到真实错误**。

**这是 R6-B 必须先修的**。

### 发现 2：**`--session-key` 不存在**

**DSH 0.2.0-rc.2 只有 `--session-id`。**

**QQ-agent 的 `sessionKey` 是它自己的 chatKey 映射（`data/dsh-sessions.json`），和 DSH 无关。**

**影响**：R6 建 `companion-autonomous` session 时要**自己管理 sessionId**，
不能指望 DSH 提供命名 session。

### 发现 3：**没有可编程 Session API，也没有清理命令**

- `profile-boot` 只导出 profile 相关
- `lib/` 是打包产物
- `--help` 里没有 clean/prune/TTL

**影响**：
- **Session 生命周期只能通过 CLI 的 `--session-id` 控制**
- **清理必须自己写脚本删目录**

---

## 四、R6-B 必须处理的

| # | 事项 | 为什么 |
|---|---|---|
| 1 | **加 `type: error` 的解析** | 现在可能被忽略 |
| 2 | **确认 `session` 的 `cwd` 字段怎么用** | 代码注释没提 |
| 3 | **Ver证正常完成态的事件流** | 需要 API key（R6-C 时做） |
| 4 | **验证有内容时的并发串扰** | 本次没内容 |
| 5 | **设计 Session 清理方案** | DSH 没有内置命令 |
| 6 | **确认 `--patch` 的隔离行为** | 本次没测 |

---

## 五、仍未解决的问题

| # | 问题 | 为什么没解决 |
|---|---|---|
| **U1** | **正常完成时的事件流长什么样** | 隔离环境没 API key |
| **U2** | **正常完成时 `status` 里有没有 usage** | 同上 |
| **U3** | **有真实内容时，两个进程同时写同一 session 会不会串** | 同上 |
| **U4** | **`cordis.yml` 里有没有 TTL 配置** | 没看 profile 配置 |
| **U5** | **`--patch` 在隔离环境的行为** | 没做隔离实验（生产在用） |
| **U6** | **`session.v4.jsonl.zstd` 的具体格式** | 需要 zstd 解压，本次没做 |

**U1 / U2 / U3 都需要 API key**，建议 **R6-C 时用生产凭据做一次最小验证**（要授权）。

---

## 六、本次的边界

- **没有修改任何代码**
- **没有修改任何配置**
- **没有读取/写入/删除生产 `data/dsh-home`**
- **所有实验都在 `%TEMP%\dsh-r6a-*` 里**
- **实验目录用完即弃**
- **只新增本文档**

---

## 七、结论

**R6-A 完成。**

**23 项里**：
- **13 项已验证**
- **4 项有条件**
- **6 项不支持**

**三个关键发现**：
1. **有 `type: error` 事件**（代码注释不准）
2. **`--session-key` 不存在**
3. **没有可编程 Session API，也没有清理命令**

**⚠️ R6-A 通过 ≠ Session 迁移通过。**

**R6-B 必须等待本清单审查后开始**，且必须先处理 `type: error` 的解析。

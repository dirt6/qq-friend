# R6-A 补充：清单修正 + `type: error` 解析调查

> 时间：2026-11-03 00:00
> 状态：**只读调查 + 文档修正，未改代码**
> 前置：`DSH-RC2-API-INVENTORY.md`

---

## 一、清单完整性修正

### 1.1 之前的统计错误

**原文档写的**：

```
✅ 已验证：10 项
⚠️ 有条件：6 项
❌ 不支持：7 项
```

**逐项核对后的正确数字**：

| 分类 | 正确数量 | 编号 |
|---|---|---|
| ✅ 已验证 | **12 项** | #1 #2 #3 #5 #6 #8 #10 #11 #14 #15 #17 #21 |
| ⚠️ 有条件 | **5 项** | #4 #9 #13 #16 #20 |
| ❌ 不支持 | **6 项** | #7 #12 #18 #19 #22 #23 |
| **合计** | **23 项** | |

### 1.2 关于 #21 的说明

**机主指出"缺 #21（`lib/` 模块检查）"。**

**核对结果**：**#21 在表格里，没有被漏掉**。

```
| 21 | `lib/` 模块 | ✅ 已验证（打包产物） |
```

**原始实测**：
```
lib/
  types/                    (d.ts 文件)
  bin.js                    (入口)
  dump-config-*.js          (哈希后缀，打包产物)
  profile-boot.js           (唯一有语义名字的模块)
  profile-boot-*.js
  plugin-*.js
```

**问题不是"漏了 #21"，而是"统计数字算错了"** —— 总数 23 对，但分类错分。

**已修正 `DSH-RC2-API-INVENTORY.md` 的两处统计。**

---

## 二、`type: error` 解析调查（R6-B 的阻塞项）

### 2.1 现有解析代码（`src/dsh-gateway.js:662-671`）

```js
while ((idx = buf.indexOf('\n')) >= 0) {
  const line = buf.slice(0, idx).trim();
  buf = buf.slice(idx + 1);
  if (!line) continue;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === 'session' && ev.sessionId) sessionId = ev.sessionId;
  else if (ev.type === 'final' && typeof ev.text === 'string') finalText = ev.text;
  else if (ev.type === 'status' && ev.usage) usage = ev.usage;
}
```

**结论**：**`type: error` 落到没有匹配的分支 → 直接被忽略**。

### 2.2 失败判断逻辑（`src/dsh-gateway.js:684-688`）

```js
child.on('close', (code) => {
  if (code !== 0 && !finalText) {
    finish({ ok: false, error: `dsh 退出码 ${code}：${stderr.trim().slice(-400)}` });
    return;
  }
  ...
  finish({ ok: true, text: finalText, sessionId, usage, actions: drainOutbox(callId) });
});
```

**判定表**：

| `code` | `finalText` | 结果 | 是否安全 |
|---|---|---|---|
| 0 | 非空 | `ok: true` + 文本 | ✅ 正常 |
| 非 0 | 空 | `ok: false` | ✅ 正确失败 |
| 非 0 | 非空 | **`ok: true`** | ⚠️ 可能掩盖错误 |
| **0** | **空** | **`ok: true, text: ''`** | ❌ **危险：空回复被当成功** |

### 2.3 逐项回答机主的 5 个问题

#### Q1：`error` 事件是否被忽略？

**是，被忽略。** 代码里没有 `ev.type === 'error'` 的分支。

#### Q2：进程退出码是否仍能正确识别失败？

**在实测的所有场景里，是。**

实测 4 个错误场景：

| 场景 | 退出码 | 有 `type:error` | 有 `final` |
|---|---|---|---|
| 不存在的 sessionId | **1** | ✅ | ❌ |
| MISSING_CREDENTIAL | **1** | ❌（是 `turn_end`+`kind:error`） | ✅（`text:""`） |
| 空 task | **1** | ✅（`a task is required`） | ❌ |
| `--patch` 文件不存在 | **1** | ❌（抛异常到 stderr） | ❌ |

**所以**：**目前靠退出码兜住了**。

#### Q3：没有 `final` 但出现 `error` 时，`ask()` 返回什么？

**实测场景**（不存在的 sessionId / 空 task）：
- `code = 1`
- `finalText = ''`
- → 走 `code !== 0 && !finalText` → **`{ ok: false, error: 'dsh 退出码 1：...' }`** ✅

**返回的是失败，正确。**

**但注意**：`error` 事件里的**具体错误信息被丢了** —— 返回的 `error` 是 `stderr` 的尾巴，不是 `{"type":"error","message":"..."}` 的内容。

**实测证据**：`error` 事件的 message 在 stdout，`stderr` 里是 `dsh: <same message>`（dsh 会把错误也打到 stderr）。所以**实际没丢**，但**依赖 dsh 打 stderr 这个行为**。

#### Q4：多个事件中先 `error` 后其他，最终结果如何？

**没实测到这个场景**（需要构造"error 后还有 final"的输入，没找到自然触发方式）。

**从代码推断**：
- `error` 被忽略
- 后续 `final` 会覆盖 `finalText`
- 最终看 `code` 和 `finalText`

**结论**：**未验证**。

#### Q5：错误信息是否记录到日志，是否可能误判成功？

**日志**：`finish()` 里会 `logGateway(...)`，失败时带 `err=` 和 `stderr=`。

**所以错误信息**：**会进日志**（从 stderr 来）。

**误判成功的风险**：**只在 `code === 0 && finalText === ''` 时**。

**我实测了 4 个错误场景，全都是 exit=1，没有找到 `code=0 + 空 final` 的组合。**

### 2.4 结论

**当前不会把失败当成功 —— 因为退出码兜住了。**

**但有两个明确的脆弱点**：

| # | 脆弱点 | 影响 |
|---|---|---|
| **E1** | `type: error` 被忽略 | 如果将来出现 `code=0` + `error` 事件，会误判成功 |
| **E2** | 依赖 dsh 把错误打到 stderr | 如果错误只在 stdout 的 `error` 事件里，日志会缺信息 |

**R6-B 必须先修 `type: error` 的显式处理**，不能依赖"退出码刚好都是 1"。

### 2.5 R6-B 的错误返回契约（建议）

```js
// 新增：收集 error 事件
let errorEvent = null;
...
else if (ev.type === 'error' && ev.message) {
  errorEvent = { message: String(ev.message) };
}

// close 时：
child.on('close', (code) => {
  // ① 有 error 事件 → 无论如何都失败（即使 code=0）
  if (errorEvent) {
    finish({ ok: false, error: errorEvent.message, errorSource: 'event', code });
    return;
  }
  // ② 非零退出码 且 没有 final → 失败
  if (code !== 0 && !finalText) {
    finish({ ok: false, error: `dsh 退出码 ${code}：${...}`, errorSource: 'exit' });
    return;
  }
  // ③ code=0 但 final 为空 → 也要区分"真空回复"和"异常空"
  if (code === 0 && !finalText) {
    finish({ ok: false, error: '进正常退出但没有任何回复文本', errorSource: 'empty' });
    return;
  }
  finish({ ok: true, ... });
});
```

**三个变化**：
1. **`error` 事件 → 直接失败**（不再靠退出码）
2. **`code=0 + 空 final` → 明确失败**（不再返回 `ok: true, text: ''`）
3. **错误来源标记**（`event` / `exit` / `empty`），便于区分

---

## 三、`--patch` 的实测补充（修正一个我自己的测试错误）

**第一版清单里 #4 标的是"⚠️ 有条件（没做隔离实验）"。**

**这次补做了**：

| 场景 | 命令 | 结果 |
|---|---|---|
| 正确的 patch 文件 | `--profile headless --patch ok.yml --json "hi"` | exit=1（MISSING_CREDENTIAL），**事件流正常** ✅ |
| 不存在的 patch 文件 | `--profile headless --patch nope.yml --json "hi"` | exit=1，**抛异常** `failed to read overlay` ✅ |

**⚠️ 一个我自己的错误要说明**：

第一次测 `--patch` 时我用的是 `--json` **之后**加 `--patch`，得到 `unknown option '--patch'`。

**那不是 DSH 的限制** —— **`--json` 之后的所有参数都归 headless app**，`--patch` 是 launcher 的参数。

**生产代码的顺序是对的**（`--profile headless --patch xxx --json`）。

**所以 #4 应该从 ⚠️ 改成 ✅**（隔离实验已做）。

---

## 四、修正后的最终统计

| 分类 | 数量 | 编号 |
|---|---|---|
| ✅ 已验证 | **13 项** | #1 #2 #3 #4 #5 #6 #8 #10 #11 #14 #15 #17 #21 |
| ⚠️ 有条件 | **4 项** | #9 #13 #16 #20 |
| ❌ 不支持 | **6 项** | #7 #12 #18 #19 #22 #23 |
| **合计** | **23 项** | |

**变化**：#4（`--patch`）从 ⚠️ → ✅（补做了隔离实验）。

---

## 五、R6-C 不能省略的内容隔离测试

**机主的判断是对的**：

> `turn` 从 2 到 3，只能证明观察到的 turn 编号没有重复，不能证明：
> - 两个进程的输入没有交叉
> - A 进程不会读到 B 进程的上下文
> - 写入顺序与模型实际接收顺序一致
> - 两边的最终回复都归属于正确的调用者

**本次无凭据实验**：
- 两轮都是 `MISSING_CREDENTIAL`
- **没有写入任何对话内容**
- 只看到 `turn` 编号递增

**所以**：**这次实验不能计入"并发隔离通过"的样本**。

**R6-C 必须**：
- 用真实凭据
- 让两个进程发送**可区分的输入**
- 检查**各自的回复是否对应各自的输入**
- 检查**session 文件里的内容顺序**

---

## 六、本次的边界

- **只新增/修正文档**
- **没有修改代码**
- **没有修改配置**
- **没有碰生产 Session**
- **所有实验在临时 DSH_HOME 里，用完即删**

---

## 七、结论

| 项 | 结论 |
|---|---|
| **清单完整性** | ✅ 已修正（#21 在，统计算错了） |
| **`type: error` 解析** | ❌ **被忽略**；**靠退出码兜住**；**R6-B 必须先修** |
| **是否会把失败当成功** | **当前不会**（实测 4 个错误场景全是 exit=1）；**但脆弱** |
| **`--patch`** | ✅ 补做了隔离实验，可用 |
| **并发内容隔离** | ❌ **未验证**，R6-C 必做 |

**R6-A 调查主体通过，清单完整性已补齐。**

**⚠️ 仍然不能把"R6-A 通过"理解成"Session 迁移可行性确认"** ——
真正的 Go/No-Go 是 **R6-C 的五项硬门槛**。

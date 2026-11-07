# R7-B 运维页 + impeccable 面板审计

> 时间：2026-11-03
> 批次：**R7-B（B1 盘点 → B2 后端 → B3 界面）** + **impeccable 安装与首次审计**
> commits：`b285fe2`（R7-B）、`d589af3`（impeccable 修复）

---

## 一、R7-B B1：运维能力只读盘点

### 8899 面板的 17 个操作

| 分类 | 操作 | 处置 |
|---|---|---|
| **记忆管理** | `learned.status` / `archive` / `save` / `delete` | ✅ **R7-A 已搬到 3210** |
| **机器人** | `bot.start` / `bot.stop` / `bot.restart` | ✅ 搬到 3210 |
| **NapCat** | `napcat.start` / `napcat.status` | ✅ 搬到 3210（**不提 stop**） |
| **日志** | （新增）`ops.logs` | ✅ 新做 |
| **面板自己** | `panel.restart` / `panel.stop` / `panel.stopAll` | ❌ **不搬** |
| **内容管理** | `stickers.*`（4 个）/ `drawings.*`（2 个） | ⏸ 不属运维，不搬 |

### 为什么不搬 `panel.stopAll`（"一键全关"）

源码是：

```js
execFile('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', ...])   // 按进程名找
→ taskkill /F                                                // 按进程名杀
```

**这违反机主的约束②「禁止宽泛进程名杀进程」。**

那段代码在 8899 里是**有意为之**（面板是管理员，能杀掉提权的 QQ），
但**不搬到 3210** —— 3210 的运维接口只用明确的 PID 归属。

### 进程归属怎么保证

| 对象 | 归属来源 | 能不能安全停 |
|---|---|---|
| **机器人** | `data/qq-agent.lock` 里的 PID（与 8899 完全一致） | ✅ **只杀这个 PID** |
| **NapCat** | **没有 PID 文件** | ❌ **不提供 stop** |

**NapCat 是提权进程**：`Start-Process -Verb RunAs` 起的是 `cmd.exe`，
它的子进程链（NapCatWinBootMain → QQ）没有可靠的 PID 记录。
**按进程名猜** 就是宽泛杀进程。

---

## 二、R7-B B2/B3：实现

### 六个新路由（3210）

```
GET  /api/ops/bot/status    机器人状态（pidSource 明确标注为 lock 文件）
POST /api/ops/bot/start     explorer.exe 代启（降权标准做法）
POST /api/ops/bot/stop      只 kill lock 里那个 PID
POST /api/ops/bot/restart   停 → 等 3s → 起
GET  /api/ops/napcat/status 走 OneBot get_status（不返回 token）
POST /api/ops/napcat/start  Start-Process -Verb RunAs（原样）
GET  /api/ops/logs          只读两个固定文件 + 逐行脱敏
```

### 八条约束的落实

| # | 约束 | 落实方式 | 验证 |
|---|---|---|---|
| ① | **固定动作白名单** | ops 路由全是**字符串 pattern**，无 exec/run/shell/kill 入口 | 测试逐个断言"不存在" |
| ② | **明确进程归属** | PID 只从 lock 文件读；`process.kill(pid)`；**无 taskkill** | 源码断言 |
| ③ | **保留 NapCat 提权** | 仍是 `Start-Process -Verb RunAs` | 源码断言 |
| ④ | **日志不泄露** | 只读固定文件 + 逐行脱敏 + 整行凭据丢弃 | 测试断言无 token |
| ⑤ | **IPC 验证 sender** | **本次未涉及 IPC**（页面在 3210 web 里跑） | — |
| ⑥ | **3210 认证缺口** | 如实记录，不宣称已解决 | 页面里也写了这句话 |
| ⑦ | **不影响 8899** | 8899 的 bot/napcat/panel.stopAll 全保留 | 测试断言仍在 |
| ⑧ | **浏览器联调** | ⚠️ **INCONCLUSIVE**（沙箱起不了 3210） | 见下 |

### 日志脱敏的两个层次

1. **整行丢弃**：`token=xxx` / `Authorization: Bearer x` 这种整行就是凭据的 → 返回 `[已隐藏：疑似凭据行]`
2. **值替换**：行内命中 `token|apikey|secret|password|authorization|cookie` 的，把值换成 `***`

**只读尾部 256KB**（避免把 400KB+ 的日志整个读进内存）。

---

## 三、impeccable 安装与审计

### ⚠️ 三层状态必须分开看（不要合并成"装了 impeccable"）

| 层 | 状态 | 含义 |
|---|---|---|
| **skill 包** | ✅ **已安装**（58 文件，v4.8.0） | `skill` 工具能加载；`SKILL.md` + 41 个 reference 可读 |
| **engine 0.1.18** | ❌ **未安装** | 需要网络 + `C:\Users\lenovo\.impeccable` 写权限 |
| **`detect`（62 条规则自动检测）** | ❌ **未运行** | 引擎没装就跑不了 |

**这三件事不能混为一谈**：

- 说「impeccable 已安装」→ **只对 skill 包成立**
- 说「设计审查通过 impeccable 的规则检测」→ **不成立**，规则检测器没跑
- **本次实际做的是**：**人工**对照 `craft-floor.md` 的 Verify / Refuse 清单逐条检查

**人工能覆盖的**：对比度计算、token 统计、缺失规则的计数 —— 这些是"能算的"。
**人工覆盖不了的**：检测器擅长的模式识别（AI slop 的重复套路、结构与产品可互换性）。

### 安装结果

```
来源：D:\浏览器\impeccable-main.zip（29MB）
形态：**DSH skill 包**（.dsh/skills/impeccable/，v4.8.0，自带 .dsh 目录）
安装：C:\Users\lenovo\.dsh\skills\impeccable\（58 个文件）
状态：✅ skill catalog 已识别，skill 工具可加载
```

### ⚠️ 引擎没装

```
impeccable: engine 0.1.18 is not installed;
cannot create cache directory: "C:\Users\lenovo\.impeccable\bin\0.1.18"
```

**需要网络 + `C:\Users\lenovo\.impeccable` 写权限。**

**所以 `impeccable context` 没跑起来** —— 按 `SKILL.md` 的 **Launcher-unavailable** 分支处理：
直接读项目上下文 + reference 规则，**不编造缺失上下文**。

**后果**：那套 **62 条确定性规则的检测器（`detect`）没跑**。
本次只用了 `craft-floor.md` 的 Verify / Refuse 清单**人工逐条对**。

### 面板的 Mode

按 skill 的定义，这是 **Operate**（用户要完成：看状态、启停、管记忆、查记忆）。
> Operate: "Scanability, consistency, native expectations, and the real usage scene outrank expression."

**所以不追求表现力，追求精确和克制。**

### 实测数据（不是感觉）

| 维度 | 实测 |
|---|---|
| token 数量 | 12 个颜色 token（三层灰 + 描边 + 六色） |
| **硬编码 hex** | **26 种去重 / 40 次** |
| rgba | 45 次 |
| `width: Npx` | 54 次，其中 9 个 ≥ 300px |
| `@media` | **只有 3 个**（560px / 820px / reduced-motion） |
| `:focus-visible` | **只有 2 处** |
| `caret-color` | **0 处** ← craft-floor 点名的"最便宜信号" |
| `@keyframes` | 15 个，`prefers-reduced-motion` 只有 1 处 |

### 对比度全量实测

| fg \ bg | bg0 | bg1 | bg2 | bg3 |
|---|---|---|---|---|
| `tx` #e3e6ef | 15.38 ✓ | 14.51 ✓ | 13.38 ✓ | 11.99 ✓ |
| `tx2` #9aa3b8 | 7.59 ✓ | 7.16 ✓ | 6.60 ✓ | 5.91 ✓ |
| **`tx3` #646b7a** | 3.59 △ | 3.38 △ | 3.12 △ | **2.80 ✗** |

语义色在 bg1/bg2 上**全部合规**（ac 4.90/4.52、ok 6.63/6.11、warn 7.85/7.24、danger 5.99/5.53）。

**唯一不合格的就是 `tx3`**，而它正是 `.muted` 的颜色，**用量很大**。

### 三项修复（`d589af3`）

| # | 问题 | 修法 | 验证 |
|---|---|---|---|
| ① | `tx3` 对比度 2.80 ✗ | `#646b7a` → **`#8a92a4`** | bg3 **4.61 ✓**、bg1 **5.80 ✓** |
| ② | `caret-color` 0 处 | 补全 caret / selection / scrollbar / underline-offset，全部走调色板 | caret 1、scrollbar 11 |
| ③ | `:focus-visible` 只有 2 处 | 统一焦点环 `2px var(--ac)` + `:focus:not(:focus-visible) outline:none` | focus-visible 5 |
| ④ | `.tab` 34px 触摸目标偏小 | 34 → **40px** | — |

**为什么 `.tab` 没上 44px**：那会显著改变侧栏节奏，违反 skill 的「Refinement preserves」。
40px + 既有间距在 WCAG 2.5.8 的 spacing 例外下成立。

### 没做的事

- **没有重设计**（配色世界、布局结构、所有类名/token 名全部保留）
- **没有跑 `detect`**（引擎没装）
- **没有渲染验证**（沙箱起不了 3210，也没有 CDP 通道）

---

## 四、测试与回归

| 批次 | 测试 | 结果 |
|---|---|---|
| **R7-B** | `r7b-ops-test` | **49 项全过** |
| **R7-A** | `r7a-learned-write-test` | 48 项全过 |
| **全量** | 69 套 | 全绿（`state-store-test` 首轮 flaky，重跑 3/3 通过） |
| **impeccable 修复后** | 69 套 | 全绿（同上 flaky，重跑确认） |

**`state-store-test` 的 flaky 是已知的 Windows 并发问题**，不是本次引入（多轮验证过）。

---

## 五、未解决风险

### ⚠️ 风险 1：3210 无认证（既存）

```js
function authorize(req) {
  const token = String(getConfig().server?.token ?? '');
  if (!token) return true;   // ← 当前走这条
}
```

**`server.token` 未配置 → 所有本地程序可调全部 API。**

R7-A 和 R7-B 的写操作都加了「来源检查 + JSON 校验」，**但那不构成权限系统**。

**本次未改变，也不宣称解决。**

### ⚠️ 风险 2：端到端全部 INCONCLUSIVE

**沙箱 `spawn EPERM` → 起不了 3210 → 无法在浏览器里验证。**

所以以下**全部只做到静态验证 + handler 直接调用**：
- 左侧导航的真实渲染
- 扫码页能否显示图片
- 记忆管理的增删改
- 运维页的启停按钮
- 焦点环 / 滚动条 / 对比度的**实际观感**

### ⚠️ 风险 3：impeccable 引擎未装

**62 条规则检测器没跑**。人工对 `craft-floor.md` 只能覆盖"能算的"，覆盖不了检测器擅长的模式识别。

### ⚠️ 风险 4：两套审计日志并存

`data/logs/acl.jsonl`（8899）和 `data/logs/ops-audit.jsonl` + `memory-write-audit.jsonl`（3210）。
**格式相似但不共用**（按机主要求"不要为了复用而让两个服务共同写同一个文件"）。
**代价是排查时要看三个文件。**

---

## 六、下一批建议

| 优先级 | 工作包 | 说明 |
|---|---|---|
| **P0** | **端到端联调** | 需要一次真实重启（你会话里手动启 3210），把 R7-A/R7-B 的页面在浏览器里点一遍。**这是当前最大的验证缺口。** |
| **P1** | **S8-B** | `session/follow` + `tokenUsage` 投影能否实际订阅（rc.2 里已确认存在） |
| **P2** | **impeccable 引擎** | 如果你能在一个有网络+写权限的终端里跑一次 `impeccable.cmd engine-probe`，之后 `detect` 就能用 |
| **P2** | **响应式** | 只有 3 个媒体查询，左侧栏固定 168px，窄窗口会挤 |

**我的判断**：**现在最该做的不是继续加功能，是把已有的三个页面真跑一遍看。**

三个页面的 HTML / CSS / JS 都写完了，**但一次都没在真实浏览器里渲染过**。
静态检查全绿**不等于**页面对。

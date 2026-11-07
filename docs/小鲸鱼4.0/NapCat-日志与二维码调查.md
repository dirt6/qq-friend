# NapCat 日志与二维码落地调查

> 时间：2026-11-03
> 状态：**只读调查，未修改任何配置 / 未触发登录 / 未改变登录状态**
> 目的：确认能否把 NapCat 的日志与扫码能力搬进 Electron 运维页

---

## 一、结论速览

| 项 | 结论 | 证据等级 |
|---|---|---|
| **文件日志** | ❌ **当前配置不支持**（`fileLog = False`） | **已确认** |
| **控制台日志捕获** | ⚠️ **理论可行，但当前启动器没做重定向** | **已确认（看了启动脚本）** |
| **二维码图片落地** | ✅ **已确认**（`cache/qrcode.png`，147×147） | **已确认（读了 PNG 头）** |
| **二维码是否实时更新** | ⬜ **未验证**（只有一个样本） | **未验证** |
| **QRCode 接口** | ✅ **存在**（NapCat WebUI） | **已确认（端口通 + HTTP 200）** |
| **6099 TCP 可连** | ✅ | **已确认** |
| **6099 HTTP 层正常** | ✅ **`/webui/` 返回 200** | **已确认** |

---

## 二、运行环境

| 项 | 值 | 来源 |
|---|---|---|
| **NapCat 实际工作目录** | `napcat/shell/napcat/` | 启动脚本 `cd /d "%~dp0shell\napcat"` |
| **启动入口** | `napcat/启动NapCat-QQ.bat` | 文件存在 |
| **启动方式** | **自提权**（`Start-Process -Verb RunAs`） | 读脚本第 17 行 |
| **提权原因** | NapCat 要把 `NapCatWinBootHook.dll` 注入 QQ | 脚本注释原文 |
| **脚本编码** | **纯 ASCII**（注释明确写了 cmd 按 GBK 解析） | 脚本注释 |
| **`package.json` 版本** | `version = 0.0.1` | **⚠️ 这是占位值，不是真实版本号** |

**⚠️ 版本号说明**：`napcat/shell/napcat/package.json` 里写的是 `0.0.1`，**这明显是占位**。真实版本需要从别处确认（未查）。

---

## 三、文件日志：**当前不支持**

### 配置证据

**文件**：`napcat/shell/napcat/config/napcat_2029382488.json`

**字段（只列名，不输出值）**：

```
fileLog, consoleLog, fileLogLevel, consoleLogLevel,
packetBackend, packetServer, o3HookMode, bypass, autoTimeSync
```

**关键值**：

```
fileLog    = False     ← 文件日志关闭
consoleLog = True      ← 只输出到控制台
```

### 实际产物证据

**全目录 `*.log` 搜索结果**：

```
shell\napcat\static\robots.txt   25B   10-10 11:25
```

**——整个 NapCat 目录里唯一的 `.txt` 是 `robots.txt`，没有任何 `.log` 文件。**

### 判定

> **「配置项存在」≠「文件日志已写入」。**
> **现状是：`fileLog = False`，且没有任何日志文件产出。**

**要开文件日志，必须把 `fileLog` 改成 `true`** —— **这属于修改生产配置，本次未获授权，未做。**

---

## 四、控制台日志捕获可能性

### 启动脚本原文（关键片段）

```bat
@echo off
chcp 65001 >nul
rem NOTE: keep this file ASCII-only (cmd parses .bat as GBK).
cd /d "%~dp0shell\napcat"

net session >nul 2>&1
if not %ERRORLEVEL% == 0 (
  echo [NapCat] Requesting administrator rights...
  powershell -Command "Start-Process -FilePath '%~dp0' -Verb RunAs"
  exit /b
)

echo [NapCat] Admin mode OK. Looking up QQ install path...
```

**观察**：
- **没有 `> logfile` 或 `2>&1`** —— 所有 `echo` 只到控制台
- **提权是 `Start-Process -Verb RunAs`**，**没有 `-RedirectStandardOutput`**

### 判定

**技术上可行，但当前没做**：

| 方式 | 可行性 | 需要改什么 |
|---|---|---|
| 给 `Start-Process` 加 `-RedirectStandardOutput` / `-RedirectStandardError` | ✅ 可行 | 改启动脚本或改 `web-panel` 的 spawn 逻辑 |
| 给 bat 内部的 `echo` 加重定向 | ✅ 可行 | 改 bat |
| 用 `Start-Transcript` 包一层 | ⚠️ 可行但笨 | 改 bat |

**⚠️ 注意**：**NapCat 提权后**，父进程（普通权限）**能否控制它的 stdout** 是个问题。`Start-Process -Verb RunAs` 会**启动一个全新的提权进程**，**普通权限的父进程拿不到它的 stdout 句柄**。

**所以更现实的做法是**：**打开 NapCat 自己的 `fileLog`**（改配置），而不是去抓控制台。

---

## 五、二维码图片落地：**已确认**

### 实测证据

```
路径: napcat\shell\napcat\cache\qrcode.png
大小: 596B
修改: 2026-11-03 09:37:22
PNG 有效，尺寸: 147 x 147
```

**目录里只有这一个文件**：

```
cache\qrcode.png   596B   11-03 09:37
```

### 判定

> **二维码确实会写成固定路径的图片。**

**但有两个必须说清的疑点**：

1. **596B 的 147×147 PNG 偏小** —— 一张包含真实数据的二维码通常更大。**可能是空图/占位图**（未解码验证，按约束不输出二维码内容）。
2. **只有一个样本**（09:37 那次）—— **无法证明它会在每次扫码时更新**。

---

## 六、QRCode 接口：**已确认存在（WebUI）**

### 配置证据

**文件**：`napcat/shell/napcat/config/webui.json`

**字段（只列名）**：

```
host, port, token, loginRate, autoLoginAccount, theme,
disableWebUI, accessControlMode, ipWhitelist, ipBlacklist,
enableXForwardedFor, enable2FA, totpSecret
```

**关键值**：

```
host         = ::
port         = 6099
disableWebUI = False
token        = 已设置（不输出）
```

### 端口验证

**① TCP 层**：

```
Test-NetConnection -ComputerName 127.0.0.1 -Port 6099
  RemoteAddress    : 127.0.0.1
  RemotePort       : 6099
  TcpTestSucceeded : True
```

**② HTTP 层**（不带 Token）：

```
curl.exe -sS -D - -o NUL --max-time 5 http://127.0.0.1:6099/webui/

HTTP/1.1 200 OK
X-Powered-By: Express
Content-Type: text/html; charset=utf-8
Content-Length: 1365
Last-Modified: Sat, 10 Oct 2026 03:25:27 GMT
```

**③ 根路径**：

```
curl.exe -sS -D - -o NUL --max-time 5 http://127.0.0.1:6099/

HTTP/1.1 301 Moved Permanently
Location: /webui
```

### 判定

> **NapCat WebUI 在 6099 上运行，HTTP 层正常，`/` 会 301 到 `/webui`，`/webui/` 返回 200 的登录页 HTML（1365 字节）。**

**⚠️ 但这是「接口存在 + HTTP 可用」，不是「已经能在 Electron 里展示二维码」**：
- **登录页能拿到，不代表能拿到二维码数据**
- **后续 API 请求大概率要 Token**（`webui.json` 里有 token）
- **Token 在配置文件里，读取和使用它属于敏感操作**，本次未做

### 源码线索（未验证）

搜到这些文件包含 `qrcode` 相关字样：

```
napcat.mjs                      行 32219
static/assets/qq_login-*.js
static/assets/qq_manager-*.js
static/assets/index-*.js
```

**⚠️ 只是搜到了关键词，没有读实现，不能断言 `napcat.mjs:32219` 就是二维码生成逻辑。**

---

## 七、一条重要的边界说明

**6099 是 WebUI 端口，不是 OneBot HTTP API 端口。**

**OneBot 配置在** `onebot11_2029382488.json`（字段：`network, musicSignUrl, enableLocalFile2Url, parseMultMsg, imageDownloadProxy, timeout`）。

**两者不能混用**：
- **WebUI（6099）** → 管理界面，需要 token
- **OneBot HTTP** → 机器人通信协议，端口在 `onebot11_*.json` 的 `network` 里

---

## 八、下一步建议（按风险排序）

| # | 动作 | 风险 | 需要什么授权 |
|---|---|---|---|
| **1** | **等下次自然扫码时对比 `qrcode.png` 的大小/时间** | **无** | 不需要（只需观察） |
| **2** | **Electron 加"扫码"页，直接显示 `qrcode.png`** | **低** | 改 `ui/` + 3210 加一个读图片的路由 |
| **3** | 如果 #1 证明图片不更新 → 走 WebUI 路线 | **中** | 需要处理 token |
| **4** | 打开 `fileLog = true` | **中** | **改生产配置，需单独授权** |
| **5** | 改启动脚本重定向控制台 | **中** | 改 bat；且提权进程的 stdout 抓不到 |
| **6** | iframe NapCat WebUI 进 Electron | **中高** | token + 跨端口 + 同源策略 |

**我的建议**：

**先做 #1（等下次扫码观察），再决定 #2 还是 #3。**

**#2 是低风险且不需要改 NapCat 配置的路径** —— **只要证明 `qrcode.png` 会更新，就能立刻做**。

**#4 和 #5 不建议现在做**：
- **#4 改生产配置**
- **#5 技术上有硬伤**（提权进程 stdout 抓不到）

---

## 九、本次调查的边界

- **没有修改任何配置、启动脚本或代码**
- **没有重启/停止 NapCat**
- **没有触发扫码**
- **没有改变登录状态**
- **没有复制或输出 WebUI token、QQ 登录凭据、二维码内容或私人消息**
- **没有把生产日志复制到测试目录**
- **只读了路径、配置项字段名、接口返回的状态码与响应头**

---

## 十、证据文件清单

| 文件 | 用途 |
|---|---|
| `napcat/启动NapCat-QQ.bat` | 启动入口、提权方式、无日志重定向 |
| `napcat/shell/napcat/config/napcat_2029382488.json` | `fileLog = False` |
| `napcat/shell/napcat/config/webui.json` | `port = 6099`、`disableWebUI = False`、token 已设置 |
| `napcat/shell/napcat/config/onebot11_2029382488.json` | OneBot 配置（与 WebUI 区分） |
| `napcat/shell/napcat/cache/qrcode.png` | 二维码图片（147×147，596B，09:37） |
| `napcat/shell/napcat/package.json` | `version = 0.0.1`（占位值） |

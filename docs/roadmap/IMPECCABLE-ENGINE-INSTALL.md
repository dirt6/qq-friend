# Impeccable Engine 0.1.18 安装与验证

> 时间：2026-11-03
> 状态：**未安装成功** —— 被两个网络/沙箱限制挡住
> 结论：**Engine 未安装，`context` 和 `detect` 都没跑起来**

---

## 一、诊断结论（按你的 10 条要求逐条对）

### ① 用户目录与 `.impeccable` 的只读检查

| 检查项 | 结果 |
|---|---|
| `C:\Users\lenovo\.impeccable` 存在 | ❌ **不存在** |
| 能否**列**用户目录 | ✅ **能**（读到 `.anaconda`、`.android`、`.cache`、`.cc-switch`、`.claude` 等） |
| 能否**创建** `.impeccable` | ❌ `Access to the path 'C:\Users\lenovo\.impeccable' is denied` |
| 当前进程完整性级别 | **`Mandatory Label\Low Mandatory Level (S-1-16-4096)`** |

### ② ACL 问题 vs Low Integrity 限制：**是后者**

**判断依据**：

- **如果是 ACL 拒绝**：连 `Get-ChildItem` 都会失败
- **实际是**：**能读、不能写** —— 这是 **Windows 完整性机制**的典型表现
  （Low 完整性进程不能写 Medium 完整性的对象，除非那个对象显式给了 Low 写权限）

**所以：不是 ACL 损坏，不需要修 ACL。**

### ③ Launcher 预期的缓存目录结构（从报错里读出来的）

```
<IMPECCABLE_HOME>/bin/<engine-version>/impeccable-windows-x64.exe
默认 IMPECCABLE_HOME = C:\Users\lenovo\.impeccable
所以默认路径 =      C:\Users\lenovo\.impeccable\bin\0.1.18\impeccable-windows-x64.exe
```

### ④ 用普通 PowerShell 安装：**部分成功**

**我找到了 Launcher 自己提示的替代方案**：

```
Alternatively, set IMPECCABLE_HOME to a writable cache location,
or IMPECCABLE_BIN to a preinstalled engine binary.
```

**实测**：

```powershell
$env:IMPECCABLE_HOME = 'E:\dsh\impeccable-home'   # E:\dsh 下可写
impeccable.cmd context
```

**结果**：报错路径变成了 `E:\dsh\impeccable-home\bin\0.1.18` —— **说明环境变量生效了**，
**但下载失败**（见 ⑤）。

### ⑤ 从官方 Release 下载 + SHA256 校验：**下载失败**

**官方 checksum 找到了**（`engine-checksums.txt`）：

```
0.1.18 impeccable-windows-x64.exe 8f61e96b0c97001546a824d79b44f46b423b560f3eb1a0cc44a8695a1b395d9f
```

**下载 URL**（从 Launcher 报错里确认）：

```
https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.18/impeccable-windows-x64.exe
```

**三个下载尝试全部失败**：

| 尝试 | 结果 |
|---|---|
| `curl` 直连 github.com | `curl: (28) Failed to connect to github.com:443 after 21074 ms` |
| `curl --retry 3` 重试 | 4 次全部超时（每次约 21 秒） |
| 镜像 `ghfast.top` | `curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` |
| 镜像 `ghproxy.net` | 同上 |

**关键发现**：镜像的报错不是网络问题，是 **`SEC_E_NO_CREDENTIALS`** ——
**Low 完整性进程访问不了 Windows 证书存储**，所以连 TLS 握手都做不了。

**所以**：**这个问题不是"换个镜像就能解决"，是沙箱的证书访问限制。**

### ⑥ 按 Launcher 实际要求放置：**没到这一步**

**目标路径已确定**（`E:\dsh\impeccable-home\bin\0.1.18\`，已创建成功），
**但没有二进制可放**。

### ⑦⑧ `context` / `detect`：**都没跑起来**

```
impeccable: could not download engine 0.1.18 from <url>; check network access and the release URL.
Engine 0.1.18 setup needs network access and write permission to "E:\dsh\impeccable-home\bin\0.1.18".
```

### ⑨ 没做的事（按你的要求）

- ❌ 没装 npm 全局 CLI
- ❌ 没重装 Skill
- ❌ 没改 DSH 配置
- ❌ 没改项目代码
- ❌ **没有放宽沙箱权限绕过**

### ⑩ 沙箱阻止：**是的，保留了报告但没保留二进制**

`E:\dsh\impeccable-home\bin\0.1.18\` 目录**已创建**（空），
**没有可信二进制**（一个字节都没下到）。

---

## 二、版本与路径（已确认的部分）

| 项 | 值 |
|---|---|
| **Skill 版本** | v4.8.0（已安装，能加载） |
| **Engine 版本** | 0.1.18（目标） |
| **引擎文件名** | `impeccable-windows-x64.exe` |
| **官方 SHA256** | `8f61e96b0c97001546a824d79b44f46b423b560f3eb1a0cc44a8695a1b395d9f` |
| **默认安装路径** | `C:\Users\lenovo\.impeccable\bin\0.1.18\impeccable-windows-x64.exe` |
| **替代路径（已建目录）** | `E:\dsh\impeccable-home\bin\0.1.18\impeccable-windows-x64.exe` |
| **Skill 目录** | `C:\Users\lenovo\.dsh\skills\impeccable\` |

---

## 三、两个具体限制（分开说）

### 限制 A：`github.com:443` 连不上（网络层）

```
curl: (28) Failed to connect to github.com:443 after 21074 ms
```

**但 `api.github.com` 之前是能连的**（我用它拉过 SurfCore 的源码）。

**所以**可能是：`github.com` 和 `api.github.com` 走了不同的出口/DNS/防火墙规则。

### 限制 B：Low 完整性访问不了证书存储（沙箱层）

```
schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)
```

**这是镜像下载失败的原因** —— **不是镜像不通，是本地拿不到 TLS 凭据**。

**这个限制我绕不过去**，除非提权（你明确说不要）。

---

## 四、你可以怎么做（三个选项）

### 选项 A：你在普通 PowerShell 里下载 + 校验 + 放置

**这是最干净的**，普通 PowerShell 是 Medium 完整性，没这两个限制。

```powershell
# 1. 建目录
New-Item -ItemType Directory -Path "$env:USERPROFILE\.impeccable\bin\0.1.18" -Force

# 2. 下载
curl.exe -L -o "$env:USERPROFILE\.impeccable\bin\0.1.18\impeccable-windows-x64.exe" `
  "https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.18/impeccable-windows-x64.exe"

# 3. 校验（必须等于 8f61e96b0c97001546a824d79b44f46b423b560f3eb1a0cc44a8695a1b395d9f）
Get-FileHash "$env:USERPROFILE\.impeccable\bin\0.1.18\impeccable-windows-x64.exe" -Algorithm SHA256

# 4. 校验通过后，直接跑
& "$env:USERPROFILE\.dsh\skills\impeccable\scripts\impeccable.cmd" context
```

**⚠️ 如果 hash 不等于 `8f61e96b...`，立刻停下，不要运行那个文件。**

### 选项 B：下载到我建好的替代目录

如果你想用 `E:\dsh\impeccable-home`（那个目录我已经建好）：

```powershell
# 下载到
E:\dsh\impeccable-home\bin\0.1.18\impeccable-windows-x64.exe

# 然后每次用之前设这个环境变量
$env:IMPECCABLE_HOME = 'E:\dsh\impeccable-home'
```

**缺点**：每次新开 PowerShell 都要设一次（或者写进用户环境变量）。

### 选项 C：给我一次 `danger-full-access`

**你说过不要放宽沙箱，所以我没这么做。**

**如果你改主意**，我可以一次性完成下载 + 校验 + 放置。
**但那等于把整个沙箱放开**，风险比选项 A 高。

---

## 五、诚实的结论

| 项 | 结果 |
|---|---|
| **Engine 安装** | ❌ **未安装** |
| **SHA256 校验** | ⬜ **没到这一步**（没下载到文件） |
| **版本** | 0.1.18（目标） |
| **`context` 成功** | ❌ **否** |
| **`detect` 成功** | ❌ **否** |
| **检测结果数量** | **0**（没跑） |
| **权限风险** | **无** —— 我什么都没改，只建了一个空目录 |

**唯一的实际产出**：
1. **官方 SHA256 拿到了**（这是关键，以后你下载后可以自己校验）
2. **确切的目标路径和文件名确定了**
3. **两个限制的具体错误码和原因**

**没做的事**：没有放宽沙箱、没有改 ACL、没有装任何东西。

---

## 十一、补充：机主的普通 PowerShell 也连不上 github.com（2026-11-03 23:42）

机主在自己的 PowerShell（**Medium 完整性，不是 DSH 沙箱**）里跑：

```powershell
curl.exe -L -o "$env:USERPROFILE\.impeccable\bin\0.1.18\impeccable-windows-x64.exe" `
  "https://github.com/pbakaus/impeccable/releases/download/engine-v0.1.18/impeccable-windows-x64.exe"
```

结果：

```
curl: (28) Failed to connect to github.com:443 after 21079 ms: Could not connect to server
```

### 这个结果改变了判断

**原来我以为**是两层限制叠加：
· A. 网络层（github.com 连不上）
· B. 沙箱层（Low 完整性拿不到 TLS 凭据）

**现在确认**：**A 是主因，而且和沙箱无关** ——
**机主的普通 PowerShell 也超时**，说明 `github.com:443` 在**这台机器的网络环境里就被挡了**。

沙箱层的 `SEC_E_NO_CREDENTIALS` 是叠加在上面的**第二层障碍**（镜像也走 TLS，所以也失败）。

### 结论：Engine 0.1.18 在这台机器上装不上

**除非**：
· 换一个能连 `github.com` 的网络环境
· 或者手动把 exe 拷进来（从别的机器下载好，校验 SHA256 后放到位）

**这不是代码问题，是网络可达性问题。**

---

## 十二、这条待办的最终状态

| 项 | 状态 | 说明 |
|---|---|---|
| **Skill 包 v4.8.0** | ✅ **已安装可用** | 58 个文件，`skill` 工具能加载 |
| **Engine 0.1.18** | ❌ **网络受限，暂不可用** | github.com 不可达 |
| **`impeccable context`** | ❌ 未运行 | 依赖 engine |
| **62 条规则 detect** | ❌ 未运行 | 依赖 engine |

### 这不影响任何生产功能

Engine 只是一个**可选的开发工具**（设计规则自动检测器）。
缺失它不影响：
· QQ Agent 运行
· 面板任何功能
· 任何测试

### 已做的人工替代

`docs/roadmap/R7B-AND-IMPECCABLE.md` 里记录了**人工对照 `craft-floor.md` 检查**的结果：
· 对比度全量实测（12 个 token 互算）
· 发现 `tx3` 在 bg3 上只有 2.80（不合格）→ 改成 `#8a92a4`（4.61）
· 补齐 `caret-color` / `::selection` / 滚动条 / 焦点环
· 触摸目标 34→40px

**这些是引擎不在时能做的部分**；
**引擎擅长的是模式识别**（AI slop 的重复套路、结构与产品可互换性）—— 那部分确实缺。

### 三层状态永远分开写

以后任何报告里提到 impeccable，都必须写成：

    skill 包    ✅ 已安装
    engine      ❌ 未安装（网络受限）
    detect      ❌ 未运行

**不能笼统写"装了 impeccable"，那会让人以为规则检测跑过了。**

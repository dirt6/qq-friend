# NapCat 黑窗怎么处理 + 上传 GitHub 的完整命令

> 2026-11-03

---

## 一、NapCat 黑窗能关吗？

### 结论：**不能直接关，但可以最小化/隐藏**

**为什么不能关**：

```
启动NapCat-QQ.bat 行 16:
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
                          ↑ 提权启动自己 = 一个新 cmd 窗口
```

**NapCat 就跑在那个 cmd 窗口里**。关窗口 = 发 `CTRL_CLOSE_EVENT` = **NapCat 进程被终止**。

### 三个可选方案

| 方案 | 做法 | 效果 | 风险 |
|---|---|---|---|
| **A. 最小化** | `Start-Process -WindowStyle Minimized -Verb RunAs` | 窗口缩到任务栏，**进程还在** | 低 |
| **B. 隐藏** | `Start-Process -WindowStyle Hidden -Verb RunAs` | **完全不显示**，后台跑 | 中（出问题看不到任何输出） |
| **C. 保持不变** | 现在这样 | 窗口在桌面上 | 无 |

### ⚠️ 为什么我建议 **A 而不是 B**

因为 **`fileLog = false`** —— **NapCat 的日志只走控制台，不写文件**。

（这是之前调查确认的：`data/napcat_*.json` 里 `fileLog: False`，全目录零个 `.log`）

**方案 B 隐藏窗口之后**：
- NapCat 挂了你不知道
- 扫码登录的二维码**可能也看不到**（虽然会写到 `cache/qrcode.png`）
- 排查问题完全没有线索

**方案 A 最小化**：出问题时点一下任务栏就能看，**保留可观测性**。

### 如果一定要隐藏（方案 B）

**必须同时打开文件日志**：

```json
// napcat/shell/napcat/config/napcat_<QQ号>.json
{
  "fileLog": true,          // ← 从 false 改成 true
  "consoleLog": true,
  "fileLogLevel": "info"
}
```

**否则等于把唯一的问题线索也关掉了。**

---

## 二、上传 GitHub 的完整命令

### 情况诊断（你之前失败的原因）

```
remote: fatal: did not receive expected object 72f537f9...
error: remote unpack failed: index-pack failed
```

**远端收到的是不完整的包** —— 3.83MB 推一半断了。

**我已经做了**：`git gc --prune=now`，**.git 从 8.8MB 压到 4MB**。

### 完整命令（按顺序执行）

```powershell
# ── 0. 先确认在正确的目录 ──────────────────────────────
cd E:\dsh\QQ-agent
git status

# ── 1. 确认所有改动都已提交（不应该有未跟踪文件）──────
git status --short
# 如果还有输出，先提交：
#   git add -A
#   git commit -m "说明"

# ── 2. 指向新仓库 ────────────────────────────────────
git remote set-url origin https://github.com/dirt6/qq-friend.git
git remote -v

# ── 3. 再压缩一次（确保对象库干净）─────────────────────
git gc --prune=now --quiet
git fsck --full

# ── 4. 推送 ─────────────────────────────────────────
git push -u origin main --force
```

### 如果第 4 步还失败

**方案 A：分批推**（先推旧的一半，再推全部）

```powershell
# 取第 97 个 commit 的 hash（196 个的一半）
$mid = git rev-list --reverse HEAD | Select-Object -Skip 97 -First 1
Write-Output "中间点: $mid"

# 先推到那一半（建立基础）
git push origin "${mid}:refs/heads/main" --force

# 再推完整的
git push origin main --force
```

**方案 B：换 SSH**（HTTPS 大包容易断）

```powershell
# 先生成/确认 SSH key
ssh-keygen -t ed25519 -C "your@email.com"    # 已有就跳过
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
# 把输出的公钥加到 https://github.com/settings/keys

# 换 remote
git remote set-url origin git@github.com:dirt6/qq-friend.git
git push -u origin main --force
```

**方案 C：只推最新状态**（放弃历史，最省事）

```powershell
# 创建一个孤立分支，只含当前文件
git checkout --orphan clean-main
git add -A
git commit -m "初始提交（完整快照）"
git push origin clean-main:main --force

# 确认成功后再切回来
git checkout main
```

**⚠️ 方案 C 的代价**：**所有历史都没了**，`git log` 只剩一条。

### 推送前必须检查的（重要）

```powershell
# 确认 data/ 和敏感文件没被推上去
git ls-files | Select-String '^data/'
git ls-files | Select-String 'config.json$'
git ls-files | Select-String 'napcat/shell/'
```

**三个都应该没有输出**（`.gitignore` 已经排除）。

**如果有输出**，说明 `.gitignore` 没生效，**先修再推**：

```powershell
git rm -r --cached data/
git rm -r --cached napcat/shell/
git commit -m "chore: 移除误跟踪的敏感目录"
```

---

## 三、当前仓库状态（推之前确认）

```
分支: main
commit 数: 196
.git 大小: 4MB（gc 之后）
最近 5 个提交:
  040fdd1  feat(ui): 导航加「重启机器人」按钮
  5ead910  fix(分段): 列举不按逗号切
  7f1ba72  fix(分段): 密度规则 + 停顿改成 Math.max
  b5263ea  fix(表情包): 让她选图前先核对备注
  534fe1c  fix: 分段改为「按她自己的换行」
```

**远程**：`https://github.com/dirt6/qq-friend.git`

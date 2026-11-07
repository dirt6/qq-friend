# D1-6B：UNKNOWN 专项补验

> 时间：2026-11-04
> 原则：真实实机与注入严格区分；不能确认的保持 UNKNOWN/INCONCLUSIVE，不用模拟冒充
> 生产影响：无（全部隔离/临时目录；未改生产配置/数据/进程）

## 一、结果矩阵

| # | 项目 | 环境 | 测试方式 | 真实实机 | 注入条件 | 预期 | 实际 | 清理 | 影响生产 | 状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Windows symlink 权限 | `%TEMP%\symlink-probe` | `New-Item -ItemType SymbolicLink` | 是 | 无 | 可创建或不许 | **Administrator privilege required**；junction 可创建 | 删除临时目录 | 无 | **INCONCLUSIVE** |
| 2 | symlink 路径越界 | 隔离 fixture（D1-3d） | 现有 junction/symlink 备份/删除逻辑 | 是（junction） | symlink 未创建 | 不跟随目标 | junction 不跟随；symlink 无法创建 | 临时目录删除 | 无 | **INCONCLUSIVE**（symlink）/ PASS（junction） |
| 3 | 真实磁盘空间不足 | 本机 | 无法在不危及宿主的前提下安全制造满盘 | 否 | 未注入 | 写失败 fail-closed | 未执行 | — | 无 | **UNKNOWN** |
| 4 | 真实 ACL 拒绝 | `%TEMP%\acl-probe*` | `icacls /deny` 后写入 | 是（尝试） | 无 | 写入 EACCES/EPERM | `icacls` 被当前沙箱拒绝（Failed processing），文件仍可写 | 删除临时目录 | 无 | **UNKNOWN** |
| 5 | ACL 失败语义（注入） | 隔离 fixture | `hooks.failFileRel` | 否 | 模拟 I/O/权限失败 | 不删除、备份保留 | PASS（D1-3d/D1-5E） | 临时目录删除 | 无 | **PASS（注入）** |
| 6 | 文件句柄占用 | 隔离 `data/sessions` | 子进程 cwd 占用目录，reset | 是 | 无 | `needs_manual_recovery`，不删 | PASS（D1-3d/D1-5E 复测） | 子进程 kill、临时目录删除 | 无 | **PASS** |
| 7 | Electron shell 启动 | 仓库 `node_modules/electron` | 最小 `app.whenReady` 写文件 | 是 | 无 | 正常退出 | 写文件成功，但 `platform_channel.cc` 拒绝访问 FATAL | 临时文件删除 | 无（独立实例） | **INCONCLUSIVE** |
| 8 | Electron 窗口/截图 | 同上 | `BrowserWindow.loadURL + capturePage` | 是 | 无 | 截图 | 崩溃 `0xC0000005`，无截图 | 进程终止、临时 profile 删除 | 无 | **INCONCLUSIVE** |
| 9 | asar/打包布局 | 仓库 | 只读检查 | 是 | 无 | 可验证 asar | 当前为源码运行，无 packaged asar 可验 | — | 无 | **UNKNOWN** |
| 10 | 子进程退出/孤儿 | 代码审查 + 本机 | 检查 dsh-gateway 超时 kill；无持久注册表 | 部分 | 无 | 可判定归属 | 仅超时 `/T /F`；无持久子进程表；无法可靠判定孤儿 | — | 无 | **UNKNOWN** |
| 11 | 浏览器实际渲染 | Edge 156 | headless / 普通 CDP | 是 | 无 | 页面截图 | mojo/ACL 拒绝；普通模式静默退出；无 CDP | 进程/profile 清理 | 无 | **UNKNOWN** |

## 二、逐项说明

1. **symlink**：本会话非管理员，无法创建文件 symlink（`Administrator privilege required`）；junction 真实可用，已验证不跟随、只删链接。symlink 的删除路径未实机验证。
2. **磁盘满**：没有安全方式在不影响宿主磁盘的前提下制造满盘；之前 D1-3d/D1-5E 用注入验证 fail-closed，不能称为真实满盘。
3. **真实 ACL**：`icacls /deny` 在当前沙箱被拒绝（安全描述符修改不允许），文件写入仍成功；因此无法完成真实 ACL 拒绝测试。注入路径 PASS。
4. **文件句柄**：真实子进程 cwd 占用 → `needs_manual_recovery`，不删除；已复测。
5. **Electron shell/asar**：最小 Electron 可 `whenReady` 并写文件，但 `platform_channel` 拒绝访问；创建 BrowserWindow/capturePage 直接崩溃。仓库为源码运行，无 packaged asar。
6. **子进程孤儿**：DSH 子进程只在超时 `/T /F`；没有持久注册表，无法可靠判断“父进程退出后子进程归属”；任何终止必须 fail-closed（设计见 D1-5C）。
7. **浏览器**：见 D1-6A；Edge 156 无法在本会话渲染。

## 三、未关闭项与后续

| 项 | 建议环境 |
|---|---|
| symlink 真实删除/越界 | 管理员或开发者模式会话 |
| 真实 ACL | 允许修改 ACL 的隔离测试账户 |
| 磁盘满 | 独立小卷/可丢弃 VHD |
| Electron shell/asar | 打包产物 + 非受限桌面会话 |
| 子进程孤儿 | DSH 可控超时场景 + 进程启动时间/命令行采集 |
| 浏览器渲染 | 普通用户 Edge + Playwright/CDP |

**结论**：本批关闭了“文件句柄”真实项与 junction 真实项；symlink/ACL/磁盘满/Electron 窗口/asar/孤儿进程/浏览器渲染仍未关闭，保持 INCONCLUSIVE/UNKNOWN。

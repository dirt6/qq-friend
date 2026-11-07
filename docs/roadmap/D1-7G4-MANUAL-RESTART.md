# D1-7G4：人工重启流程

> 时间：2026-11-04
> 性质：流程；**未执行**；适用于身份不可自动验证的 Windows 现场
> 当前：Electron PID 25300（20:26 启动）、NapCat/QQ 33480（3001/6099）

## 一、前置

- 机主在场并明确授权维护窗口；
- 记录 F1/G5 hash（或 `d1-7f-restart.mjs --out`）；
- 确认 `/api/status` running/activeSessions 为空；
- 工作区干净（git status）；目标 HEAD 明确；
- 决定是否先关闭 hotReload（B 级，另授权；见 F5）。

## 二、步骤

1. **退出 QQ-agent**：机主通过托盘/窗口“退出”（`app.stop()`）。**不要**用 `taskkill /IM electron.exe`/`/IM node.exe` 批量。
2. **确认旧进程退出**：PID 25300 不存在；3210 无 LISTEN。
3. **确认 NapCat 未受影响**：PID 33480 仍存在，3001/6099 仍 LISTEN；若 NapCat 退出，按既有 launcher 单独启动（需授权）。
4. **开发端复核**：`git rev-parse HEAD`、`git status`、config hash、F1 数据 hash；确认目标 commit。
5. **启动**：桌面快捷方式 `electron.exe "E:\dsh\QQ-agent\." --no-sandbox`，cwd `E:\dsh\QQ-agent`；确认只启动一个实例。
6. **启动检查**：
   - boot-diag：app.js/核心启动；
   - 新 PID、3210 LISTEN、`/api/version`；
   - OneBot connected、`/api/status` running=[]；
   - `/api/chats` 200；`/api/reset-data/preflight` 只读 200；
   - 日志无 Core/context/autonomous 错误；autonomous 仅一份启动日志。
7. **运行态证据**：执行 `d1-7f-runtime-acceptance.mjs --baseline <F1 hash>`；Core/模块/loop 若无法观测，保持 UNKNOWN。
8. **自主活动**：优先观察自然 tick（F4）；无 tick 不得判 PASS；主动 tick 需另外授权。
9. **hash 复核**：重启前后对比；变化逐项归因。
10. **归档**：日志、PID、时间、hash、截图/输出。

## 三、异常停止条件

- 旧进程未退出/端口仍占用；
- 新进程不启动/端口不监听；
- Core/ChatStore 报错；
- autonomous 重复 loop；
- 数据 hash 非预期变化；
- NapCat 异常。

立即停止，保留现场；不回滚数据、不 reset；按 F2/E6 回滚代码版本并重启。

## 四、回滚

- 候选 `c9c06ac`（已预检存在/版本兼容；执行前重新核验）；
- 仅代码 checkout + 重启；禁止 reset/删 Session/清 Goal/Pending/日记。

## 五、边界

- 人工退出优先；脚本不自动停止（身份 UNKNOWN）；
- 不在维护窗口内编辑 `src/**`/`plugins/**`/`skills/**`；
- 不关闭/重启 NapCat（除非单独授权）。

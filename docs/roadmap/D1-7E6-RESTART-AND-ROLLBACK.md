# D1-7E6：受控重启与回滚方案（不执行）

> 时间：2026-11-04
> 性质：方案；**本批未重启、未改配置、未部署**
> 目标版本：`9688d0f`；当前进程：PID 25300（20:26 启动，混合热重载）

## 一、前置条件检查

| 条件 | 状态 |
|---|---|
| E4 只读预检完成 | 是 |
| 工作区干净 | 是（当前 HEAD `9688d0f` + 文档提交） |
| 目标 commit 明确 | `9688d0f`（如需含 E4/E5 文档则用最新 docs HEAD） |
| 生产数据基线 hash | 已记录（E4，22:36:56） |
| 生产进程归属明确 | Electron PID 25300；父进程/可执行路径 UNKNOWN（权限） |
| NapCat 生命周期边界 | NapCat/QQ PID 33480 独立；不随 Electron 退出 |
| 无未完成自主/模型请求 | 快照时 `/api/status running=[]`；autonomous 最后 21:23；但 nextWakeAt 未知 |
| 失败回滚版本 | `c9c06ac`（D1-7B 完成点，D1-7C 之前；或 `590370b`） |
| 启动健康检查 | 可定义（见 §三） |
| autonomous 受控测试 | 需授权（可能写生产数据） |

**结论：技术步骤可执行，但生产运行态一致性 UNKNOWN；必须机主授权后才能执行。**

## 二、执行步骤（不执行）

1. **记录**：`git rev-parse HEAD`、工作区；生产 12 类 hash（E4）；PID 25300、NapCat 33480；hotReload=true。
2. **确认无在跑**：`/api/status` running/activeSessions 为空；日志无进行中模型调用；`pending` 无未完成。
3. **停止编辑**：重启窗口内不修改 `src/**`、`plugins/**`、`skills/**`，避免 watcher 再次重载。
4. **停止 QQ-agent**：托盘/窗口“退出”，让 `app.stop()` 正常 flush；若必须命令，只针对 **PID 25300**，禁止 `taskkill /IM electron.exe`、`QQ.exe`、`node.exe` 批量。
5. **确认退出**：PID 25300 消失、3210 不再 LISTEN；NapCat PID 33480/端口 3001/6099 仍在。
6. **启动**：桌面快捷方式（管理员）`electron.exe "E:\dsh\QQ-agent\." --no-sandbox`；工作目录 `E:\dsh\QQ-agent`。
7. **启动检查**：
   - boot-diag：main.js/app.js/核心启动/托盘；
   - 新 PID、3210 LISTEN；
   - `/api/version`；
   - `/api/status`：OneBot connected、running=[]；
   - `/api/chats` 可读（ChatStore 注册）；
   - `/api/reset-data/preflight` 只读 200（不执行 reset）；
   - 日志：autonomous 只加载一次，无重复 “自主活动已启动”；
   - 无 `readPrivateHistory is not a function` / Core 相关错误。
8. **Core 一致性证据**：检查 `src/companion-core/context.js` 新代码已随进程启动；`autonomous` tick 前日志显示同一加载批次；不能仅用 `/api/version`。
9. **受控 autonomous tick**（需单独授权，可能写日记/聊天/Goal/Pending）：
   - 明确允许写入范围（建议只读/演练或允许当天日记）；
   - 记录 tick 前 hash；触发一次；记录日志/生成数据；tick 后 hash；逐项归因；
   - 若不允许写入，则不做 tick，只观察下一次自然 tick（可能等待较久）。
10. **重启后 hash**：重新计算 E4 12 类；与重启前比较；正常业务写入单独归因。
11. **记录**：日志、PID、时间、hash、检查结果、任何 UNKNOWN。

## 三、健康检查清单

| 检查 | 通过标准 |
|---|---|
| 进程 | 新 PID 存在，旧 PID 退出 |
| 端口 | 3210 LISTEN |
| OneBot | connected=true |
| 版本 | `/api/version` = package.json |
| ChatStore | `/api/chats` 200，返回现有私聊/群 |
| Core | 日志无 Core/context 错误；autonomous 一次 tick 不报 readPrivateHistory |
| autonomous | 仅一个 loop/一份启动日志 |
| NapCat | 3001/6099 仍 LISTEN，PID 33480 未变（除非另行操作） |
| 数据 | hash 与重启前一致，或变化可归因 |

## 四、失败回滚

| 失败 | 处理 |
|---|---|
| 主进程无法启动 | 保留日志；`git checkout c9c06ac`（或上一稳定版本）；用快捷方式重启；验证 3210/OneBot |
| 端口未监听 | 检查旧进程是否残留（PID）、端口占用；不杀无关进程 |
| Core API 缺失/`readPrivateHistory` 错误 | 立即回滚到 `c9c06ac`（D1-7C 前）并重启；记录日志 |
| ChatStore 未注册 | 回滚；检查 `setChatStore`/app 初始化 |
| autonomous 无法启动 | 回滚；检查插件依赖版本 |
| autonomous 重复启动 | 停止，回滚；检查 deactivate/activate |
| 数据 hash 非预期 | 停止写操作，保留现场，按 D1-3d/备份恢复流程处理；**不得 reset** |
| NapCat 退出 | 用既有 launcher 单独启动（需授权）；不要连带杀 QQ |
| 配置被误改 | 用重启前 config hash/备份恢复 |

- 回滚不删除生产数据、不清 Session、不 reset；
- 旧进程日志/新进程日志、hash、错误信息归档。

## 五、当前阻断

1. 生产运行态一致性 UNKNOWN（新插件/旧 Core）；
2. 无重启授权；
3. autonomous tick 可能写生产数据，需单独授权写入范围；
4. 进程可执行路径/父进程 UNKNOWN（不影响按 PID 停止，但停止前需再次确认 PID 与 lock/端口一致）。

**执行前需机主明确：重启授权 + tick 写入范围（或仅观察不 tick）。**

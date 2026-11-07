# D1-3c C1：部署只读预检（运行中实例 vs 仓库代码）

> 时间：2026-11-04 20:2x
> 性质：**只读预检**；未重启、未改配置、未执行 reset、未写生产数据
> 授权：D1-3c（部署准备），不含生产重启/重置

## 一、基线复核（不沿用历史报告）

| 项 | 实测值 |
|---|---|
| `git HEAD` | `792beedcd39bc1dfdf730245fb59c4a1f382e25e`（`792beed`） |
| 与任务书基线 `0156c98` 的差异 | 仅多一个 docs 提交：`792beed docs(R8-D1-3b): 两个 pending 幂等键只读调查`；运行时代码相同 |
| 工作区 | 干净（`git status` 无输出） |
| 生产关键文件 hash | memory `ee772eb3…`、日记树 `fb5cfac7…`、learned `af040667…`、pending `ca880159…`、idem `96d610c4…`、sessions `11f52253…` |
| 未完成 pending | 0 |
| 幂等表 pending | 0（55 个键） |
| reset preflight（当前代码只读调用） | `canReset=true`、`refusals=[]` |
| 生产 `data.reset-backups/` | 不存在 |
| 3210 / OneBot | 正常（`/api/status` `onebot.connected=true`） |

## 二、运行中实例

| 项 | 实测值 | 证据 |
|---|---|---|
| 监听 PID | `25300` | `netstat -ano` 3210 LISTENING；`data/qq-agent.lock` 内容 `25300` |
| 启动时刻 | 2026-11-04 **20:26:54**（main.js）→ 20:26:56 导入 `src/app.js` → 20:26:58 核心启动 | `data/boot-diag.log:689-697` |
| 端口 | 3210 | boot-diag / netstat |
| API 版本 | `0.4.0`，与 `package.json` 一致 | `GET /api/version` |
| 新路由 | `GET /api/reset-data/preflight` 返回 200（旧代码没有此路由） | 实测 |
| 进程镜像路径 | **UNKNOWN** | `Get-Process` / `tasklist` / CIM 均被权限拒绝（Access denied） |

## 三、代码差异结论

- 仓库内**最新运行时代码 mtime = 20:01:02**（`src/sessions.js`），最后一次运行时代码提交 `0156c98` 于 **20:03:34**；实例于 **20:26:54** 才导入 `src/app.js`；
- 工作区干净（无未提交运行时代码），`792beed` 仅新增 docs；
- 因此：**运行中实例加载的是当前 HEAD 的运行时代码**（可证明到文件系统层面：启动时间晚于所有运行时代码，且无未提交差异）。
- 不能证明的部分：
  - 进程镜像的实际路径（权限拒绝）—— 但 dataDir、锁 PID、端口、路由行为与应用布局一致；
  - B5/B6 专属行为未做**写探针**（例如 chat clear 的 403、`#pruneFiles` 状态保护），因为 C1 要求只读、且这些探针会触发生产写入/删除；标 **UNKNOWN**，留待 C3 隔离验收。

> 与上一轮交接描述的差异：历史基线写“Electron 仍运行旧代码”，实测**已在 20:26 由机主重启并加载新代码**（本会话未执行重启）。生产 reset 仍未执行。

## 四、部署差异清单（C2 输入）

- 需要部署的内容：`src/**`、`ui/**`、`electron/**`、`plugins/**`、`dsh-plugins/**`、`skills/**`、`scripts/**`、`package.json`（本阶段代码提交 `477d105..792beed`，运行时改动集中在 `src`/`ui`/`scripts`/`tests`，详见 C2 manifest）；
- 运行实例已与 HEAD 一致，**无需再次重启即可保持当前状态**；但生产 reset 仍未授权；
- 回退目标：上一个运行时代码提交 `0156c98` 之前的稳定点（C2 给出精确 ref 与步骤）。

## 五、风险

1. `canReset=true` 仅表示门禁满足；**不代表已获准执行生产 reset**；本阶段继续不执行；
2. 重启发生在 C1 之前（机主操作），本会话无法核对启动时使用的确切安装路径；如后续发现启动的是另一份副本，需要重新比对；
3. 运行实例已加载新代码，但 UI 缓存可能仍是旧前端（浏览器/Electron 窗口未重载）；C3 隔离验收覆盖前端静态资源与 API 一致性；
4. 生产数据 hash 在 C1 前后一致（只读）；后续批次结束时再次比对。

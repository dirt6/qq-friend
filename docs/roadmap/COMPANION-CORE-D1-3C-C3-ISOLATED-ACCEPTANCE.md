# D1-3c C3：隔离启动新版本验收

> 时间：2026-11-04
> 方式：**in-process 隔离启动**（`test/_harness.mjs`：随机端口 + 临时 `QQ_AGENT_DATA_DIR` + mock OneBot/LLM），不启动生产 Electron、不接触生产 data/
> 结果：**17/17 通过**；全量回归 68/73（5 项失败中 4 项既有、1 项环境偶发已复跑）

## 一、为什么用 in-process 隔离启动

- 生产 Electron 需要管理员令牌，且授权明确禁止重启/影响生产；
- 仓库已有成熟 harness（`bootApp`）：加载 `src/app.js` 全量服务、静态 UI、SSE、mock OneBot/LLM，使用临时数据目录；
- 因此 C3 验证的是**同一份运行时代码**的 HTTP/UI/门禁/屏障/备份行为；Electron 外壳（main.js/托盘/窗口）不在本批范围（标 UNKNOWN，见 §四）。

## 二、验收项（17/17）

| 组 | 检查 | 结果 |
|---|---|---|
| 版本/UI | `/api/version` = `package.json` 版本 | PASS |
| | `GET /` 返回 HTML、`GET /app.js` 可加载 | PASS |
| | 前端 `07-settings-events.js` 含 `/api/reset-data/preflight`（新 UI） | PASS |
| | `/api/status` 的 `dataDir` = 隔离目录 | PASS |
| preflight | 200、`canReset=true`、data/diary 路径正确、备份根在 data 外 | PASS |
| 门禁 | 写入未完成 pending → `canReset=false` 且列出原因 | PASS |
| | `POST /api/reset-data` → 409、未删除数据 | PASS |
| 写入屏障 | 屏障生效时 `store.appendIncoming` 抛 `ERESETBARRIER` | PASS |
| | 屏障解除后写入恢复、marker 清理 | PASS |
| 隔离 reset | 200、`status=completed`、`atomic=false`、返回 opId/backupDir/manifestPath | PASS |
| | 备份 manifest 自校验 + 逐文件 hash 核验通过 | PASS |
| | data 删除后仅剩 `qq-agent.lock` + 重置后重建的 `config.json` | PASS |
| | 日记正文未被删除/修改（隔离日记根 hash 前后一致） | PASS |
| | reset 后 `/api/status` 正常 | PASS |
| | reset 后屏障已释放、可再次写入 | PASS |
| 日志 | `GET /api/logs` 返回数组；主动写日志并 flush 后隔离 `logs/` 出现日志文件与内容 | PASS |

## 三、全量回归（C3 后）

- **73 项：68 PASS / 5 FAIL**；
- 既有基线失败：`selftest`、`tools-skill-audit`、`gallery-test`、`setup-qq-version`（偶发）；
- **首次新增**：`store-concurrent-test` 一次 EPERM（打开 `.lock` 失败）——保留首次结果；随后单独复跑 **4/4 通过**，判定为高负载下环境偶发，非本次代码改动导致（B5 仅改 `clearChat/removeByLocalIds` 备份路径，append 路径未改）；
- 新增 `deploy-manifest-test`（7/7）、`deploy-acceptance-test`（17/17）均通过。

## 四、已验证 / 未验证

**已验证**：运行时代码的 UI 静态资源、版本一致性、preflight 路径与门禁、写入屏障（生效/释放）、隔离 reset 的备份 manifest 与 hash、日记正文保留、恢复服务、日志落盘。

**未验证（UNKNOWN）**：
- Electron 外壳（`main.js` 窗口/托盘/权限/单实例/电源阻断）未在本批启动；
- packaged asar 布局未构建/验证（当前为源码运行模式）；
- 进程级崩溃/托盘交互/自动更新不在 C3；
- 生产环境的 reset 未执行（授权禁止）。

## 五、残留风险

1. harness 与生产 Electron 的差异主要在 shell 层；服务层代码相同，但 shell 生命周期（启动/退出/托盘）仍需部署时人工确认；
2. mock OneBot/LLM 不覆盖真实网络抖动；
3. 若后续改用打包部署，需另行验证 asar 内 `data-dir` 解析与静态资源路径。

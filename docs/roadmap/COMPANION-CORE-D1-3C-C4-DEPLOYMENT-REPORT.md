# D1-3c C4：生产部署报告（等待授权）

> 时间：2026-11-04
> 性质：部署状态报告；**本会话未重启 Electron、未执行生产 reset、未改配置/NapCat**
> 结论：运行实例已在 20:26 由机主重启并加载当前 HEAD 运行时代码；C2 清单与 C3 隔离验收完成；后续重启/重置仍需独立授权。

## 一、部署状态（实测，不沿用历史）

| 项 | 状态 | 证据 |
|---|---|---|
| 仓库 HEAD | `33b92a3`（C2 提交；C3 后本报告再提交） | `git rev-parse` |
| 工作区 | 干净 | `git status` |
| 运行实例 | PID `25300`，20:26:54 启动，20:26:58 监听 3210 | `data/qq-agent.lock`、`netstat`、`data/boot-diag.log:689-697` |
| 加载代码 | 当前 HEAD 运行时代码（最新 src mtime 20:01 < 启动 20:26；工作区无未提交运行时代码） | C1 |
| API 版本 | `0.4.0` = `package.json` | `GET /api/version` |
| reset preflight | 200，`canReset=true`、`refusals=[]` | 实测（只读） |
| 3210 / OneBot | 正常 | `/api/status` |
| 生产 reset | **未执行** | 本会话无 reset 调用 |
| 生产配置 / NapCat | 未修改 | 无写操作 |
| 生产关键 hash | memory `ee772eb3…`、日记 `fb5cfac7…`、learned `af040667…`、pending `ca880159…`、idem `96d610c4…`、sessions `11f52253…`；`data.reset-backups/` 不存在 | C3 后实测 |

## 二、部署物

- 清单工具：`scripts/deploy-manifest.mjs`（C2）
  - 运行时代码 254 文件 / 4.74MB 的 SHA256 清单；
  - `git.head/branch/dirty`、版本、生产关键文件 hash 与计数、回退 ref/步骤；
  - `--verify` 校验缺失/多余/hash 不符；
- 部署/回退步骤：`COMPANION-CORE-D1-3C-C2-DEPLOY-PACKAGE.md`；
- 运行时回退点：`0156c98`（D1-3b B6 完成点；与当前 HEAD 无运行时代码差异）。

## 三、验收结果

- C3 隔离验收 **17/17**：UI/API 一致性、preflight 路径与门禁、写入屏障、隔离 reset 的备份 manifest+逐文件 hash、日记保留、reset 后服务与屏障释放、日志落盘；
- 全量回归 **73 项：68 PASS / 5 FAIL**；
  - 4 项既有基线失败（selftest / tools-skill-audit / gallery-test / setup-qq-version 偶发）；
  - `store-concurrent-test` 首次 EPERM，单独复跑 **4/4 通过**（环境偶发，保留首次结果）；
- C1/C2/C3 全部只读或隔离，生产数据 hash 未变。

## 四、等待授权的事项

1. **生产 reset**：preflight 已通过，但本授权不包含执行；需要独立授权、独立窗口（建议先确认数据备份盘余量、日记正文备份、pending/幂等状态）；
2. **再次重启 Electron**：当前实例已是新代码，无需重启；如后续再部署，需机主管理员快捷方式执行并保留 `boot-diag`/端口/版本/清单校验记录；
3. 打包（asar）部署未构建，如改为打包发布需另立工作包。

## 五、残留风险

1. 运行实例的确切镜像路径无法读取（权限拒绝，UNKNOWN）；若实际启动自另一副本，需要在该副本目录重新 `--verify`；
2. Electron shell 层（托盘/窗口/权限/单实例）未在 C3 启动验证，仍依赖启动后人工确认；
3. `canReset=true` 只是门禁状态，不代表生产 reset 已被演练；真正 reset 前仍建议在隔离副本完成 D1-3d 全量演练（本阶段并行进行）；
4. 生产数据中 17 条 `meta_missing` 保持原样（本阶段不批量处理）。

## 六、结论

C4 完成：**新版本已运行，部署物与隔离验收就绪，生产数据未变**。等待机主对“生产 reset / 后续重启”的独立授权；本会话不执行。

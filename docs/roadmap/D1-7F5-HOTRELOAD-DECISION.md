# D1-7F5：hotReload 决策

> 时间：2026-11-04
> 性质：只读调查 + 方案；**未修改配置**
> 当前值：`data/config.json.extensions.hotReload = true`（config hash `fcab76c3…`）

## 一、配置事实

| 项 | 值 |
|---|---|
| 位置 | `data/config.json` → `extensions.hotReload` |
| 默认值 | `src/config.js` 默认 `true` |
| 生产覆盖 | `true` |
| 环境变量 | `QQ_AGENT_DEV=1` 会强制开启（当前未设置，User/Machine 均空） |
| 其他来源 | 未发现第二来源；UI 设置写同文件 |
| 生效方式 | 启动/`reloadSkills` 时读取；运行中改文件不会自动关闭现有 watcher，需重启或触发重扫 |
| 影响范围 | 仅插件/技能 watcher；不影响聊天、autonomous 调度、NapCat、Electron UI |
| 关闭后 | `plugins/`、`skills/` 改动不自动加载；需完整重启 |
| 恢复 | 改回 `true` 并重启；配置有 hash 备份 |

## 二、方案

### A. 重启前关闭 hotReload（推荐临时策略）

- 原值 `true` → 新值 `false`；
- 备份 `data/config.json`（hash/副本，需授权写入配置）；
- 重启后 watcher 不启动，代码更新边界 = 完整重启；
- 风险：插件更新需重启；开发调试不便；
- 不影响 autonomous loop 本身（仍按配置运行）、聊天、NapCat、UI。

### B. 保留 hotReload + 限制共享 Core 插件

- 需实现 `reloadPolicy`/依赖扫描/实例 ID 等（E5 候选）；
- 当前代码级防护未实现，不能假设安全；
- 在治理落地前，B 风险高于 A。

**推荐 A**；但修改 `hotReload` 属 B 级授权，且需要配置备份/回滚，本批**未修改**。

## 三、若获授权执行 A

1. 记录 config hash（当前 `fcab76c3…`）；
2. 备份到 `data/backups/config/d1-7f-<stamp>/config.json`（hash+manifest）；
3. 修改 `extensions.hotReload=false`（保持其他字段不变）；
4. 重启后日志应显示“热重载未启用”；
5. 回滚：恢复备份配置 → 重启；
6. 不在 watcher 关闭前编辑 `src/**`。

## 四、当前决定

- 保持 `true`，不在本批修改；
- 生产重启窗口内不编辑 `src/**`/`plugins/**`，避免再次混合加载；
- 待机主对 A 授权后再改配置。

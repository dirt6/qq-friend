# D1-6 最终报告：运行环境验收与统一伙伴核心集成预检

> 时间：2026-11-04
> 性质：只读/文档/隔离测试；未执行任何生产写入、删除、隔离、恢复、进程终止、重启或 reset
> 结论：A 的 HTTP/API PASS、真实浏览器渲染 UNKNOWN；B 部分 UNKNOWN 关闭；C 决策材料完成；D 集成审计/设计完成；全量 81 项 77 PASS/4 既有失败

## 一、提交

| 批次 | commit |
|---|---|
| D1-6A UI 浏览器验收 | `472bb22` |
| D1-6B UNKNOWN 补验 | `778f056` |
| D1-6C 生产遗留数据决策包 | `87e99ea` |
| D1-6D 集成审计/设计 | `086c682` |
| 本报告 | 见最终 commit |

## 二、D1-6A 结果

- **HTTP/API：PASS**（隔离实例：页面/JS/首页入口、5 个只读 API、无输入/危险按钮、无路径/PID 参数）；
- **真实浏览器渲染/截图：UNKNOWN**：
  - Edge 156.0.4314.58 安装；headless 被 `mojo platform_channel`/cache ACL 拒绝；
  - 普通 Edge + CDP（9223/9224）进程静默退出，无监听；
  - Electron 隔离窗口 `capturePage` 崩溃 `0xC0000005`；最小 Electron `whenReady` 可写文件但仍有 platform_channel 拒绝；
  - 无 Playwright/Puppeteer；**未使用模拟图**。
- 生产端口未重启/未部署；新 UI/API 仍未在生产生效。

## 三、D1-6B 结果

| 项目 | 状态 |
|---|---|
| 文件句柄占用 | **PASS（真实）** |
| junction 不跟随 | **PASS（真实）** |
| symlink 权限/越界 | **INCONCLUSIVE**（需管理员；junction 已覆盖） |
| 真实磁盘满 | **UNKNOWN**（未安全制造；注入 PASS） |
| 真实 ACL | **UNKNOWN**（icacls 被沙箱拒绝；注入 PASS） |
| Electron shell | **INCONCLUSIVE**（whenReady 可跑，窗口/截图崩溃） |
| asar/打包 | **UNKNOWN**（源码运行，无 packaged asar） |
| 子进程孤儿 | **UNKNOWN**（无持久注册表；fail-closed） |
| 浏览器渲染 | **UNKNOWN** |

## 四、D1-6C 决策材料

- 12 个 `verified_recoverable` + 1 个 `historical_unknown`：逐条备份/正文 hash、unique/lost、全量覆盖/行级追加效果、重复风险、回滚方案；
- 10 个本项目 Session 孤儿：归属/引用/进程/内容/备份/quarantine 条件逐条列出；**不能因超 7 天自动隔离**；外部 `--E-dsh--` 排除；
- `d9fb…` 保持 `historical_unverifiable`，不补写/不删除/不改状态；
- 仅材料，未执行任何生产操作。

## 五、D1-6D 集成审计/设计

审计发现：

- Companion Core 门面存在，但只有 autonomous 部分使用；
- 聊天路径直接 `companionPromptSection()`、直接 `diary/index.write`、直接 memory；
- autonomous 仍直接 import companionState/diary 写删改级；
- 无重复状态副本、无双写证据；主要风险是双入口漂移与未使用门面；
- 人格/状态不依赖 DSH Session，符合目标；
- 当前 Memory Hub 未被注入聊天 prompt，无重复注入/ prompt 变化。

设计：阶段 0 `readChatSnapshot` 只读 parity → 阶段 1 聊天读取经 Core（prompt 字节级 parity）→ 阶段 2 写入收口 → 阶段 3 活动检索统一 → 阶段 4 插件端口化；不改 prompt/调度/模型调用。

## 六、回归

**81 项：77 PASS / 4 FAIL**，4 项均为既有基线（`selftest`、`tools-skill-audit`、`gallery-test`、`setup-qq-version` 偶发）；新增专项无失败。

## 七、生产 hash（D1-6 期间发生变化）

D1-6 开始基线：

| 目标 | 开始 | 结束 | 说明 |
|---|---|---|---|
| memory | `ee772eb3…` | `ee772eb3…` | 未变 |
| 日记树 | `fb5cfac7…` | `1ec13e8a…` | **机器人 21:23:30 写入 2026-11-04 日记** |
| pending | `ca880159…` | `01c2a25d…` | 新增 2 条 completed（11-04） |
| idempotency | `96d610c4…` | `3f6f12eb…` | 57 done（新增 2 条） |
| learned | `f9f754a9…` | `b52bff89…` | 21:24:47 使用计数更新 |
| sessions | `ff13eb83…` | `f05b6509…` | 1527→1529（21:24 新增 2） |
| DSH 映射 | `42bb56e8…` | `e5c96962…` | lastUsedAt 13:24:25Z、turns 945 |
| dsh-home | `4147b1b0…` | `736f3d90…` | 新会话写入 |
| reset 备份 | 不存在 | 不存在 | 未 reset |

**调查结论**：变化均来自运行中的机器人正常活动（新日记条目、pending completed、幂等键、会话、DSH turns、learned 使用计数）；boot-diag 无新启动、PID 仍 25300、无 reset 备份；**不是本批工具写入**。按纪律发现后已停止核查，再继续文档工作。

## 八、剩余 UNKNOWN / 风险

1. 真实浏览器渲染/截图（宿主 ACL/mojo 限制）；
2. symlink 权限/越界、真实 ACL、真实磁盘满；
3. Electron shell/窗口、packaged asar；
4. 子进程孤儿与进程所有权（当前 fail-closed）；
5. 生产新 UI/API 未部署（需重启授权）；
6. 生产遗留数据（12 trash / 10 Session / d9fb）未决策；
7. 4 项既有回归失败与本批无关，未修。

## 九、生产授权清单（均未执行）

- 修改生产日记/记忆/pending/幂等；
- 删除/恢复 `.trash`；
- 隔离/删除 Session 或改映射；
- 终止 DSH/子进程；
- 重启 Electron / 部署新 UI；
- 执行 reset；
- 修改配置/NapCat/selfWake/调度/预算/模型策略。

## 十、下一阶段依赖

```
D1-6A 真实渲染 → 需可用 Chromium 环境
D1-6B symlink/ACL/满盘/Electron/asar/孤儿 → 需专门测试环境
D1-6C 生产遗留决策 → 用户逐项确认 + 独立授权
D1-6D 集成 → 先做只读 parity（阶段 0/1），不改 prompt
生产部署 → 重启授权；生产清理/隔离 → 单独授权
```

**本授权范围内未执行任何生产操作。**

# D1-3c C2：可复现部署包、版本/hash 清单与回退方案

> 时间：2026-11-04
> 性质：工具 + 文档；默认**只读**（只计算 hash），不重启、不改生产配置
> 关联：C1 预检（运行实例已于 20:26 重启并加载当前 HEAD 代码）、C3 隔离验收

## 一、清单工具

`scripts/deploy-manifest.mjs`（新增）：

```bash
# 生成（stdout）
node scripts/deploy-manifest.mjs

# 生成到文件（原子替换）
node scripts/deploy-manifest.mjs --out docs/roadmap/D1-3C-DEPLOY-MANIFEST.json

# 校验当前仓库/运行时代码与清单一致（缺失/多余/hash 不符都会报）
node scripts/deploy-manifest.mjs --verify docs/roadmap/D1-3C-DEPLOY-MANIFEST.json

# 不读取生产数据元信息（只做代码清单）
node scripts/deploy-manifest.mjs --no-production
```

清单内容（schema 1）：

| 字段 | 说明 |
|---|---|
| `git.head/branch/dirty/dirtyFiles` | 提交、分支、是否有未提交改动 |
| `versions.node/app` | Node 与 `package.json` 版本 |
| `code.dirs/roots/files[{path,size,sha256}]/totals` | 运行时代码清单（`src`、`ui`、`electron`、`plugins`、`dsh-plugins`、`skills`、`scripts` + `package.json`/`package-lock.json`），**不含 data/** |
| `rollback.previous/steps` | 自动化回退目标（`HEAD~1`）与步骤；若 HEAD 含 docs 提交，运行时回退点以本报告 §三 的显式 ref 为准 |
| `production.keyFiles{sha256,size}` | 仅生产关键文件 hash（config/learned/companion-state/autonomous/reminders/idem/pending/dsh-sessions），不含内容 |
| `production.counts` | memory / sessions / diary / reset-backups 的文件数与字节数 |

校验逻辑：清单内每个文件大小+SHA256 一致；运行时代码目录**不得出现清单外文件**（防止“漏打包/多带文件”）。不读取、不比较 `data/` 内容。

专项测试：`test/deploy-manifest-test.mjs`（7 项：HEAD/版本/hash 格式、自校验、篡改定位、缺失、多余、不含 data/、不含明文配置）。

## 二、当前清单基线（C2 生成时）

- 代码：254 个文件 / 4,739,457 字节；HEAD 以生成时为准（C2 提交后需重新生成）；
- 生产计数（只读）：memory 1 文件/300B；sessions 1526 文件/101,643,826B；日记 31 文件/39,950B；reset 备份 0；
- 生产关键 hash：pending `ca880159…`、idem `96d610c4…`、learned `af040667…`（完整值见生成的 json）。

## 三、部署 / 回退方案

### 运行时回退点

- 本阶段运行时代码提交：`c285687`…`0156c98`（D1-3b B4–B6）；`792beed` 及之后为 docs/工具提交；
- **运行时回退基线：`0156c98`**（与当前 HEAD 相比仅多 docs 调查与 C2/C3 工具，无运行时差异）；若回到 D1-3b 之前，用 `87f104a`（B3 完成点），并接受 B4/B5 安全修复缺失。

### 部署步骤（供机主/后续授权使用）

1. 生成清单并保存（`--out`），记录 `git.head` 与代码 hash；
2. 确认无未提交运行时代码（`dirty=false`，或 diff 已审查）；
3. 由机主使用**管理员快捷方式**重启 Electron（本阶段不执行）；
4. 启动后核对：`data/boot-diag.log` 出现 `main.js 已加载`/`核心已启动 port=3210`；`GET /api/version` = `package.json` 版本；`GET /api/reset-data/preflight` 可访问且拒绝条件正确；3210/OneBot 正常；
5. 用 `--verify` 校验清单与仓库一致；
6. 对生产数据做只读 hash 快照（与 C1/C2 基线比较），确认部署前后无数据变化；
7. **不执行生产 reset**（独立授权）。

### 回退步骤

1. 记录当前 `data/` 关键 hash；
2. `git checkout 0156c98`（或回退到目标发布 ref）；确认工作区干净；
3. 管理员快捷方式重启 Electron；
4. 按 §二 清单校验代码 hash（应匹配 `0156c98` 对应清单），确认 3210/OneBot、preflight 行为回到该版本；
5. 数据 hash 与回退前一致（代码回退不触碰 data）。

### 当前状态说明

- C1 已确认运行实例于 2026-11-04 20:26:54 重启并加载当前 HEAD 代码；**本阶段不再要求重启**；
- 若机主后续再次部署，仍按上述步骤执行；生产 reset 仍单独授权。

## 四、风险

1. 清单的 `production.keyFiles` 只覆盖关键小文件；sessions（1526 文件/101MB）与 memory 只做计数，未做全量 hash（避免部署预检长时间 IO）；需要全量数据快照时用 B4/C1 的聚合方法；
2. `HEAD~1` 在 docs 提交后可能不是运行时回退点，因此本报告显式指定 `0156c98`；
3. 清单不保证构建产物（packaged asar）一致；当前为源码运行模式，打包部署需另行生成 asar hash；
4. 进程镜像路径在 C1 中因权限无法读取（UNKNOWN）；若实际启动自其他副本，需用本清单在该副本目录重新 `--verify`。

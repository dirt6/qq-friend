# D1-5D：数据管理 UI（只读）验收

> 时间：2026-11-04
> 性质：只读页面 + 只读 API；**无生产删除/隔离/清理/执行按钮**
> 测试：`test/data-admin-ui-test.mjs` **5/5**

## 一、入口与页面

- 首页顶栏新增「数据管理」链接 → `/data-admin.html`（新窗口）；
- 页面：`ui/data-admin.html` + `ui/data-admin.js`；
- 五个区块：
  1. 幂等审计（counts + findings + verdict 徽章）；
  2. Diary Trash 清单（文件/日期/大小/分类/SHA 前缀）；
  3. Session 孤儿与归属（状态/年龄/大小/阻塞项/计划计数）；
  4. Reset 备份清单（类型/ID/状态/大小；含 restoreLock）；
  5. 数据生命周期审计（critical/warn/info + code 汇总）。
- 顶部模式图例：**只读查看（已启用）/ 生成计划（只读）/ 隔离演练（仅测试）/ 生产执行（未授权）**；
- `unknown`/`historical_unknown`/`process_unknown` 通过风险横幅与徽章提示；
- 无任何 `<input>`，无任意路径/PID/命令输入，无删除/隔离/清理按钮。

## 二、只读 API

| 路由 | 返回 |
|---|---|
| `GET /api/data-management/idempotency` | 审计 counts + 幂等 findings（含 verdict） |
| `GET /api/data-management/trash` | `inspectTrash` 清单 |
| `GET /api/data-management/sessions` | Session inventory + 只读 plan |
| `GET /api/data-management/reset-backups` | 备份 inspect（只读） |
| `GET /api/data-management/lifecycle` | 生命周期审计 counts + code 汇总 |

- 全部固定路由，不接受路径/PID/命令参数；
- 无写操作；不触发清理/隔离；
- 与本批工具使用同一只读实现，避免 UI/CLI 口径分叉。

## 三、测试结果（5/5）

| 检查 | 结果 |
|---|---|
| 页面/脚本可加载、首页有入口 | PASS |
| 页面无输入框、明确标注“生产执行未授权”、无危险按钮 id | PASS |
| 5 个 API 200 且结构化 | PASS |
| API 不接受路径/PID 参数 | PASS |
| 隔离数据下 Session/备份清单不泄露生产绝对路径 | PASS |

## 四、截图状态：UNKNOWN（未伪造）

尝试用本机 Edge 无头模式截取隔离实例页面：

- `msedge --headless=new --no-sandbox ... --screenshot=...` 失败：
  `mojo platform_channel.cc:187 Check failed: 拒绝访问 (0x5)` / `network_sandbox.cc` 无法授予 cache 目录访问；
- 环境无 Playwright/Puppeteer/Chrome/Firefox 可替代；
- **因此没有生成截图**；不使用模拟图冒充真实 UI。
- 页面 HTML/CSS/JS 已通过 HTTP 加载与内容断言；真实浏览器渲染留待有可用渲染环境时补。

## 五、边界与风险

1. 生产运行实例尚未重启，新增页面/API 在生产端口**尚不可用**；本批未重启（未授权）；
2. 页面只读；生产执行按钮/写入口未实现；
3. 审计 API 每次全量读取（sessions 1526 文件），未来可加缓存，但当前只读场景可接受；
4. 页面把 `process_unknown` 显示为风险，不提供 PID 输入或终止入口；
5. 真实浏览器截图 UNKNOWN，需后续在可用渲染环境补验收。

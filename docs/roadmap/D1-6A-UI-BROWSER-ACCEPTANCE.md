# D1-6A：数据管理 UI 真实验收

> 时间：2026-11-04
> 结论：**HTTP/API 验收 PASS；真实浏览器渲染/截图 UNKNOWN**（宿主 ACL/mojo 限制，未使用模拟图）
> 生产端口未重启、未部署；所有测试在隔离实例。

## 一、真实浏览器环境调查

| 项 | 结果 |
|---|---|
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，版本 **156.0.4314.58** |
| Chrome / Firefox | 未安装 |
| Playwright / Puppeteer | 未安装 |
| Edge headless | 失败：`mojo platform_channel.cc:187 Check failed: 拒绝访问 (0x5)`、cache 目录 ACL 拒绝 |
| Edge 普通模式 + CDP（9223/9224） | 进程静默退出，无 CDP 监听；无 stderr |
| Electron 隔离窗口 `capturePage` | 崩溃 `0xC0000005`；最小 Electron `app.whenReady` 可写文件但仍有 `platform_channel` 拒绝访问 |
| 结论 | 本会话宿主环境无法启动可控制的 Chromium 渲染进程；**不伪造截图** |

## 二、隔离实例与 HTTP/API 验收

- 隔离 `bootApp` 实例（临时 data/diary，合成 fixture：2 个 trash、1 个本项目 Session、1 个外部 Session、1 个映射、2 条幂等记录）；
- 页面/脚本：
  - `GET /data-admin.html` 200，含中文标题与五区块；
  - `GET /data-admin.js` 200；
  - 首页 `GET /` 含 `/data-admin.html` 入口。
- 五个只读 API：均 200、结构化、无写操作：
  | API | 结果 |
  |---|---|
  | `/api/data-management/idempotency` | findings/verdict |
  | `/api/data-management/trash` | 2 文件（recoverable + historical_unknown） |
  | `/api/data-management/sessions` | mapped_active + unmapped_project_owned + external |
  | `/api/data-management/reset-backups` | 空/结构正常 |
  | `/api/data-management/lifecycle` | counts/codes |
- 自动化：`test/data-admin-ui-test.mjs` **5/5**（页面/入口、无输入/危险按钮、5 API、无路径/PID、无生产路径泄露）。

## 三、内容/状态检查

| 检查 | 方式 | 结果 |
|---|---|---|
| 中文/特殊字符 | HTTP 文本 + HTML/JS 静态检查（`esc()` 转义） | PASS（文本层）；视觉渲染 UNKNOWN |
| 长列表 | 代码上限 100 条 + API 全量数组；未做真实浏览器滚动 | UNKNOWN（视觉） |
| 空状态 | 隔离 fixture 中 reset 备份为空，API 返回空数组/`无` 文案 | PASS（文本层） |
| 错误状态 | 页面 `load()` 捕获 fetch 错误并显示“读取失败”；未在浏览器触发 | PASS（代码）/UNKNOWN（视觉） |
| unknown/historical/process_unknown | 页面风险横幅 + 徽章；fixture 含 historical/process_unknown | PASS（文本层） |
| 只读/计划/隔离/生产区分 | 页面顶部四模式图例；生产执行标“未授权” | PASS |
| 无任意路径/PID 输入 | 页面无 `<input>`，API 固定路由 | PASS |

## 四、截图与浏览器版本

- **无截图**；原因见 §一；
- 浏览器版本：Edge 156.0.4314.58（仅能确认安装版本，无法完成渲染）；
- 未用模拟图、HTML 转图片或旧截图冒充。

## 五、边界与后续

1. 生产 3210 仍是 20:26 启动的旧前端，新增页面/API 未部署；未重启；
2. 真实视觉验收（字体/布局/滚动/空状态/错误态）需在可用 Chromium 环境补；
3. 建议：在非受限桌面会话用普通用户 Edge 打开 `/data-admin.html`，或用 Playwright 固化截图；
4. 本批未改任何生产数据/配置；隔离实例已停止并清理。

## 六、状态

- HTTP/API：**PASS**
- 真实浏览器渲染/截图：**UNKNOWN**
- 生产影响：无（未重启/未部署/未写）

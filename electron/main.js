// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, dialog, ipcMain, powerSaveBlocker, powerMonitor } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeInstance, profileSuffix } from '../src/profile.js';
import { resolveDataDir } from '../src/data-dir.js';


// Windows 上部分显卡驱动会导致渲染进程黑屏；禁用硬件加速是最稳妥的修复
app.disableHardwareAcceleration();

// 主进程兜底：未捕获异常不应静默吞掉。
// headless 入口（src/server.js）exit(1) 的理由在那里不成立 —— 那个有外层
// 守护重启。Electron 没有外层守护，进程挂掉后用户只能看到"托盘图标消失"。
// 折衷：拉起一个可见的错误对话框把异常亮给用户（至少知道为什么挂了），
// 确认后再退出 —— "半死不活地挂着"（定时器丢失/连接悬空但窗口还在）
// 是最难排查的状态，宁可死得明明白白。
process.on('unhandledRejection', (error) => {
  console.error('[未处理异常]', error);
});
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  try {
    // dialog 在 app ready 前也允许调用（Electron 文档保证）。
    dialog.showErrorBox(
      'QQ Agent 发生未捕获错误',
      '程序遇到无法恢复的错误，即将退出。\n\n' +
      String(error?.stack ?? error?.message ?? error) +
      '\n\n完整日志见 data/logs/ 下的当日日志文件。'
    );
  } catch { /* 弹窗失败不拦截退出 */ }
  app.exit(1);
});

// AppUserModelID：让 Windows 把窗口归到「QQ Agent」身份下（任务栏分组/图标/通知），
// 否则 dev 模式下会被当成裸 electron.exe，钉任务栏变成 electron 图标
app.setAppUserModelId('cn.kondius.qq-agent');

// ── 验证码网络诊断（2026-09-26）──
// 渲染层（Chromium 栈）访问 alicdn/aliyuncs 失败但 kondius.cn 通、系统 curl 直连却正常。
// 主进程 Node 层（undici，独立于 Chromium 网络服务）做同款探测：
//   Node 通 + Chromium 挂 → 问题锁定在 Chromium 网络栈（本机安全软件/WFP 过滤按进程压制），
//   两层都挂 → 机器出口对这些域有整体问题。
let captchaInterceptorActive = false;
ipcMain.handle('qqa-captcha-net-probe', async () => {
  const targets = [
    ['node:o.alicdn.com', 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'],
    ['node:aliyuncs验签', 'https://captcha.cn-shanghai.aliyuncs.com/'],
    ['node:aliyuncs-open', 'https://163stu.captcha-open.aliyuncs.com/'],
    ['node:kondius.cn', 'https://kondius.cn/api/community/health'],
  ];
  const out = [];
  for (const [name, url] of targets) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      out.push(`${name}:通(HTTP ${res.status},${Date.now() - t0}ms)`);
    } catch (e) {
      out.push(`${name}:失败(${String(e?.cause?.code || e?.message || e).slice(0, 60)},${Date.now() - t0}ms)`);
    }
  }
  return out.join(' ');
});
// 拦截器注册状态：渲染层报错时显示 —— 老进程（未重启）上它必然是"未注册"，
// 用来一眼区分"方案没生效"和"根本没跑到新代码"。
ipcMain.handle('qqa-captcha-interceptor-status', () =>
  captchaInterceptorActive ? '拦截器已注册' : '拦截器未注册（跑的是老进程，需托盘退出后重启）');

// ── 数据目录：由 src/data-dir.js 统一解析（R8-0-A1）──
// 开发模式：项目根/data；打包模式：安装目录/data（resources/app(.asar) 往上两级）。
// 不再自动迁移旧 data —— 按 R8-0-A1「禁止静默迁移/复制」，只读报告。
function resolveAppDataDir() {
  const appRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const dir = resolveDataDir({ appRoot, packaged: app.isPackaged, suffix: profileSuffix() });
  try {
    const legacy = path.join(app.getPath('userData'), 'data');
    if (!fs.existsSync(dir) && fs.existsSync(legacy) && fs.readdirSync(legacy).length > 0) {
      console.log('[data] 发现旧版数据目录，未自动迁移（R8-0-A1 禁止静默复制）：', legacy);
    }
  } catch { /* 只读检查失败不影响启动 */ }
  return dir;
}
process.env.QQ_AGENT_DATA_DIR = resolveAppDataDir();

// ── Chromium userData 落位（2026-09-23 修复"双击打不开"）──
// 原先 Electron 的 userData 用默认的 %APPDATA%\qq-agent。Chromium 的单实例
// 锁（lockfile）与网络服务缓存都写在那里；一旦该目录不可写（安全软件拦截 /
// ACL 损坏 / 低完整性上下文），启动链会两条腿同时断：
//   1. process_singleton_win.cc: "Lock file can not be created! Error code: 5"
//      → requestSingleInstanceLock() 返回 false → app.quit() → 窗口从未出现；
//   2. network_sandbox.cc: "Failed to grant sandbox access" → 一串 0x5 拒绝访问。
// 修复：userData 一律放应用自己的 data/ 下（与业务数据同源、同备份路径），
// 不再依赖 %APPDATA% 的可写性。app.setPath 必须在 app ready 之前调用。
app.setPath('userData', path.join(process.env.QQ_AGENT_DATA_DIR, 'electron-user-data'));

// ── 启动诊断（2026-09-23）：逐阶段写 data/boot-diag.log，排查"双击后毫无反应" ──
// appendFileSync 同步落盘：进程秒退/被强杀时日志也不会丢。问题解决后可整体删除。
const BOOT_DIAG_FILE = path.join(process.env.QQ_AGENT_DATA_DIR, 'boot-diag.log');
function bootDiag(msg) {
  try { fs.appendFileSync(BOOT_DIAG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}
bootDiag('main.js 已加载');

// 单实例锁：重复启动（双击 .bat）不产生第二个实例，而是唤出已有窗口。
// 没有锁的话第二个实例会双份连 SnowLuma，群消息会被双重回复。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 2026-09-23 修复：拿不到锁直接静默退出，用户看到的就是"双击没反应"。
  // 两种情况要区分：
  //   a) 真有主实例在跑 → 静默退出是正确行为（second-instance 已唤出主窗口）；
  //   b) 锁文件/锁管道创建失败（目录不可写、安全软件拦截）→ 之前同样静默退出，
  //      用户完全无从得知。现在把原因弹出来 + 写进 boot-diag.log。
  bootDiag('单实例锁获取失败，准备退出（可能已有实例，也可能锁创建失败）');
  app.quit();
} else {
  app.on('second-instance', () => { showWindow(); try { rebuildTray(); } catch { /* 重建失败不阻塞唤回 */ } });
}
bootDiag('单实例锁已检查 gotLock=' + gotLock);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.resolve(__dirname, '..', 'assets', 'icon.png');

let mainWindow = null;

// 焦点回收（2026-09-26）：原生 alert/confirm 关闭后窗口不认领回键盘焦点
// （electron/electron#41602 —— "弹过任意弹窗后所有输入框打不了字"）。
// 渲染层的 focus() 救不回来，可靠解是这里做 OS 级 BrowserWindow.focus()。
// 触发者：ui/app/00-core.js 的对话框包装层（经 preload 的 qqAgentShell.refocus）。
ipcMain.on('app-refocus', () => {
  try {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.focus();
  } catch { /* 焦点回收失败不致命 */ }
});
let core = null;
let tray = null;
let quitting = false;

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  app.setLoginItemSettings({ openAtLogin: !!cfg.server?.autoStart });
}

function showWindow() {
  if (mainWindow) {
    // 被最小化时先还原，否则 show() 不会把最小化窗口拉回前台
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow(core?.lastPort ?? 3210);
  }
}

/** 重建托盘图标：Windows 资源管理器重启后，旧的 Tray 对象可能还活着但图标没了。 */
function rebuildTray() {
  try {
    if (tray && !tray.isDestroyed()) tray.destroy();
  } catch { /* 旧对象异常不影响重建 */ }
  tray = null;
  createTray();
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(ICON_PATH);
    if (icon.isEmpty()) bootDiag('[tray] 图标文件为空或不可读：' + ICON_PATH);
    tray = new Tray(icon);
    tray.setToolTip(describeInstance());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主界面', click: () => showWindow() },
      { label: '暂停 / 恢复', click: () => core?.orchestrator.setPaused(!core.orchestrator.paused) },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: !!core.getConfig().server?.autoStart,
        click: (item) => {
          core.updateConfig({ server: { autoStart: item.checked } });
          applyAutoStart();
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => showWindow());
    tray.on('destroyed', () => { tray = null; bootDiag('[tray] 托盘对象已销毁'); });
    bootDiag('[tray] 托盘已创建');
  } catch (error) {
    bootDiag('[tray] 创建失败：' + String(error?.stack ?? error));
    console.error('[tray] 创建失败:', error);
  }
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: describeInstance(),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  Menu.setApplicationMenu(null);
  // F5 / Ctrl+R / Ctrl+Shift+R 刷新：应用菜单被移除后默认快捷键随之失效，
  // 用 before-input-event 手动接管（不恢复菜单条，外观不变）。
  // 开发改完 ui/ 下的前端文件后 F5 即可生效，不用重启整个程序。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const isF5 = key === 'f5';
    const isCtrlR = (input.control || input.metaKey) && key === 'r';
    if (isF5 || isCtrlR) {
      event.preventDefault();
      mainWindow?.webContents.reloadIgnoringCache();
    }
  });
  // 窗口打开先显示 loading 壳，等页面真正加载完成再亮相，避免白屏和用户反复双击
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[window] 页面加载失败:', code, desc, url);
    setTimeout(() => mainWindow?.loadURL(`http://127.0.0.1:${port}/`).catch(() => {}), 2000);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 渲染进程崩溃:', JSON.stringify(details));
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((error) => console.error('[window] loadURL 失败:', error));
  // 外部链接（金句墙/意见墙/上传成功提示里的网址等）一律交给系统默认浏览器，不在应用内弹新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 主窗口只应停留在本机控制台。没有这道拦截时，页面里一个普通 <a href> 或
  // location.href=... 就能把主窗口导航到外部站点（脱离 127.0.0.1 源、
  // 控制台也不再指向本机）。外链改走系统浏览器。
  const isLocalConsole = (u) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(String(u || ''));
  const guardNavigation = (event, url) => {
    if (isLocalConsole(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(String(url || ''))) shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  // 关窗默认缩到托盘（真正退出走托盘菜单），符合"常驻机器人"的使用习惯
  mainWindow.on('close', (event) => {
    if (!quitting && core?.getConfig().server?.closeToTray !== false) {
      event.preventDefault();
      mainWindow.hide();
      // 明确告诉用户"没退出，只是藏到托盘了"：否则看起来就是"关掉了"
      try {
        tray?.displayBalloon({
          title: 'QQ Agent 仍在运行',
          content: '窗口已最小化到托盘，双击托盘图标可恢复。退出请用托盘菜单的「退出」。',
          iconType: 'info',
          noSound: true
        });
      } catch { /* 气泡失败不影响隐藏 */ }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 阻止系统把应用挂起 ──────────────────────────────────────────────────
// 这台机器是 S0 低功耗待机（Modern Standby）。电源计划里「交流下睡眠/休眠」
// 确实都是 0，所以「从不休眠」看着没问题；但用电池时 standby 仍是 3 分钟，
// 合盖或手动关屏也可能进 S0 —— 一进 S0，定时器、网络、spawn 全被按住，
// 表现就是「黑屏之后她不回消息」（2026-10-26 按机主反馈排查）。
//
// 只阻止挂起、不阻止息屏：屏幕该黑还黑，省电不受影响。
let sleepBlockerId = null;
function keepAppAwake() {
  try {
    if (sleepBlockerId !== null && powerSaveBlocker.isStarted(sleepBlockerId)) return;
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    // 走 bootDiag 而不是 console.log：主进程 stdout 不进 data/logs，
    // 之前那行 console.log 等于没写，想验证"到底拦没拦住"时无从查起。
    bootDiag(`[power] 已阻止系统挂起 blocker=${sleepBlockerId}（isStarted=${powerSaveBlocker.isStarted(sleepBlockerId)}）`);
  } catch (error) {
    bootDiag(`[power] 阻止系统挂起失败：${error?.message ?? error}`);
  }
}

// 从待机回来时再确认一次：blocker 偶尔会随着系统挂起失效，而「恢复后还睡不睡」
// 直接决定她能不能继续回消息。
try {
  powerMonitor.on('resume', () => {
    keepAppAwake();
    bootDiag('[power] 系统已从待机恢复');
    try { rebuildTray(); } catch { /* 托盘重建失败不影响恢复流程 */ }
  });
} catch { /* 老版本 Electron 没有这个事件 */ }

app.whenReady().then(async () => {
  bootDiag('whenReady 已触发');
  keepAppAwake();
  try {
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    // ── 验证码域重定向（2026-09-26）──
    // 部分用户机器上 Chromium 网络栈访问 *.alicdn.com / *.aliyuncs.com 被本机
    // 安全软件按进程+域名压制（同机 Node 层与系统 curl 均正常），而 kondius.cn 可达。
    // 在 session 层把这两族域的请求重定向到 kondius.cn 的白名单反代：
    //   /qq-agent/captcha-sdk/...  （SDK 主脚本）
    //   /qq-agent/captcha-api/...  （SDK 接口，nginx 按域名后缀转发到真实域）
    // webRequest 覆盖主文档/iframe/worker/XHR 的所有请求形态，比 Service Worker 可靠。
    // 只匹配这两族域名后缀（正则收尾锚定），其余请求一律放行。
    captchaInterceptorActive = true;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const m = /^https:\/\/([a-zA-Z0-9.-]+\.(?:aliyuncs|alicdn)\.com)(\/.*)$/.exec(details.url);
        if (m) {
          return callback({
            redirectURL: `https://kondius.cn/qq-agent/captcha-api/${m[1]}${m[2]}`
          });
        }
      } catch { /* 解析异常按放行处理 */ }
      callback({});
    });
    bootDiag('setProxy 完成');
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { createApp } = await import('../src/app.js');
    bootDiag('src/app.js 已导入');
    core = createApp({ log: (...args) => console.log(...args) });
    // 先启动服务拿到真实端口，再开窗口。
    // 原先是 createWindow(core.lastPort ?? 3210) 在前、core.start() 在后 ——
    // 此时 lastPort 尚未赋值，窗口恒按 3210 加载；若端口被占用顺延到 3211+，
    // 首屏必然加载失败，只能靠 did-fail-load 2 秒重试兜底。
    const port = await core.start();
    core.lastPort = port;
    bootDiag('核心已启动 port=' + port);
    await createWindow(port);
    applyAutoStart();
    createTray();
    bootDiag('窗口与托盘就绪');
  } catch (error) {
    console.error('[electron] 启动失败:', error);
    bootDiag('启动失败: ' + String(error?.stack ?? error));
    // 2026-09-23：启动失败必须可见。之前只 quit，用户看到的是"双击没反应"。
    try {
      dialog.showErrorBox(
        'QQ Agent 启动失败',
        '核心服务启动失败，程序即将退出。\n\n' +
        String(error?.stack ?? error?.message ?? error) +
        '\n\n详细日志见 data/logs/ 下的当日日志与 data/boot-diag.log。'
      );
    } catch { /* 弹窗失败不拦截退出 */ }
    app.exit(1);
  }
});

// 退出清理：core.stop() 是 async（要 abortAll / 关 SSE / 关 server / 释放单实例锁），
// 而 before-quit 是同步事件 —— 直接调它会让进程在 await 让出后就被销毁，
// 清理链跑一半：锁文件可能残留、会话最后一次进度可能丢、SnowLuma 子进程可能变孤儿。
// 正确做法：拦下这次退出，等 stop() 真正跑完再 app.quit()。
let shuttingDown = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (shuttingDown || !core) return;      // 第二次进入（自己触发的 quit）直接放行
  event.preventDefault();
  shuttingDown = true;
  Promise.resolve()
    .then(() => core.stop())
    .catch((error) => console.error('[electron] 退出清理失败:', error?.message ?? error))
    .finally(() => app.quit());
});

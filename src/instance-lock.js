// 进程单实例锁：确保同一数据目录下只有一个 QQ Agent 核心在跑。
//
// 为什么需要（Electron 的 requestSingleInstanceLock 管不到的场景）：
//   - Electron 桌面端 + `npm run server` headless 同时启动 → 两份核心
//   - 双击 .bat 又手动 node src/server.js → 两份核心
//   两份核心会双份连 SnowLuma、双份处理群消息 → 群里看到重复回复。
//
// 原理：在数据目录放一个 qq-agent.lock 文件，内容 = PID。
//   启动时若锁文件存在且对应进程仍活着 → 判定已有实例，拒绝启动；
//   锁文件存在但进程已死（上次异常退出残留）→ 抢占锁，继续启动。
//   正常退出 / 被 kill 时删除锁文件。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const LOCK_FILE = path.join(DATA_DIR, 'qq-agent.lock');

/**
 * 查这个 PID 当前叫什么进程名（Windows 用 tasklist；其它平台返回 null 表示"查不了"）。
 *
 * 为什么需要：Windows 会复用 PID。残留锁里的旧 PID 被系统分配给某个
 * 我们无权访问的受保护进程时，process.kill(pid, 0) 会抛 EPERM，
 * 而 EPERM 的语义是"进程存在但无权发信号"——旧实现据此判定"实例还活着"，
 * 于是**拒绝启动**。用户看到的是双击没反应，且电脑上其实一个实例都没有。
 * 有了进程名就能区分：名字对不上 → 旧 PID 已被复用 → 按残留锁处理。
 */
function processNameOf(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const first = out.trim().split(/\r?\n/).find((l) => l.trim());
    if (!first || !/^"/.test(first)) return null;          // "信息: 没有运行的任务…"
    const name = first.split('","')[0].replace(/^"/, '').trim();
    return name || null;
  } catch {
    return null;   // tasklist 不可用/超时：当作"查不了"，沿用原判断
  }
}

/** 锁文件里有可能是主进程（electron）或 headless（node）的 PID。 */
const LOCK_HOLDER_NAMES = new Set(['electron.exe', 'node.exe', 'QQ Agent.exe'.toLowerCase()]);

/** 进程是否还活着（Windows / POSIX 通用：signal 0 不杀进程，只探测）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code !== 'EPERM') return false;   // ESRCH 等：确实没了
    // EPERM = 存在但无权发信号（别的用户 / 受保护进程）。Windows 上还可能是
    // PID 被复用给了无关进程 —— 用进程名再确认一次，避免残留锁把用户挡在门外。
    const name = processNameOf(pid);
    if (name === null) return true;              // 查不出来：保守当作活着
    return LOCK_HOLDER_NAMES.has(name.toLowerCase());
  }
}

/**
 * 诊断「同一项目、仍在运行」的同伴进程（R8-0-A3：只记录，不杀）。
 *
 * 3210（+ PROFILE 偏移）守门之后，第二实例在 listen 就失败，不需要启动后清理；
 * 这里只保留诊断价值：PID / 命令行 / 启动时间 / 是否早于本实例。
 *
 * @param {string} appRoot  本项目的根目录（用来匹配命令行）
 * @param {(msg: string) => void} [log]
 * @returns {{ found: object[], error: string|null }}
 */
export function diagnoseSiblings(appRoot, log = null) {
  const out = { found: [], error: null };
  if (process.platform !== 'win32') return out;
  if (!appRoot) return { ...out, error: '没给 appRoot，跳过诊断' };

  const norm = (x) => String(x || '').replace(/\\/g, '/').toLowerCase();
  const rootNorm = norm(appRoot);

  let list = [];
  try {
    const ps = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='QQ Agent.exe' OR Name='node.exe'\" -ErrorAction SilentlyContinue",
      '$out = foreach ($p in $procs) {',
      '  [PSCustomObject]@{',
      '    pid = [int]$p.ProcessId',
      '    cmd = [string]$p.CommandLine',
      "    start = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }",
      '  }',
      '}',
      '$out | ConvertTo-Json -Compress -Depth 3'
    ].join('; ');
    const raw = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8', timeout: 12000, windowsHide: true
    });
    const parsed = JSON.parse(String(raw || '[]').trim() || '[]');
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return { ...out, error: '查进程失败：' + String(e?.message ?? e).slice(0, 120) };
  }

  if (!list.length) return out;

  const myself = list.find((x) => Number(x.pid) === process.pid);
  const myStart = myself?.start ? Date.parse(myself.start) : 0;

  for (const item of list) {
    const pid = Number(item.pid);
    if (!pid || pid === process.pid) continue;
    if (!norm(item.cmd).includes(rootNorm)) continue;
    const theirStart = item.start ? Date.parse(item.start) : 0;
    const earlier = Boolean(myStart && theirStart && theirStart < myStart);
    out.found.push({
      pid,
      cmd: String(item.cmd || '').slice(0, 300),
      start: String(item.start || ''),
      earlier
    });
    log?.('[lock] 诊断：同项目进程 PID ' + pid + '（' + (item.start || '未知') + '）'
      + (earlier ? '，早于本实例' : '') + ' —— 仅记录，不终止');
  }

  return out;
}

/**
 * 尝试获取单实例锁。
 *
 * 用 `wx`（O_CREAT|O_EXCL）原子创建锁文件：文件已存在则创建失败，
 * 这是唯一能真正防"两个进程同时通过检查、都以为自己拿到锁"的机制。
 * 存在时再读 PID 判断是活锁（拒绝）还是残留锁（删除后重试一次）。
 *
 * @returns {{ ok: boolean, reason?: string, existingPid?: number }}
 */
export function acquireInstanceLock() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* 忽略，下面写文件会再试 */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx：仅当文件不存在时创建，已存在则抛 EEXIST —— 原子操作，无竞态窗口
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      // R8-0-A3：锁已降级为 PID 记录；兄弟进程只诊断、不终止。
      // 单实例排他由 3210（+PROFILE 偏移）的独占监听负责。
      try {
        const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const diag = diagnoseSiblings(appRoot, (m) => console.warn(m));
        if (diag.found.length || diag.error) {
          return { ok: true, siblings: diag.found, siblingError: diag.error };
        }
      } catch { /* 扫不动就算了，诊断失败不影响启动 */ }
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: `无法写入实例锁文件：${error?.message ?? error}` };
      }
      // 锁文件已存在：读 PID 判断是否活锁
      let existingPid = null;
      try {
        existingPid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) || null;
      } catch { /* 读不出就当残留 */ }
      if (existingPid && existingPid !== process.pid && pidAlive(existingPid)) {
        return { ok: false, reason: `已有 QQ Agent 实例在运行（PID ${existingPid}）`, existingPid };
      }
      // 残留锁（进程已死 / 锁是自己上次异常留下的）：删掉，下一轮用 wx 重新抢
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 删不掉则下一轮 wx 仍 EEXIST，最终报错 */ }
    }
  }
  return { ok: false, reason: '实例锁被占用且无法清除（可能有实例正在启动）' };
}

/** 释放单实例锁（正常退出时调用）。 */
export function releaseInstanceLock() {
  try {
    // 只删自己的锁：万一锁被新实例抢走了，不能误删
    const content = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
    if (Number(content) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 文件不存在/读不出都无所谓 */ }
}

/** 注册退出时自动释放锁（SIGINT/SIGTERM/正常 exit）。 */
export function registerLockCleanup() {
  const cleanup = () => releaseInstanceLock();
  // 锁的**唯一**释放时机是 'exit' 钩子：SIGINT 时立即释放会让优雅退出
  //（server.js 的 await app.stop()，可能数秒）期间新实例抢先拿锁、
  // 与旧实例短暂并存（双核心 = 群里重复回复）。交给 exit 钩子则天然
  // 排在进程真正结束之后，无竞态窗口。
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      // ⚠️ 不做任何事：不退出、不提前释放锁 —— 优雅退出 handler
      //   （server.js / electron）紧随其后执行，最终 process.exit 触发
      //   上面的 'exit' 钩子释放锁。
      // 保险丝：若 30 秒内没有别的 handler 退出进程（异常场景，优雅退出
      // 挂死），强制退出 —— 用非零码，让外层（守护脚本）能识别异常退出。
      const fuse = setTimeout(() => process.exit(1), 30000);
      fuse.unref?.();
    });
  }
}

// 存储容量监控（4.0 · 1.5.7.6）。
//
// 机主定的阈值（2026-11-01）：
//   < 500 MB   正常
//   ≥ 500 MB   预警（面板显示警告）
//   ≥ 1 GB     暂停自动归档扩张，等待人工检查
//
// **重要边界**：1 GB 只暂停自动归档。
// 不删除文件、不停止机器人、不影响聊天、不影响日记、不影响必要的 Session 保存。
//
// 为什么单列一个模块：归档脚本、面板、启动自检都要看同一份口径，
// 各写一遍就会算出不同的数（审计时就发现过 `du` 和代码统计对不上）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const WARN_BYTES = 500 * 1024 * 1024;
export const STOP_BYTES = 1024 * 1024 * 1024;

/** 监控的目录（相对 data/）。 */
const WATCH_DIRS = [
  'sessions',
  'dsh-home',
  'messages',
  'companion-events',
  'logs',
  'usage-days',
  'drawings',
  'stickers',
  'memory',
  'backups'
];

/** 监控的单个大文件。 */
const WATCH_FILES = [
  'autonomous.json',
  'learned.json',
  'dsh-sessions.json',
  'sessions-archive-manifest.json',
  'diary-idempotency.json',
  'usage-today.json'
];

/** 递归算目录大小（不跟随符号链接）。 */
function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  let newest = 0;
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.isFile()) continue;
        try {
          const st = fs.statSync(p);
          bytes += st.size;
          files += 1;
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* 文件刚好被删 */ }
      }
    };
    walk(dir);
  } catch { /* 目录不存在 */ }
  return { bytes, files, newest, exists: fs.existsSync(dir) };
}

function fileSize(file) {
  try {
    const st = fs.statSync(file);
    return { bytes: st.size, files: 1, newest: st.mtimeMs, exists: true };
  } catch {
    return { bytes: 0, files: 0, newest: 0, exists: false };
  }
}

/**
 * 全量存储体检。
 *
 * @returns {{
 *   ok:boolean, level:'ok'|'warn'|'stop', totalBytes:number,
 *   warnBytes:number, stopBytes:number,
 *   dirs: Array<{name:string, bytes:number, files:number, newest:number, exists:boolean}>,
 *   files: Array<{name:string, bytes:number, exists:boolean}>,
 *   issues: Array<{level:string, code:string, message:string}>
 * }}
 */
export function storageHealth({ dataDir = DATA_DIR } = {}) {
  const dirs = WATCH_DIRS.map((name) => ({ name, ...dirSize(path.join(dataDir, name)) }));
  const files = WATCH_FILES.map((name) => ({ name, ...fileSize(path.join(dataDir, name)) }));

  const totalBytes = dirs.reduce((s, d) => s + d.bytes, 0)
    + files.reduce((s, f) => s + f.bytes, 0);

  let level = 'ok';
  if (totalBytes >= STOP_BYTES) level = 'stop';
  else if (totalBytes >= WARN_BYTES) level = 'warn';

  const issues = [];
  if (level === 'warn') {
    issues.push({
      level: 'warn',
      code: 'storage-warn',
      message: `数据目录已用 ${(totalBytes / 1048576).toFixed(0)} MB，超过 500 MB 预警线`
    });
  }
  if (level === 'stop') {
    issues.push({
      level: 'error',
      code: 'storage-stop',
      message: `数据目录已用 ${(totalBytes / 1048576).toFixed(0)} MB，超过 1 GB —— 已暂停自动归档，不影响聊天/日记`
    });
  }

  // 单目录异常提示：sessions 超过 300 MB 说明归档没在跑
  const sess = dirs.find((d) => d.name === 'sessions');
  if (sess && sess.bytes > 300 * 1024 * 1024) {
    issues.push({
      level: 'info',
      code: 'sessions-lagging',
      message: `sessions 占 ${(sess.bytes / 1048576).toFixed(0)} MB，可能有大量未归档的会话`
    });
  }

  return {
    ok: level !== 'stop',
    level,
    totalBytes,
    warnBytes: WARN_BYTES,
    stopBytes: STOP_BYTES,
    dirs: dirs.sort((a, b) => b.bytes - a.bytes),
    files: files.sort((a, b) => b.bytes - a.bytes),
    issues
  };
}

/** 归档能不能现在跑（1 GB 时暂停自动归档扩张）。 */
export function canArchive({ dataDir = DATA_DIR } = {}) {
  const h = storageHealth({ dataDir });
  if (h.level === 'stop') {
    return {
      ok: false,
      level: h.level,
      totalBytes: h.totalBytes,
      reason: `数据目录已用 ${(h.totalBytes / 1048576).toFixed(0)} MB（≥1 GB），按规则暂停自动归档，请先人工检查`
    };
  }
  return { ok: true, level: h.level, totalBytes: h.totalBytes, reason: '' };
}

/** 给日志/面板用的一行摘要。 */
export function summaryLine({ dataDir = DATA_DIR } = {}) {
  const h = storageHealth({ dataDir });
  const big = h.dirs[0];
  return `存储 ${(h.totalBytes / 1048576).toFixed(0)} MB / 预警 500 MB（最大：${big ? `${big.name} ${(big.bytes / 1048576).toFixed(0)} MB` : '—'}）`;
}

// MemoryStore 跨进程端口锁（D1-1B-1）。
//
// 依据 D1-1A-2 已验证的方案：
//   · 文件 → 确定性端口（FNV-1a，42000–42999），只绑 127.0.0.1；
//   · bind 成功 = 持锁；EADDRINUSE → 重试到超时 → 失败（绝不写）；
//   · 进程退出（含 SIGKILL）由 OS 释放端口，无需陈旧锁回收。
//
// 额外提供**进程内同文件队列**：同一进程并发写同一文件时串行进入，
// 避免自己和自己抢端口；不同文件互不影响。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const PORT_BASE = 42000;
export const PORT_RANGE = 1000;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_RETRY_MS = 20;
export const DEFAULT_MAX_PENDING = 200;

/** 锁错误：code 统一，reason 区分超时/端口占用/绑定失败。 */
export class MemoryLockError extends Error {
  constructor(code, { reason = '', port = 0, cause = null } = {}) {
    super(`${code}: ${reason}${port ? ` (port ${port})` : ''}`);
    this.name = 'MemoryLockError';
    this.code = code;
    this.reason = reason;
    this.port = port;
    this.cause = cause;
  }
}

/** 规范化：绝对路径 → realpath（存在时）→ 反斜杠 → 小写。 */
export function normalizeMemoryFile(file) {
  let p = path.resolve(String(file));
  try { p = fs.realpathSync.native(p); } catch { /* 不存在就用 resolve 结果 */ }
  return p.replace(/\//g, '\\').toLowerCase();
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 文件 → 端口（同一规范化路径必定同端口）。 */
export function memoryPortFor(file) {
  return PORT_BASE + (fnv1a(normalizeMemoryFile(file)) % PORT_RANGE);
}

/** 进程内同文件队列与全局排队计数。 */
const chains = new Map();
let pendingCount = 0;

function acquire(key, { timeoutMs, retryMs }) {
  const port = memoryPortFor(key);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const server = net.createServer((sock) => { sock.destroy(); });
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try { server.close(); } catch { /* ignore */ }
        if (e?.code === 'EADDRINUSE') {
          if (Date.now() < deadline) { setTimeout(tryOnce, retryMs); return; }
          reject(new MemoryLockError('EMEMORY_LOCK_TIMEOUT', { reason: 'PORT_BUSY', port, cause: e }));
          return;
        }
        reject(new MemoryLockError('EMEMORY_LOCK_BIND', { reason: e?.code ?? 'UNKNOWN', port, cause: e }));
      };
      server.once('error', fail);
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        if (settled) return;
        settled = true;
        server.off('error', fail);
        server.on('error', () => { /* 持锁期间不再因错误崩溃 */ });
        resolve(() => new Promise((r) => {
          try { server.close(() => r()); } catch { r(); }
        }));
      });
    };
    tryOnce();
  });
}

/**
 * 在端口锁内执行 fn（完整读—改—写必须在 fn 内）。
 *
 * @param {string} file
 * @param {() => any | Promise<any>} fn
 * @param {{timeoutMs?:number, retryMs?:number, maxPending?:number}} [opts]
 */
export function withMemoryPortLock(file, fn, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retryMs = Number(opts.retryMs ?? DEFAULT_RETRY_MS);
  const maxPending = Number(opts.maxPending ?? DEFAULT_MAX_PENDING);
  const key = normalizeMemoryFile(file);

  if (pendingCount >= maxPending) {
    return Promise.reject(new MemoryLockError('ELOCK_QUEUE_FULL', {
      reason: `pending=${pendingCount}`, port: memoryPortFor(key)
    }));
  }

  pendingCount += 1;
  const deadline = Date.now() + timeoutMs;
  const prev = chains.get(key) || Promise.resolve();
  const task = prev
    .then(() => {
      // 进程内排队也算等待时间：排到时已超时 → 直接失败，不进入临界区
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new MemoryLockError('EMEMORY_LOCK_TIMEOUT', { reason: 'QUEUE_WAIT', port: memoryPortFor(key) });
      }
      return acquire(key, { timeoutMs: remaining, retryMs });
    })
    .then((release) => Promise.resolve().then(fn).finally(release));

  const tail = task.catch(() => { /* 失败不阻塞后续同文件请求 */ });
  chains.set(key, tail);
  tail.finally(() => {
    pendingCount -= 1;
    if (chains.get(key) === tail) chains.delete(key);
  });

  return task;
}

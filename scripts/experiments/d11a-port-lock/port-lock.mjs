// D1-1A-2 隔离实验：端口锁（loopback TCP bind）——实验实现，不接 MemoryStore。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const BASE_PORT = 42000;
export const PORT_RANGE = 1000;

/** 规范化：绝对路径 → realpath（存在时）→ 统一反斜杠 → 小写（Windows 大小写不敏感）。 */
export function normalizeFile(file) {
  let p = path.resolve(String(file));
  try { p = fs.realpathSync.native(p); } catch { /* 不存在就用 resolve 结果 */ }
  return p.replace(/\//g, '\\').toLowerCase();
}

/** FNV-1a 32 位：确定性、跨进程一致。 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 文件 → 端口（同文件永远同端口；不同文件允许碰撞，碰撞 = 额外串行）。 */
export function portForFile(file) {
  return BASE_PORT + (fnv1a(normalizeFile(file)) % PORT_RANGE);
}

/**
 * 用一次性 bind 持有锁；拿不到就重试到超时，超时失败（绝不写）。
 * 只绑 127.0.0.1；连接进来直接销毁（不提供业务）。
 */
export function withPortLock(file, fn, { timeoutMs = 5000, retryMs = 20 } = {}) {
  const port = portForFile(file);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const server = net.createServer((sock) => { sock.destroy(); });
      let done = false;
      const fail = (code) => {
        if (done) return;
        done = true;
        try { server.close(); } catch { /* ignore */ }
        if (code === 'EADDRINUSE' && Date.now() < deadline) {
          setTimeout(tryOnce, retryMs);
          return;
        }
        const err = new Error(`EPORTLOCK: ${code} (port ${port})`);
        err.code = 'EPORTLOCK';
        err.causeCode = code;
        err.port = port;
        reject(err);
      };
      server.once('error', (e) => fail(e?.code ?? 'ERROR'));
      server.listen({ port, host: '127.0.0.1', exclusive: true }, async () => {
        if (done) return;
        try {
          const r = await fn({ port });
          done = true;
          server.close(() => resolve(r));
        } catch (e) {
          done = true;
          server.close(() => reject(e));
        }
      });
    };
    tryOnce();
  });
}

// D1-1B-1 专项：MemoryStore 端口锁（映射、双进程、进程内队列、超时、占用、碰撞）。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'memory-port-lock-worker.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlock-'));
const c = createChecker('D1-1B-1 端口锁');
const { withMemoryPortLock, memoryPortFor, normalizeMemoryFile, MemoryLockError } = await import('../src/memory-port-lock.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = (name) => path.join(tmp, name + '.json');
const reset = (name) => fs.writeFileSync(file(name), JSON.stringify({ count: 0 }));
const readCount = (name) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')).count; } catch { return 0; } };

const runWorker = ({ mode = 'lock', name, iters, timeoutMs = 5000 }) => new Promise((resolve) => {
  const out = path.join(tmp, `out-${name}-${process.hrtime.bigint()}.json`);
  const fd = fs.openSync(out, 'w');
  const child = spawn(process.execPath, [WORKER, mode, tmp, name, String(iters), String(timeoutMs), out], {
    stdio: ['ignore', fd, 'ignore'], windowsHide: true
  });
  child.on('exit', () => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch { resolve({ ok: 0, failed: 0, errors: ['no-output'], port: 0 }); }
  });
});

const tryBind = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => resolve({ ok: false, code: e.code }));
  s.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve({ ok: true, server: s }));
});
const closeServer = (s) => new Promise((r) => { try { s.close(() => r()); } catch { r(); } });

try {
  c.section('1. 映射：同文件稳定、不同文件不同、规范化');
  {
    const a = file('m1');
    await c.check('同一路径两次映射相同', () => {
      if (memoryPortFor(a) !== memoryPortFor(a)) throw new Error('不稳定');
    });
    await c.check('大小写/分隔符规范化后相同', () => {
      const upper = a.replace(/\\/g, '/').toUpperCase();
      if (memoryPortFor(upper) !== memoryPortFor(a)) throw new Error(`${memoryPortFor(upper)} vs ${memoryPortFor(a)}`);
    });
    await c.check('不同文件映射到不同端口（抽样）', () => {
      const ports = new Set();
      for (let i = 0; i < 50; i++) ports.add(memoryPortFor(file('m' + i)));
      if (ports.size < 40) throw new Error(`只得到 ${ports.size} 个端口`);
    });
    await c.check('端口在 42000–42999', () => {
      for (let i = 0; i < 200; i++) {
        const p = memoryPortFor(file('range' + i));
        if (p < 42000 || p > 42999) throw new Error(String(p));
      }
    });
    await c.check('normalizeMemoryFile 是绝对小写', () => {
      const n = normalizeMemoryFile(file('norm'));
      if (!path.isAbsolute(n) || n !== n.toLowerCase()) throw new Error(n);
    });
  }

  c.section('2. 双进程各 50 次 → 100（独立 Node 进程）');
  {
    reset('dual');
    const [a, b] = await Promise.all([
      runWorker({ name: 'dual', iters: 50 }),
      runWorker({ name: 'dual', iters: 50 })
    ]);
    await c.check('最终计数 100', () => {
      if (readCount('dual') !== 100) throw new Error(`${readCount('dual')} (a=${a.ok} b=${b.ok})`);
    });
  }

  c.section('3. 同进程并发写入');
  {
    reset('same');
    const results = await Promise.all(Array.from({ length: 20 }, () => withMemoryPortLock(file('same'), () => {
      const data = JSON.parse(fs.readFileSync(file('same'), 'utf8'));
      data.count += 1;
      fs.writeFileSync(file('same'), JSON.stringify(data));
    })));
    await c.check('20 次并发全部完成且计数 20', () => {
      if (results.length !== 20 || readCount('same') !== 20) throw new Error(`${results.length}/${readCount('same')}`);
    });
  }

  c.section('4. 不同文件并行');
  {
    const t0 = Date.now();
    await Promise.all([
      withMemoryPortLock(file('par1'), () => sleep(250)),
      withMemoryPortLock(file('par2'), () => sleep(250))
    ]);
    await c.check('两个不同文件并行耗时 < 450ms', () => {
      const ms = Date.now() - t0;
      if (ms >= 450) throw new Error(`${ms}ms`);
    });
  }

  c.section('5. 映射碰撞：安全串行');
  {
    const seen = new Map();
    let pair = null;
    for (let i = 0; i < 20000 && !pair; i++) {
      const name = 'col' + i;
      const p = memoryPortFor(file(name));
      if (seen.has(p)) pair = [seen.get(p), name];
      else seen.set(p, name);
    }
    const t0 = Date.now();
    await Promise.all([
      withMemoryPortLock(file(pair[0]), () => sleep(250)),
      withMemoryPortLock(file(pair[1]), () => sleep(250))
    ]);
    await c.check('同端口两个文件串行（耗时 ≥ 450ms）', () => {
      const ms = Date.now() - t0;
      if (ms < 450) throw new Error(`${ms}ms`);
    });
  }

  c.section('6. 持锁超时：不写入');
  {
    reset('timeout');
    let holding = true;
    const hold = withMemoryPortLock(file('timeout'), async () => {
      await sleep(600);
      holding = false;
    });
    await sleep(100);
    await c.check('超时期间没有写入（count 0）', () => {
      if (!holding) throw new Error('持锁已结束，测试时序不对');
      if (readCount('timeout') !== 0) throw new Error(String(readCount('timeout')));
    });
    await c.check('排队超时 → EMEMORY_LOCK_TIMEOUT，不进入临界区', async () => {
      try {
        await withMemoryPortLock(file('timeout'), () => { throw new Error('不该进入'); }, { timeoutMs: 100 });
        throw new Error('没抛错');
      } catch (e) {
        if (e.code !== 'EMEMORY_LOCK_TIMEOUT') throw new Error(`${e.code}:${e.reason}`);
        if (String(e.message).includes('不该进入')) throw new Error('进入了临界区');
      }
    });
    await hold;
    await c.check('结束后计数仍是 0', () => {
      if (readCount('timeout') !== 0) throw new Error(String(readCount('timeout')));
    });
  }

  c.section('7. 端口被无关进程占用：fail-closed');
  {
    reset('occupied');
    const port = memoryPortFor(file('occupied'));
    const occ = await tryBind(port);
    await c.check('错误码是 TIMEOUT/PORT_BUSY，且不写', async () => {
      try {
        await withMemoryPortLock(file('occupied'), () => { throw new Error('不该进入'); }, { timeoutMs: 150 });
        throw new Error('没抛错');
      } catch (e) {
        if (e.code !== 'EMEMORY_LOCK_TIMEOUT' || e.reason !== 'PORT_BUSY') throw new Error(`${e.code}:${e.reason}`);
      }
      if (readCount('occupied') !== 0) throw new Error('被写入了');
    });
    if (occ.server) await closeServer(occ.server);
  }

  c.section('8. 正常释放后立即重新获取');
  {
    reset('re');
    await withMemoryPortLock(file('re'), () => { /* 空临界区 */ });
    await c.check('释放后可立即再取并写入', async () => {
      await withMemoryPortLock(file('re'), () => {
        fs.writeFileSync(file('re'), JSON.stringify({ count: 7 }));
      });
      if (readCount('re') !== 7) throw new Error(String(readCount('re')));
    });
  }

  c.section('9. 队列上限');
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const p1 = withMemoryPortLock(file('queue'), () => gate, { maxPending: 1 });
    await sleep(50);
    await c.check('pending 满 → ELOCK_QUEUE_FULL', async () => {
      try {
        await withMemoryPortLock(file('queue'), () => 1, { maxPending: 1 });
        throw new Error('没抛错');
      } catch (e) {
        if (e.code !== 'ELOCK_QUEUE_FULL') throw new Error(e.code);
      }
    });
    release();
    await p1;
  }

  c.section('10. 错误类型是 MemoryLockError');
  {
    await c.check('MemoryLockError 可 instanceof', () => {
      if (!(new MemoryLockError('X') instanceof Error)) throw new Error('不是 Error');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);

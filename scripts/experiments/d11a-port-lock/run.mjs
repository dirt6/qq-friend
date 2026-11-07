// D1-1A-2 端口锁隔离实验（11 项，每项 5 次）。
// 运行：node scripts/experiments/d11a-port-lock/run.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portForFile, normalizeFile } from './port-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd11a-port-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUNS = 5;

const spawnWorker = ({ mode = 'portlock', name, iters = 1, holdMs = 0, timeoutMs = 5000 }) => new Promise((resolve) => {
  const outFile = path.join(tmp, `out-${name}-${process.hrtime.bigint()}.json`);
  const fd = fs.openSync(outFile, 'w');
  const child = spawn(process.execPath, [WORKER, mode, tmp, name, String(iters), String(holdMs), String(timeoutMs)], {
    stdio: ['ignore', fd, 'ignore'], windowsHide: true
  });
  child.on('exit', () => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { resolve(JSON.parse(fs.readFileSync(outFile, 'utf8'))); } catch { resolve({ ok: 0, failed: 0, errors: ['no-output'] }); }
  });
});

const readCount = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(tmp, name + '.json'), 'utf8')).count; } catch { return 0; }
};
const reset = (name) => {
  fs.writeFileSync(path.join(tmp, name + '.json'), JSON.stringify({ count: 0 }));
};

const tryBind = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => resolve({ ok: false, code: e.code }));
  s.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve({ ok: true, server: s }));
});
const closeServer = (s) => new Promise((r) => { try { s.close(() => r()); } catch { r(); } });

const findPair = (kind) => {
  const seen = new Map();
  for (let i = 0; i < 20000; i++) {
    const name = `f${i}`;
    const port = portForFile(path.join(tmp, name + '.json'));
    if (seen.has(port)) {
      if (kind === 'collision') return { a: seen.get(port), b: name, port };
    } else {
      seen.set(port, name);
      if (kind === 'different' && seen.size >= 2) {
        const [a, b] = [...seen.values()];
        if (portForFile(path.join(tmp, a + '.json')) !== portForFile(path.join(tmp, b + '.json'))) return { a, b };
      }
    }
  }
  return null;
};

const results = { tmp, runsPerExperiment: RUNS };

// ① 两个独立 bind 同端口：只能一个成功
{
  const port = portForFile(path.join(tmp, 'bind-same.json'));
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    const a = await tryBind(port);
    const b = await tryBind(port);
    rows.push({ aOk: a.ok, bOk: b.ok, bCode: b.code });
    if (a.server) await closeServer(a.server);
    if (b.server) await closeServer(b.server);
  }
  results.bindSamePort = { port, rows, pass: rows.every((r) => r.aOk && !r.bOk && (r.bCode === 'EADDRINUSE' || r.bCode === 'WSAEACCES')) };
}

// ② 持锁期间第二个不得进入（超时失败）
{
  const name = 'hold';
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    reset(name);
    const holder = spawnWorker({ mode: 'port-hold', name, holdMs: 700, timeoutMs: 3000 });
    await sleep(150);
    const waiter = await spawnWorker({ name, iters: 1, timeoutMs: 150 });
    const h = await holder;
    rows.push({ holderOk: h.ok, waiterOk: waiter.ok, waiterFailed: waiter.failed, count: readCount(name) });
  }
  results.contention = { rows, pass: rows.every((r) => r.holderOk === 1 && r.waiterFailed === 1 && r.waiterOk === 0 && r.count === 0) };
}

// ③ 正常退出后第二个取得锁
{
  const name = 'normal';
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    reset(name);
    const holder = spawnWorker({ mode: 'port-hold', name, holdMs: 200, timeoutMs: 3000 });
    await sleep(100);
    const second = await spawnWorker({ name, iters: 1, timeoutMs: 3000 });
    const h = await holder;
    rows.push({ holderOk: h.ok, secondOk: second.ok, count: readCount(name) });
  }
  results.normalExit = { rows, pass: rows.every((r) => r.holderOk === 1 && r.secondOk === 1) };
}

// ④ 强制终止（SIGKILL）后恢复
{
  const name = 'killed';
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    reset(name);
    await spawnWorker({ mode: 'port-suicide', name, timeoutMs: 3000 });
    const rec = await spawnWorker({ name, iters: 2, timeoutMs: 3000 });
    rows.push({ recOk: rec.ok, recFailed: rec.failed, count: readCount(name) });
  }
  results.killRecovery = { rows, pass: rows.every((r) => r.recOk === 2 && r.count === 3) };
}

// ⑤ 超时失败不写入
{
  const name = 'timeout';
  reset(name);
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    const holder = spawnWorker({ mode: 'port-hold', name, holdMs: 600, timeoutMs: 3000 });
    await sleep(100);
    const w = await spawnWorker({ name, iters: 1, timeoutMs: 100 });
    await holder;
    rows.push({ failed: w.failed, ok: w.ok, count: readCount(name) });
  }
  results.timeoutNoWrite = { rows, pass: rows.every((r) => r.failed === 1 && r.ok === 0 && r.count === 0) };
}

// ⑥ 不同文件端口不同 → 独立持锁
{
  const pair = findPair('different');
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    reset(pair.a); reset(pair.b);
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      spawnWorker({ name: pair.a, iters: 1, holdMs: 300, timeoutMs: 3000 }),
      spawnWorker({ name: pair.b, iters: 1, holdMs: 300, timeoutMs: 3000 })
    ]);
    rows.push({
      aOk: a.ok, bOk: b.ok, aPort: a.port, bPort: b.port,
      portsDiffer: a.port !== b.port, elapsed: Date.now() - t0
    });
  }
  results.differentFiles = { pair, rows, pass: rows.every((r) => r.aOk === 1 && r.bOk === 1 && r.portsDiffer && r.elapsed < 900) };
}

// ⑦ hash 碰撞：同一端口 → 安全地额外串行，不选备用端口
{
  const pair = findPair('collision');
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    reset(pair.a); reset(pair.b);
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      spawnWorker({ name: pair.a, iters: 1, holdMs: 300, timeoutMs: 3000 }),
      spawnWorker({ name: pair.b, iters: 1, holdMs: 300, timeoutMs: 3000 })
    ]);
    rows.push({
      aOk: a.ok, bOk: b.ok, samePort: a.port === b.port && b.port === pair.port,
      elapsed: Date.now() - t0
    });
  }
  results.collision = { pair, rows, pass: rows.every((r) => r.aOk === 1 && r.bOk === 1 && r.samePort && r.elapsed >= 450) };
}

// ⑧ 无关程序占端口 → MemoryStore 锁必须失败关闭
{
  const name = 'occupied';
  reset(name);
  const port = portForFile(path.join(tmp, name + '.json'));
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    const occ = await tryBind(port);
    const w = await spawnWorker({ name, iters: 1, timeoutMs: 200 });
    if (occ.server) await closeServer(occ.server);
    rows.push({ occupied: occ.ok, wOk: w.ok, wFailed: w.failed, errors: w.errors, count: readCount(name) });
  }
  results.occupied = { port, rows, pass: rows.every((r) => r.occupied && r.wFailed === 1 && r.wOk === 0 && r.count === 0) };
}

// ⑨ 两进程并发读改写 → 不丢更新
{
  const name = 'counter';
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    reset(name);
    const [a, b] = await Promise.all([
      spawnWorker({ name, iters: 50, timeoutMs: 5000 }),
      spawnWorker({ name, iters: 50, timeoutMs: 5000 })
    ]);
    rows.push({ aOk: a.ok, bOk: b.ok, final: readCount(name) });
  }
  results.concurrentCounter = { rows, pass: rows.every((r) => r.final === 100) };
}

// ⑩ 临界区内异常退出：socket 释放 + 文件一致性
{
  const name = 'crash';
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    reset(name);
    await spawnWorker({ mode: 'port-suicide', name, timeoutMs: 3000 });
    let parseable = false;
    let count = null;
    try { const j = JSON.parse(fs.readFileSync(path.join(tmp, name + '.json'), 'utf8')); parseable = true; count = j.count; } catch { /* ignore */ }
    const rec = await spawnWorker({ name, iters: 1, timeoutMs: 3000 });
    rows.push({ parseable, count, recOk: rec.ok, final: readCount(name) });
  }
  results.crashConsistency = { rows, pass: rows.every((r) => r.parseable && r.recOk === 1) };
}

// ⑪ 资源关闭：各场景后端口可重新 bind
{
  const name = 'resource';
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    reset(name);
    const port = portForFile(path.join(tmp, name + '.json'));
    await spawnWorker({ name, iters: 1, timeoutMs: 3000 });
    const rebind = await tryBind(port);
    if (rebind.server) await closeServer(rebind.server);
    rows.push({ rebindOk: rebind.ok, code: rebind.code });
  }
  results.resourceClose = { rows, pass: rows.every((r) => r.rebindOk) };
}

results.sampleMapping = {
  normalized: normalizeFile(path.join(tmp, 'Sample.JSON')),
  port: portForFile(path.join(tmp, 'Sample.JSON'))
};

fs.writeFileSync(path.join(HERE, 'result.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

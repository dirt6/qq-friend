// D1-1A 隔离实验主脚本（纯 Node，不依赖 native）。
// 运行：node scripts/experiments/d11a-lock/run.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd11a-lock-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runWorker({ mode = 'wx', name, iters, holdMs = 0, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const out = path.join(tmp, `out-${name}-${process.hrtime.bigint()}.json`);
    const fd = fs.openSync(out, 'w');
    const child = spawn(process.execPath, [WORKER, mode, tmp, name, String(iters), String(holdMs), String(timeoutMs)], {
      stdio: ['ignore', fd, 'ignore'], windowsHide: true
    });
    child.on('exit', () => {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { resolve({ ...JSON.parse(fs.readFileSync(out, 'utf8')), code: child.exitCode }); } catch { resolve({ ok: 0, failed: 0, code: child.exitCode }); }
    });
  });
}

const counter = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(tmp, name + '.json'), 'utf8')).count; } catch { return 0; }
};
const reset = (name) => {
  fs.writeFileSync(path.join(tmp, name + '.json'), JSON.stringify({ count: 0 }));
  try { fs.rmSync(path.join(tmp, name + '.json.lock'), { force: true }); } catch { /* ignore */ }
};

const results = { tmp };

// ① 无锁对照：两个进程各 +50，预期丢更新
reset('c1');
const [a1, b1] = await Promise.all([
  runWorker({ mode: 'nolock', name: 'c1', iters: 50 }),
  runWorker({ mode: 'nolock', name: 'c1', iters: 50 })
]);
results.nolock = { final: counter('c1'), expected: 100, a: a1, b: b1, lost: 100 - counter('c1') };

// ② wx + 认领式回收：两个进程各 +50，预期 100
reset('c2');
const [a2, b2] = await Promise.all([
  runWorker({ name: 'c2', iters: 50 }),
  runWorker({ name: 'c2', iters: 50 })
]);
results.wx = { final: counter('c2'), expected: 100, a: a2, b: b2 };

// ③ 持锁进程自杀（SIGKILL，不释放）→ 锁残留 → 另一进程认领恢复
reset('c3');
const suicide = spawn(process.execPath, [WORKER, 'wx-suicide', tmp, 'c3', '1', '0', '3000'], {
  stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true
});
await new Promise((r) => suicide.on('exit', r));
await sleep(300);
const stalePid = (() => { try { return JSON.parse(fs.readFileSync(path.join(tmp, 'c3.json.lock'), 'utf8')).pid; } catch { return null; } })();
let staleAlive = true;
try { process.kill(Number(stalePid), 0); } catch { staleAlive = false; }
const rec = await runWorker({ name: 'c3', iters: 5, timeoutMs: 3000 });
results.killRecovery = {
  lockPid: stalePid, lockPidStillAlive: staleAlive,
  recovered: rec.ok === 5, final: counter('c3'), rec
};

// ④ 锁被活进程持有 → 等待超时，不写入
reset('c4');
const holder = spawn(process.execPath, [WORKER, 'wx', tmp, 'c4', '1', '3000', '5000'], {
  stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true
});
await sleep(400);
const waiter = await runWorker({ name: 'c4', iters: 1, timeoutMs: 300 });
await new Promise((r) => holder.on('exit', r));
results.timeout = { waiterFailed: waiter.failed === 1, waiterOk: waiter.ok, final: counter('c4') };

// ⑤ 不同成员文件各自持锁 → 不互相阻塞
reset('d5a'); reset('d5b');
const [a5, b5] = await Promise.all([
  runWorker({ name: 'd5a', iters: 30 }),
  runWorker({ name: 'd5b', iters: 30 })
]);
results.separate = { a: counter('d5a'), b: counter('d5b'), aOk: a5.ok, bOk: b5.ok };

// ⑥ 锁文件被外部删除 → 互斥失效（用户态锁固有限制）
reset('c6');
const h6 = spawn(process.execPath, [WORKER, 'wx', tmp, 'c6', '1', '2000', '5000'], {
  stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true
});
await sleep(400);
try { fs.rmSync(path.join(tmp, 'c6.json.lock'), { force: true }); } catch { /* ignore */ }
const w6 = await runWorker({ name: 'c6', iters: 1, timeoutMs: 1500 });
results.deletedLock = { intruderOk: w6.ok, note: '锁文件被删除后互斥失效（用户态锁无法防恶意删除）' };
await new Promise((r) => h6.on('exit', r));

fs.writeFileSync(path.join(HERE, 'result.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

// D1-1A 隔离实验 worker：演示/对比 MemoryStore 的跨进程锁方案。
//
// 用法：node worker.mjs <nolock|wx> <dir> <name> <iters> [holdMs] [timeoutMs]
// 输出：一行 JSON { ok, failed }
import fs from 'node:fs';
import path from 'node:path';

const [, , mode, dir, name, itersRaw, holdMsRaw, timeoutMsRaw] = process.argv;
const iters = Number(itersRaw || 20);
const holdMs = Number(holdMsRaw || 0);
const timeoutMs = Number(timeoutMsRaw || 5000);
const file = path.join(dir, name + '.json');
const lock = file + '.lock';

const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

/**
 * 认领式回收：
 *   只有 wx 成功者才进入临界区。
 *   判断陈旧 → 用 rename 把旧锁"认领"走（rename 原子，只有一个进程成功），
 *   然后回到循环重新 wx；谁 wx 成功谁进。
 */
function acquire(deadline) {
  for (;;) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readJson(lock, null);
      const stale = !cur || !pidAlive(Number(cur.pid)) || (Date.now() - Number(cur.at) > 30000);
      if (stale) {
        const claimed = lock + '.stale.' + process.pid + '.' + Date.now();
        try { fs.renameSync(lock, claimed); } catch {
          // Windows：被杀进程的句柄可能还没释放，退避后再试（不忙等）
          sleep(10);
          continue;
        }
        try { fs.unlinkSync(claimed); } catch { /* ignore */ }
        sleep(2);   // 给文件系统一点时间释放旧锁路径
        continue;
      }
      if (Date.now() >= deadline) return false;
      sleep(5);
    }
  }
}

function release() {
  try {
    const cur = readJson(lock, null);
    if (cur && Number(cur.pid) === process.pid) fs.unlinkSync(lock);
  } catch { /* ignore */ }
}

function critical() {
  const data = readJson(file, { count: 0 });
  data.count = Number(data.count || 0) + 1;
  if (holdMs) sleep(holdMs);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

let ok = 0;
let failed = 0;
let firstFailAt = -1;
let maxWaitMs = 0;

// 自杀模式：拿到锁、写完计数后 SIGKILL 自己（不 release），模拟"持锁进程异常退出"。
if (mode === 'wx-suicide') {
  const deadline = Date.now() + timeoutMs;
  if (!acquire(deadline)) {
    process.stdout.write(JSON.stringify({ ok: 0, failed: 1, suicide: false }));
    process.exit(1);
  }
  critical();
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});   // 不会到这里
}

for (let i = 0; i < iters; i++) {
  if (mode === 'nolock') { critical(); ok++; continue; }
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  if (!acquire(deadline)) {
    failed++;
    if (firstFailAt < 0) firstFailAt = i;
    maxWaitMs = Math.max(maxWaitMs, Date.now() - t0);
    continue;
  }
  maxWaitMs = Math.max(maxWaitMs, Date.now() - t0);
  try { critical(); ok++; } finally { release(); }
}
process.stdout.write(JSON.stringify({ ok, failed, firstFailAt, maxWaitMs }));

// 端口锁实验 worker：并发读改写计数 / 持锁 / 自杀。
import fs from 'node:fs';
import path from 'node:path';
import { withPortLock, portForFile } from './port-lock.mjs';

const [, , mode, dir, name, itersRaw, holdMsRaw, timeoutMsRaw] = process.argv;
const iters = Number(itersRaw || 10);
const holdMs = Number(holdMsRaw || 0);
const timeoutMs = Number(timeoutMsRaw || 5000);
const file = path.join(dir, name + '.json');

const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const out = (o) => process.stdout.write(JSON.stringify({ ...o, port: portForFile(file) }));

function critical() {
  const data = readJson(file, { count: 0 });
  data.count = Number(data.count || 0) + 1;
  if (holdMs) sleep(holdMs);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

if (mode === 'port-suicide') {
  // 持锁 → 写 → SIGKILL（不 close server，模拟临界区内异常退出）
  withPortLock(file, () => {
    critical();
    process.kill(process.pid, 'SIGKILL');
  }, { timeoutMs }).catch(() => {});
  await new Promise(() => {});
}

if (mode === 'port-hold') {
  // 持锁 holdMs，用于"持锁期间别人拿不到"
  try {
    await withPortLock(file, () => { sleep(holdMs); }, { timeoutMs });
    out({ ok: 1, failed: 0, errors: [] });
  } catch (e) {
    out({ ok: 0, failed: 1, errors: [e.code + ':' + e.causeCode] });
  }
  process.exit(0);
}

let ok = 0;
let failed = 0;
const errors = [];
for (let i = 0; i < iters; i++) {
  if (mode === 'nolock') { critical(); ok++; continue; }
  try {
    await withPortLock(file, () => critical(), { timeoutMs });
    ok++;
  } catch (e) {
    failed++;
    errors.push(e.code + ':' + (e.causeCode ?? ''));
  }
}
out({ ok, failed, errors });

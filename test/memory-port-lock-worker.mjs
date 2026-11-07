// 端口锁测试 worker：独立进程执行"读—改—写"计数。
// 用法：node worker <mode:nolock|lock> <dir> <name> <iters> <timeoutMs> <outFile>
import fs from 'node:fs';
import path from 'node:path';
import { withMemoryPortLock, memoryPortFor } from '../src/memory-port-lock.js';

const [, , mode, dir, name, itersRaw, timeoutMsRaw, outFile] = process.argv;
const iters = Number(itersRaw || 10);
const timeoutMs = Number(timeoutMsRaw || 5000);
const file = path.join(dir, name + '.json');
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };

function critical() {
  const data = readJson(file, { count: 0 });
  data.count = Number(data.count || 0) + 1;
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

let ok = 0;
let failed = 0;
const errors = [];
for (let i = 0; i < iters; i++) {
  if (mode === 'nolock') { critical(); ok++; continue; }
  try {
    await withMemoryPortLock(file, () => critical(), { timeoutMs });
    ok++;
  } catch (e) {
    failed++;
    errors.push(e.code + ':' + e.reason);
  }
}
fs.writeFileSync(outFile, JSON.stringify({ ok, failed, errors, port: memoryPortFor(file) }));

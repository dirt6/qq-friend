// B-2c 集成测试 worker：独立进程用 MemoryStore 并发 append。
// 用法：node worker <dir> <chatKey> <userId> <iters> <outFile> [suicide]
import fs from 'node:fs';
import path from 'node:path';

const [, , dir, chatKey, userId, itersRaw, outFile, suicideRaw] = process.argv;
const iters = Number(itersRaw || 10);
process.env.QQ_AGENT_DATA_DIR = dir;

const { MemoryStore } = await import('../src/memory.js');
const store = new MemoryStore();
let ok = 0;
let failed = 0;
const errors = [];

if (suicideRaw === 'suicide') {
  await store.append(chatKey, 'memberImpression', `崩溃前-${process.pid}`, { userId, target: 'T' });
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
}

for (let i = 0; i < iters; i++) {
  try {
    await store.append(chatKey, 'memberImpression', `并发内容-${process.pid}-${i}`, { userId, target: 'T' });
    ok++;
  } catch (e) {
    failed++;
    errors.push(e.code + ':' + (e.reason ?? ''));
  }
}
fs.writeFileSync(outFile, JSON.stringify({ ok, failed, errors }));

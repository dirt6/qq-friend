// 跨进程并发 worker（4.0 / 3.0-R5-B / R5-C 用）。
//
// 用法：node scripts/diary-concurrent-worker.mjs <dataDir> <dayKey> <paragraphIndex> <标记>
//
// 为什么单独一个文件：跨进程测试必须真的用两个操作系统进程，
// 不能用单进程模拟。
//
// 结果写到 `<dataDir>/worker-<标记>.json`，父进程读那个文件判断
//（沙箱下子进程的 stdout 管道可能不可用，所以走文件）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const [dataDir, dayKey, idxStr, tag] = process.argv.slice(2);
const outFile = path.join(dataDir, `worker-${tag}.json`);

function report(obj) {
  try { fs.writeFileSync(outFile, JSON.stringify({ tag, ...obj, at: Date.now() }), 'utf8'); } catch { /* ignore */ }
}

async function main() {
  if (!dataDir || !dayKey) { report({ ok: false, error: '缺参数' }); return; }
  process.env.QQ_AGENT_DATA_DIR = dataDir;

  const M = await import(pathToFileURL(path.join(ROOT, 'src', 'diary', 'meta.js')).href);

  const idx = Number(idxStr);
  const r = M.appendDiaryEntry(dayKey, {
    paragraphIndex: idx,
    contentType: 'event',
    epistemicType: 'direct',
    roundId: `round-${tag}`
  });
  report({ ok: r.ok, added: r.added, error: r.error || '' });
}

main().catch((e) => report({ ok: false, error: String(e?.message || e) }));

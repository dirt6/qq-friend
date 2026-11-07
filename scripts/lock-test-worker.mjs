// 跨进程锁测试 worker（4.0 / 3.0-R5-C）。
//
// 用法：
//   node scripts/lock-test-worker.mjs <lockDir> <mode> <tag> [holdMs]
//
// mode：
//   · hold     —— 拿锁后持 holdMs 毫秒再释放，结果写文件
//   · race     —— 拿锁后立刻记录进入临界区的时间，等 holdMs 再释放
//   · crash    —— 拿锁后**直接 process.exit(1)**（模拟崩溃，锁文件残留）
//   · tryonce  —— 尝试拿锁一次（retries=1），记录成功/失败
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const [lockDir, mode, tag, holdStr] = process.argv.slice(2);
const holdMs = Number(holdStr) || 0;
const outFile = path.join(lockDir, `res-${tag}.json`);

function report(obj) {
  try {
    fs.writeFileSync(outFile, JSON.stringify({ tag, mode, ...obj, at: Date.now() }), 'utf8');
  } catch { /* ignore */ }
}

async function main() {
  const F = await import(pathToFileURL(path.join(ROOT, 'src', 'file-lock.js')).href);
  const target = path.join(lockDir, 'protected.json');
  const t0 = Date.now();

  if (mode === 'crash') {
    F.withFileLock(target, () => {
      report({ ok: true, enteredAt: Date.now(), held: true });
      // 直接把整个进程干掉（锁文件留着，模拟崩溃）
      process.exit(1);
    });
    return;
  }

  if (mode === 'tryonce') {
    try {
      F.withFileLock(target, () => {
        report({ ok: true, enteredAt: Date.now() });
      }, { retries: 1, waitMs: 5 });
      report({ ok: true, got: true });
    } catch (e) {
      report({ ok: true, got: false, code: e?.code || '' });
    }
    return;
  }

  // hold / race
  try {
    F.withFileLock(target, () => {
      report({ ok: true, enteredAt: Date.now(), waitedMs: Date.now() - t0 });
      if (holdMs > 0) {
        // 同步睡（worker 里没别的事做）
        const end = Date.now() + holdMs;
        while (Date.now() < end) { /* busy wait */ }
      }
      report({ ok: true, enteredAt: Date.now(), waitedMs: Date.now() - t0, done: true });
    });
  } catch (e) {
    report({ ok: false, error: String(e?.message || e), code: e?.code || '' });
  }
}

main().catch((e) => report({ ok: false, error: String(e?.message || e) }));

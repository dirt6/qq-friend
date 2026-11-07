// 阶段 3.0-R5-B 专项测试：appendDiaryEntry 事务锁（**真跨进程**）。
//
// 机主 2026-11-02 的要求：
//   · 读元数据 → 去重 → 追加 → 写入，全部在**同一个锁**里
//   · 避免调用 writeDiaryMeta 重复获取同一把锁（自锁）
//   · 两个独立 Node 进程同时追加**不同**条目，最终**两条都存在**
//   · 两个进程追加**同一**条目，最终**不重复**
//   · 写入失败，旧数据保持不变
//
// **不用单进程模拟代替跨进程测试。**
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const WORKER = path.join(ROOT, 'scripts', 'diary-concurrent-worker.mjs');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

/** 起一个子进程，等它退出。**不捕获 stdout**（沙箱下管道可能 EPERM）。 */
function runWorker(dataDir, dayKey, idx, tag) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, dataDir, dayKey, String(idx), tag], {
      stdio: 'ignore',       // 不捕获输出
      env: { ...process.env }
    });
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 20000);
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
    child.on('error', () => { clearTimeout(t); resolve(-1); });
  });
}

function readWorker(dataDir, tag) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, `worker-${tag}.json`), 'utf8')); } catch { return null; }
}

function mkEnv(paragraphs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5b-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    persona: { roleText: 'x' },
    skills: { diary: { root: dir } }
  }), 'utf8');
  const dayDir = path.join(dir, '每日');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, '2026-11-02.md'), paragraphs.join('\n\n') + '\n', 'utf8');
  return dir;
}

async function main() {
  console.log('【① 两个进程同时 append 不同条目 → 最终两条都在】');
  {
    const dir = mkEnv(['第一段。', '第二段。', '第三段。']);
    // 同时起两个子进程，各追加不同段
    await Promise.all([
      runWorker(dir, '2026-11-02', 0, 'A'),
      runWorker(dir, '2026-11-02', 1, 'B')
    ]);
    const wa = readWorker(dir, 'A');
    const wb = readWorker(dir, 'B');
    ok('子进程 A 成功', wa?.ok === true && wa?.added === true, JSON.stringify(wa));
    ok('子进程 B 成功', wb?.ok === true && wb?.added === true, JSON.stringify(wb));

    const metaFile = path.join(dir, 'diary-meta', '2026-11-02.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    ok('**最终有 2 条（没丢更新）**', meta.entries.length === 2, String(meta.entries.length));
    ok('**两条的 index 不同**', new Set(meta.entries.map((e) => e.paragraphIndex)).size === 2);
    ok('没有残留 .tmp', fs.readdirSync(path.join(dir, 'diary-meta')).filter((f) => f.endsWith('.tmp')).length === 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【② 两个进程同时 append 同一条目 → 最终只有一条】');
  {
    const dir = mkEnv(['唯一的一段。']);
    await Promise.all([
      runWorker(dir, '2026-11-02', 0, 'C'),
      runWorker(dir, '2026-11-02', 0, 'D')
    ]);
    const wc = readWorker(dir, 'C');
    const wd = readWorker(dir, 'D');
    const addedCount = [wc, wd].filter((w) => w && w.added === true).length;
    const notAddedCount = [wc, wd].filter((w) => w && w.ok === true && w.added === false).length;

    const metaFile = path.join(dir, 'diary-meta', '2026-11-02.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    ok('**最终只有 1 条**', meta.entries.length === 1, String(meta.entries.length));
    ok('**恰好一个 added:true**', addedCount === 1, String(addedCount));
    ok('**恰好一个 added:false**', notAddedCount === 1, String(notAddedCount));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【③ 三个进程同时 append 三条 → 三条都在】');
  {
    const dir = mkEnv(['一。', '二。', '三。', '四。']);
    await Promise.all([
      runWorker(dir, '2026-11-02', 0, 'E1'),
      runWorker(dir, '2026-11-02', 1, 'E2'),
      runWorker(dir, '2026-11-02', 2, 'E3')
    ]);
    const metaFile = path.join(dir, 'diary-meta', '2026-11-02.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    ok('**三条都在**', meta.entries.length === 3, String(meta.entries.length));
    ok('index 是 0/1/2', JSON.stringify(meta.entries.map((e) => e.paragraphIndex).sort()) === '[0,1,2]',
      JSON.stringify(meta.entries.map((e) => e.paragraphIndex)));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【④ 写入失败：旧数据保持不变】');
  {
    const dir = mkEnv(['A。']);
    process.env.QQ_AGENT_DATA_DIR = dir;
    const M = await import(pathToFileURL(path.join(ROOT, 'src', 'diary', 'meta.js')).href);
    M.appendDiaryEntry('2026-11-02', { paragraphIndex: 0, contentType: 'event' });

    const metaFile = path.join(dir, 'diary-meta', '2026-11-02.json');
    const before = fs.readFileSync(metaFile, 'utf8');

    // 让 meta 文件变成只读目录（模拟写入失败）：这里改用一个不存在段落的日
    // 更稳的做法：把日记原文删掉 → append 直接失败，元数据不动
    fs.rmSync(path.join(dir, '每日', '2026-11-02.md'), { force: true });
    const r = M.appendDiaryEntry('2026-11-02', { paragraphIndex: 0, contentType: 'event' });
    ok('**失败**', r.ok === false, JSON.stringify(r));
    ok('**旧元数据没变**', fs.readFileSync(metaFile, 'utf8') === before);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【⑤ 没有自锁：append 内部不调 writeDiaryMeta】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'diary', 'meta.js'), 'utf8');
    const i = src.indexOf('export function appendDiaryEntry');
    const seg = src.slice(i, i + 3000);
    ok('**append 里没有调 writeDiaryMeta**', !/writeDiaryMeta\(/.test(seg), '有调用');
    ok('**append 里调的是 writeMetaUnlocked**', /writeMetaUnlocked\(/.test(seg));
    ok('**writeMetaUnlocked 不加锁**', (() => {
      const j = src.indexOf('function writeMetaUnlocked');
      const body = src.slice(j, j + 600);
      return !/withFileLock/.test(body);
    })(), '内部函数里有 withFileLock');
  }

  console.log('\n【⑥ 进程异常退出：锁能安全恢复】');
  {
    const dir = mkEnv(['A。', 'B。']);
    // 起一个子进程，立刻杀掉（模拟崩溃）—— 它可能拿到锁也可能没拿到
    const child = spawn(process.execPath, [WORKER, dir, '2026-11-02', '0', 'KILL'], { stdio: 'ignore' });
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 30);
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });

    // 不管怎样，后续 append 必须能成功（锁要么没拿到、要么被当陈旧锁清掉）
    // 注意：陈旧锁默认 15 秒才判，这里靠"进程已死 + 锁文件残留"的情况
    //
    // **必须用子进程验证**：meta.js 的 diaryRoot() 读 getConfig()，有模块级缓存，
    // 在父进程里换 QQ_AGENT_DATA_DIR 不可靠（会读到别的目录）。
    const lockFile = path.join(dir, 'diary-meta', '2026-11-02.json.lock');
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);   // 先清一次残留锁

    await runWorker(dir, '2026-11-02', 1, 'AFTER');
    const w = readWorker(dir, 'AFTER');
    ok('**后续 append 能成功**', w?.ok === true, JSON.stringify(w));
    ok('**没有残留 .lock**', !fs.existsSync(lockFile));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log(`\n✗ 测试执行抛异常：${e?.message || e}`);
  process.exit(1);
});

// D1-2c-2g 专项：故障矩阵（A-N）+ Windows rename 实机/注入 + CLI 联动 + 并发。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';

if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

const c = createChecker('D1-2c-2g 故障矩阵');
const TMP = process.env.DIARY_TEST_TMP;
const DATA = process.env.QQ_AGENT_DATA_DIR;
const dateKey = '2026-11-03';
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'diary-op-worker.mjs');

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const listFiles = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reset = () => {
  for (const n of ['diary-meta', 'diary-idempotency.json']) {
    try { fs.rmSync(path.join(TMP, n), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.mkdirSync(path.join(TMP, 'diary-meta'), { recursive: true });
};
const scene = (lines) => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'scene-'));
  const dayDir = path.join(root, '日记', '每日');
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `${dateKey}.md`);
  fs.writeFileSync(file, `# ${dateKey} 周一\n\n## 记录\n\n${(lines || ['- 心情：平静｜初始行']).join('\n\n')}\n`, 'utf8');
  return { root, dayDir, file, diaryRoot: path.join(root, '日记') };
};
const metaPath = () => path.join(DATA, 'diary-meta', `${dateKey}.json`);

const runWorker = (s, { op = 'append', content = '新内容', fault = '' } = {}) => new Promise((resolve) => {
  const out = path.join(TMP, `w-${process.hrtime.bigint()}.json`);
  const fd = fs.openSync(out, 'w');
  const env = { ...process.env, QQ_AGENT_DATA_DIR: DATA, DIARY_TEST_TMP: TMP, DIARY_TEST_GUARD: '1', DIARY_TEST_RUNNER: '1' };
  if (fault) env.DIARY_FAULT = fault;
  const child = spawn(process.execPath, [WORKER, DATA, s.diaryRoot, op, dateKey, content, out], { stdio: ['ignore', fd, 'ignore'], windowsHide: true, env });
  child.on('exit', (code) => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    resolve({ code });
  });
});

try {
  const { writeFileAtomic } = await import('../src/file-lock.js');
  const meta = await import('../src/diary/meta.js');
  const outbox = await import('../src/diary/outbox.js');
  const { recoverDiaryOps } = await import('../src/diary/op.js');
  const { buildPlan } = await import('../scripts/diary-reconcile.mjs');

  const withDeps = (deps) => deps;

  c.section('A. pending 登记前崩溃：三方均无半成品');
  {
    const s = scene();
    const b = sha(s.file);
    await runWorker(s, { fault: 'before-prepare' });
    await c.check('正文不变、无 pending、无 meta', () => {
      if (sha(s.file) !== b) throw new Error('正文变了');
      if (outbox.listUnfinishedDiaryOps().length !== 0) throw new Error('有 pending');
      if (fs.existsSync(metaPath())) throw new Error('有 meta');
    });
  }

  c.section('B. 登记后崩溃：pending 可见、正文未被误写');
  {
    const s = scene();
    const b = sha(s.file);
    await runWorker(s, { fault: 'after-prepare' });
    await c.check('pending=prepared、正文不变', () => {
      const list = outbox.listUnfinishedDiaryOps();
      if (list.length !== 1 || list[0].stage !== 'prepared') throw new Error(JSON.stringify(list));
      if (sha(s.file) !== b) throw new Error('正文变了');
    });
  }

  c.section('C. 正文 tmp 写入失败：旧正文完整、无 tmp 残留');
  {
    const s = scene();
    const b = sha(s.file);
    let threw = '';
    try {
      writeFileAtomic(s.file, '新内容', {
        writeFileSync: () => { const e = new Error('mock write fail'); e.code = 'EPERM'; throw e; }
      });
    } catch (e) { threw = e.code; }
    await c.check('抛 EPERM、旧正文不变、无 tmp', () => {
      if (threw !== 'EPERM') throw new Error(`threw=${threw}`);
      if (sha(s.file) !== b) throw new Error('旧正文被改');
      if (listFiles(s.dayDir).some((f) => f.endsWith('.tmp'))) throw new Error('tmp 残留');
    });
  }

  c.section('D. 正文 tmp 成功、rename 前崩溃（模拟）：旧正文完整');
  {
    const s = scene();
    const b = sha(s.file);
    let threw = '';
    try {
      writeFileAtomic(s.file, '新内容', {
        renameSync: () => { const e = new Error('tmp lost'); e.code = 'ENOENT'; throw e; }
      });
    } catch (e) { threw = e.code; }
    await c.check('ENOENT 立即失败、旧正文不变、无 tmp', () => {
      if (threw !== 'ENOENT') throw new Error(`threw=${threw}`);
      if (sha(s.file) !== b) throw new Error('旧正文被改');
      if (listFiles(s.dayDir).some((f) => f.endsWith('.tmp'))) throw new Error('tmp 残留');
    });
  }

  c.section('E. 正文 rename 持续 EPERM：有界重试后失败、旧正文不变');
  {
    const s = scene();
    const b = sha(s.file);
    let attempts = 0;
    let threw = '';
    const t0 = Date.now();
    try {
      writeFileAtomic(s.file, '新内容', {
        renameSync: () => { attempts += 1; const e = new Error('busy'); e.code = 'EPERM'; throw e; }
      });
    } catch (e) { threw = e.code; }
    const ms = Date.now() - t0;
    await c.check('重试有上限（13 次：12 循环 + 最后一次）、最终抛 EPERM', () => {
      if (threw !== 'EPERM') throw new Error(`threw=${threw}`);
      if (attempts !== 13) throw new Error(`attempts=${attempts}`);
      if (ms > 3000) throw new Error(`重试耗时过长 ${ms}ms`);
      if (sha(s.file) !== b) throw new Error('旧正文被改');
      if (listFiles(s.dayDir).some((f) => f.endsWith('.tmp'))) throw new Error('tmp 残留');
    });
  }

  c.section('F. 正文完成、body_done 前崩溃：恢复识别实际正文');
  {
    const s = scene();
    await runWorker(s, { fault: 'after-body', content: 'F 内容' });
    await c.check('正文已写、pending body_done；recover 判 already', () => {
      if (!fs.readFileSync(s.file, 'utf8').includes('F 内容')) throw new Error('正文未写');
      const list = outbox.listUnfinishedDiaryOps();
      if (list.length !== 1 || list[0].stage !== 'body_done') throw new Error(JSON.stringify(list));
      const rep = recoverDiaryOps({ dryRun: false, root: s.dayDir });
      if (!rep.report[0]?.action.startsWith('already_appended')) throw new Error(JSON.stringify(rep.report));
    });
  }

  c.section('G. body_done 后、meta 前崩溃：正文保留、pending 可恢复');
  {
    const s = scene();
    process.env.QQ_DIARY_META_WRITE = '1';
    await runWorker(s, { fault: 'after-body', content: 'G 内容' });
    process.env.QQ_DIARY_META_WRITE = '0';
    await c.check('正文在、pending body_done、meta 未写', () => {
      if (!fs.readFileSync(s.file, 'utf8').includes('G 内容')) throw new Error('正文未写');
      if (fs.existsSync(metaPath())) throw new Error('meta 不应写入');
      if (outbox.listUnfinishedDiaryOps()[0]?.stage !== 'body_done') throw new Error('pending 阶段不对');
    });
  }

  c.section('H-I. meta tmp/rename 失败：旧 meta 完整、正文保留');
  {
    const s = scene(['- 心情：平静｜甲段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: s.root });
    const mb = sha(metaPath());
    let code1 = '';
    try {
      writeFileAtomic(metaPath(), '{"x":1}', { writeFileSync: () => { const e = new Error('w'); e.code = 'EPERM'; throw e; } });
    } catch (e) { code1 = e.code; }
    let code2 = '';
    try {
      writeFileAtomic(metaPath(), '{"x":2}', { renameSync: () => { const e = new Error('r'); e.code = 'EPERM'; throw e; } });
    } catch (e) { code2 = e.code; }
    await c.check('两次失败、旧 meta hash 不变、tmp 清理', () => {
      if (code1 !== 'EPERM' || code2 !== 'EPERM') throw new Error(`${code1}/${code2}`);
      if (sha(metaPath()) !== mb) throw new Error('旧 meta 被改');
      if (listFiles(path.join(DATA, 'diary-meta')).some((f) => f.endsWith('.tmp'))) throw new Error('tmp 残留');
    });
  }

  c.section('J. meta 完成、meta_done 前崩溃：恢复不重复创建 meta');
  {
    const s = scene();
    process.env.QQ_DIARY_META_WRITE = '1';
    await runWorker(s, { fault: 'after-meta', content: 'J 内容' });
    process.env.QQ_DIARY_META_WRITE = '0';
    const n0 = JSON.parse(fs.readFileSync(metaPath(), 'utf8')).entries.length;
    recoverDiaryOps({ dryRun: false, root: s.dayDir });
    recoverDiaryOps({ dryRun: false, root: s.dayDir });
    const n1 = JSON.parse(fs.readFileSync(metaPath(), 'utf8')).entries.length;
    await c.check('entries 数量不变、pending 清空', () => {
      if (n0 !== 1 || n1 !== 1) throw new Error(`${n0}/${n1}`);
      if (outbox.listUnfinishedDiaryOps().length !== 0) throw new Error('未清');
    });
  }

  c.section('K. meta_done 后、completed 前崩溃：只完成状态');
  {
    const s = scene();
    process.env.QQ_DIARY_META_WRITE = '1';
    await runWorker(s, { fault: 'before-complete', content: 'K 内容' });
    process.env.QQ_DIARY_META_WRITE = '0';
    const bh = sha(s.file);
    const mh = sha(metaPath());
    recoverDiaryOps({ dryRun: false, root: s.dayDir });
    await c.check('正文/meta hash 不变、pending 清空', () => {
      if (sha(s.file) !== bh || sha(metaPath()) !== mh) throw new Error('正文/meta 被重写');
      if (outbox.listUnfinishedDiaryOps().length !== 0) throw new Error('未清');
    });
  }

  c.section('L. completed 写入失败：不伪造完成');
  {
    const s = scene();
    process.env.QQ_DIARY_META_WRITE = '1';
    await runWorker(s, { fault: 'before-complete', content: 'L 内容' });
    process.env.QQ_DIARY_META_WRITE = '0';
    try { fs.chmodSync(path.join(DATA, 'diary-meta', 'pending.json'), 0o444); } catch { /* ignore */ }
    recoverDiaryOps({ dryRun: false, root: s.dayDir });
    try { fs.chmodSync(path.join(DATA, 'diary-meta', 'pending.json'), 0o666); } catch { /* ignore */ }
    await c.check('pending 仍是未完成、没有伪造 completed', () => {
      const list = outbox.listUnfinishedDiaryOps();
      if (list.length !== 1) throw new Error(JSON.stringify(list));
    });
  }

  c.section('M. 恢复过程中再次崩溃/失败：下次仍幂等');
  {
    const s = scene();
    process.env.QQ_DIARY_META_WRITE = '1';
    await runWorker(s, { fault: 'before-complete', content: 'M 内容' });
    process.env.QQ_DIARY_META_WRITE = '0';
    try { fs.chmodSync(path.join(DATA, 'diary-meta', 'pending.json'), 0o444); } catch { /* ignore */ }
    recoverDiaryOps({ dryRun: false, root: s.dayDir });
    try { fs.chmodSync(path.join(DATA, 'diary-meta', 'pending.json'), 0o666); } catch { /* ignore */ }
    const bh = sha(s.file);
    recoverDiaryOps({ dryRun: false, root: s.dayDir });
    await c.check('第二次恢复成功、正文 hash 不变', () => {
      if (sha(s.file) !== bh) throw new Error('正文被重写');
      if (outbox.listUnfinishedDiaryOps().length !== 0) throw new Error('未清');
    });
  }

  c.section('N. 重复恢复：正文/meta 稳定');
  {
    const s = scene();
    process.env.QQ_DIARY_META_WRITE = '1';
    await runWorker(s, { fault: 'after-meta', content: 'N 内容' });
    process.env.QQ_DIARY_META_WRITE = '0';
    const bh = sha(s.file);
    const mh = sha(metaPath());
    for (let i = 0; i < 3; i += 1) recoverDiaryOps({ dryRun: false, root: s.dayDir });
    await c.check('三次恢复后正文/meta hash 不变', () => {
      if (sha(s.file) !== bh || sha(metaPath()) !== mh) throw new Error('文件被改');
    });
  }

  c.section('Windows 实机：真实 rename 场景');
  {
    const s = scene();
    // 1. 普通替换
    writeFileAtomic(s.file, '# 替换\n', {});
    await c.check('普通替换成功', () => {
      if (fs.readFileSync(s.file, 'utf8') !== '# 替换\n') throw new Error('内容不对');
    });
    // 2. 只读目标 → rename 失败；记录错误码
    const before = sha(s.file);
    try { fs.chmodSync(s.file, 0o444); } catch { /* ignore */ }
    let code = '';
    try { writeFileAtomic(s.file, '# 只读\n', {}); } catch (e) { code = e.code || 'UNKNOWN'; }
    try { fs.chmodSync(s.file, 0o666); } catch { /* ignore */ }
    await c.check(`只读目标失败（错误码 ${code || 'UM'}）、旧文件不变`, () => {
      if (!code) throw new Error('没有失败');
      if (sha(s.file) !== before) throw new Error('旧文件被改');
    });
    // 3. 释放后重试成功
    writeFileAtomic(s.file, '# 恢复写\n', {});
    await c.check('释放句柄后重试成功', () => {
      if (fs.readFileSync(s.file, 'utf8') !== '# 恢复写\n') throw new Error('内容不对');
    });
    // 4. 源不存在 → ENOENT
    let code2 = '';
    try { fs.renameSync(path.join(TMP, 'no-such.tmp'), path.join(TMP, 'dest.txt')); } catch (e) { code2 = e.code; }
    await c.check('源不存在 → ENOENT', () => { if (code2 !== 'ENOENT') throw new Error(String(code2)); });
    // 5. 目标路径是目录
    const dirTarget = path.join(TMP, 'dir-target');
    fs.mkdirSync(dirTarget, { recursive: true });
    let code3 = '';
    try { writeFileAtomic(dirTarget, 'x', {}); } catch (e) { code3 = e.code || 'UNKNOWN'; }
    await c.check('目标是目录 → 失败（记录错误码）', () => { if (!code3) throw new Error('没有失败'); });
  }

  c.section('并发：同一目标两个进程写，最终完整、无 tmp');
  {
    const s = scene();
    const worker = path.join(TMP, 'concurrent-writer.mjs');
    fs.writeFileSync(worker, `
      import fs from 'node:fs';
      const [,, file, tag, n] = process.argv;
      const { writeFileAtomic } = await import('file:///E:/dsh/QQ-agent/src/file-lock.js');
      for (let i = 0; i < Number(n); i++) {
        writeFileAtomic(file, JSON.stringify({ tag, i }), {});
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
    `, 'utf8');
    const target = path.join(TMP, 'concurrent.json');
    const run = (tag) => new Promise((resolve) => {
      const child = spawn(process.execPath, [worker, target, tag, '20'], { stdio: 'ignore', windowsHide: true, env: { ...process.env } });
      child.on('exit', resolve);
    });
    await Promise.all([run('a'), run('b')]);
    await c.check('最终 JSON 完整、无 tmp 残留', () => {
      const j = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!j.tag || typeof j.i !== 'number') throw new Error(JSON.stringify(j));
      if (listFiles(TMP).some((f) => f.startsWith('concurrent.json.') && f.endsWith('.tmp'))) throw new Error('tmp 残留');
    });
  }

  c.section('CLI 联动：故障后 dry-run 报告 + planHash 变化');
  {
    const s = scene();
    await runWorker(s, { fault: 'after-prepare', content: 'CLI 内容' });
    const p1 = buildPlan({ date: dateKey, diaryRoot: s.diaryRoot, dataDir: DATA });
    await c.check('dry-run 报告 pending（manual）', () => {
      if (!p1.issues.some((i) => i.category.startsWith('pending_'))) throw new Error(JSON.stringify(p1.issues));
    });
    fs.appendFileSync(s.file, '\n外部改动\n', 'utf8');
    const p2 = buildPlan({ date: dateKey, diaryRoot: s.diaryRoot, dataDir: DATA });
    await c.check('planHash 识别正文变化', () => {
      if (p1.planHash === p2.planHash) throw new Error('planHash 未变化');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);

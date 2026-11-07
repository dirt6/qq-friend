// D1-2b-1 专项：操作日志（幂等、阶段、恢复可见、清理策略、并发）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}


const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'diary-outbox-worker.mjs');
const tmp = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'diary-outbox-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const c = createChecker('D1-2b-1 操作日志');
const O = await import('../src/diary/outbox.js');

const runWorker = ({ op = 'remove', dateKey = '2026-11-03', match = 'A', suicide = false }) => new Promise((resolve) => {
  const out = path.join(tmp, `w-${process.hrtime.bigint()}.json`);
  const fd = fs.openSync(out, 'w');
  const child = spawn(process.execPath, [WORKER, tmp, op, dateKey, match, suicide ? 'suicide' : '', out], {
    stdio: ['ignore', fd, 'ignore'], windowsHide: true
  });
  child.on('exit', () => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch { resolve({ ok: false, error: 'no-output' }); }
  });
});

try {
  c.section('1. 登记与幂等');
  {
    const a = O.prepareDiaryOp({ op: 'remove', dateKey: '2026-11-03', match: 'A', expectedSourceHash: 'sha1:x' });
    const b = O.prepareDiaryOp({ op: 'remove', dateKey: '2026-11-03', match: 'A', expectedSourceHash: 'sha1:x' });
    await c.check('首次登记成功', () => {
      if (!a.ok || a.existing) throw new Error(JSON.stringify(a));
    });
    await c.check('重复登记幂等（同一 id、existing=true）', () => {
      if (!b.ok || !b.existing || b.id !== a.id) throw new Error(JSON.stringify(b));
    });
    const c2 = O.prepareDiaryOp({ op: 'remove', dateKey: '2026-11-03', match: 'B', expectedSourceHash: 'sha1:x' });
    await c.check('不同操作不同 id', () => {
      if (c2.id === a.id) throw new Error('id 冲突');
    });
    await c.check('非法 op/dateKey 不写', () => {
      if (O.prepareDiaryOp({ op: 'x', dateKey: '2026-11-03' }).ok) throw new Error('非法 op 通过');
      if (O.prepareDiaryOp({ op: 'remove', dateKey: 'x' }).ok) throw new Error('非法 dateKey 通过');
    });
  }

  c.section('2. 阶段推进与完成');
  {
    const id = O.prepareDiaryOp({ op: 'append', dateKey: '2026-11-04', match: 'C' }).id;
    O.markDiaryOpStage(id, 'body_done');
    O.markDiaryOpStage(id, 'meta_done');
    const before = O.listUnfinishedDiaryOps().find((x) => x.id === id);
    await c.check('未完成列表包含 meta_done', () => {
      if (!before || before.stage !== 'meta_done') throw new Error(JSON.stringify(before));
    });
    O.completeDiaryOp(id);
    await c.check('完成后不在未完成列表', () => {
      if (O.listUnfinishedDiaryOps().some((x) => x.id === id)) throw new Error('仍列出');
    });
    await c.check('失败记录 attempts/lastError', () => {
      const r = O.failDiaryOp(id, '模拟失败');
      const it = O.listDiaryOps().find((x) => x.id === id);
      if (!r.ok || it.attempts !== 1 || !it.lastError.includes('模拟失败')) throw new Error(JSON.stringify(it));
    });
  }

  c.section('3. 崩溃可见（登记后 SIGKILL）');
  {
    await runWorker({ suicide: true, match: '崩溃项' });
    await c.check('恢复时能发现未完成操作', () => {
      const list = O.listUnfinishedDiaryOps();
      if (!list.some((x) => x.match === '崩溃项' && x.stage === 'prepared')) throw new Error(JSON.stringify(list));
    });
  }

  c.section('4. 并发登记同一操作 → 只有一条');
  {
    const [a, b] = await Promise.all([
      runWorker({ match: '并发项' }),
      runWorker({ match: '并发项' })
    ]);
    await c.check('两个进程登记同一操作幂等', () => {
      const items = O.listDiaryOps().filter((x) => x.match === '并发项');
      if (items.length !== 1) throw new Error(JSON.stringify(items));
      if (!a.ok || !b.ok) throw new Error(JSON.stringify({ a, b }));
    });
  }

  c.section('5. 清理策略：只删 completed，不删未完成');
  {
    const oldId = O.prepareDiaryOp({ op: 'remove', dateKey: '2020-01-01', match: '旧完成' }).id;
    O.completeDiaryOp(oldId);
    // 把 completedAt 改成很旧
    const file = O.outboxFile();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.items[oldId].completedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    const unfinishedBefore = O.listUnfinishedDiaryOps().length;
    const r = O.pruneCompletedDiaryOps({ keepDays: 7, maxCompleted: 200 });
    await c.check('旧 completed 被清理、未完成保留', () => {
      if (!r.ok) throw new Error(JSON.stringify(r));
      if (O.listDiaryOps().some((x) => x.id === oldId)) throw new Error('旧完成未清理');
      if (O.listUnfinishedDiaryOps().length !== unfinishedBefore) throw new Error('未完成被误删');
    });
  }

  c.section('6. 文件结构');
  {
    const raw = JSON.parse(fs.readFileSync(O.outboxFile(), 'utf8'));
    await c.check('version/items 结构正确', () => {
      if (raw.version !== 1 || !raw.items || typeof raw.items !== 'object') throw new Error(JSON.stringify(raw));
    });
    await c.check('不记录正文内容（只有 match 摘要）', () => {
      const s = fs.readFileSync(O.outboxFile(), 'utf8');
      if (s.includes('日记正文') || s.includes('情绪')) throw new Error('疑似写入正文');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);

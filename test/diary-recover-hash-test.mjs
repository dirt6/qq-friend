// D1-2c-1 专项：恢复判定（expectedSourceHash + 操作类型 + 目标态唯一性）。
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
const WORKER = path.join(HERE, 'diary-op-worker.mjs');
const c = createChecker('D1-2c-1 恢复判定');
const dateKey = '2026-11-03';

const setup = (text = '初始行') => {
  const root = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'diary-recover-'));
  const dataDir = process.env.QQ_AGENT_DATA_DIR || path.join(root, 'data');
  try { fs.rmSync(path.join(dataDir, 'diary-meta'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(dataDir, 'diary-idempotency.json'), { force: true }); } catch { /* ignore */ }
  fs.mkdirSync(dataDir, { recursive: true });
  const diaryRoot = path.join(root, '日记');
  fs.mkdirSync(path.join(diaryRoot, '每日'), { recursive: true });
  fs.writeFileSync(path.join(diaryRoot, '每日', `${dateKey}.md`), `# ${dateKey} 周一\n\n## 记录\n\n- 心情：平静｜${text}\n`, 'utf8');
  return { root, dataDir, diaryRoot };
};
const dayDir = (s) => path.join(s.diaryRoot, '每日');
const dayFile = (s) => path.join(dayDir(s), `${dateKey}.md`);

const runWorker = (s, { op = 'append', content = '新内容', fault = '' }) => new Promise((resolve) => {
  const out = path.join(s.root, `out-${process.hrtime.bigint()}.json`);
  const env = { ...process.env, QQ_AGENT_DATA_DIR: s.dataDir, QQ_DIARY_META_WRITE: '0' };
  if (fault) env.DIARY_FAULT = fault;
  const child = spawn(process.execPath, [WORKER, s.dataDir, s.diaryRoot, op, dateKey, content, out], {
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, env
  });
  child.on('exit', (code) => resolve({ code }));
});

const { listUnfinishedDiaryOps, listDiaryOps, outboxFile } = await import('../src/diary/outbox.js');
const { recoverDiaryOps } = await import('../src/diary/op.js');

try {
  c.section('1. 登记后崩溃：hash 未变 → not_executed（不认领）');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'after-prepare' });
    const before = fs.readFileSync(dayFile(s), 'utf8');
    const rep = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('action=not_executed，pending 保留', () => {
      if (rep.report[0]?.action !== 'not_executed') throw new Error(JSON.stringify(rep.report));
      if (listUnfinishedDiaryOps().length !== 1) throw new Error('pending 被清');
      if (fs.readFileSync(dayFile(s), 'utf8') !== before) throw new Error('正文被改');
    });
  }

  c.section('2. 正文后崩溃：hash 变 + 目标唯一 → already_appended');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'after-body', content: '唯一内容' });
    const rep = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('action=already_appended_completed', () => {
      if (rep.report[0]?.action !== 'already_appended_completed') throw new Error(JSON.stringify(rep.report));
      if (listUnfinishedDiaryOps().length !== 0) throw new Error('未清');
    });
    await c.check('不重复追加', () => {
      const n = fs.readFileSync(dayFile(s), 'utf8').split('唯一内容').length - 1;
      if (n !== 1) throw new Error(String(n));
    });
  }

  c.section('3. 外部编辑：hash 变但目标不在 → 人工处理');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'after-prepare', content: '目标内容' });
    fs.appendFileSync(dayFile(s), '\n外部加的一行\n', 'utf8');
    const rep = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('action=content_changed_without_target_needs_manual', () => {
      if (rep.report[0]?.action !== 'content_changed_without_target_needs_manual') throw new Error(JSON.stringify(rep.report));
      if (listUnfinishedDiaryOps().length !== 1) throw new Error('pending 被清');
    });
  }

  c.section('4. remove 登记后崩溃：hash 未变 → not_executed（不误删）');
  {
    const s = setup('要删的行');
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { op: 'remove', content: '要删的行', fault: 'after-prepare' });
    const rep = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('action=not_executed 且行还在', () => {
      if (rep.report[0]?.action !== 'not_executed') throw new Error(JSON.stringify(rep.report));
      if (!fs.readFileSync(dayFile(s), 'utf8').includes('要删的行')) throw new Error('被误删');
    });
  }

  c.section('5. relevel 改完崩溃：hash 变 + 等级已 → already_releveled');
  {
    const s = setup('要改级的行');
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { op: 'relevel', content: '要改级的行', fault: 'after-body' });
    const rep = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('action=already_releveled_completed', () => {
      if (rep.report[0]?.action !== 'already_releveled_completed') throw new Error(JSON.stringify(rep.report));
      if (!fs.readFileSync(dayFile(s), 'utf8').includes('[重要]')) throw new Error('等级没改');
    });
  }

  c.section('6. 重复恢复幂等');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'after-body', content: '幂等内容' });
    const r1 = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    const r2 = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('第一次完成、第二次无可处理项', () => {
      if (r1.report[0]?.action !== 'already_appended_completed') throw new Error(JSON.stringify(r1.report));
      if (r2.total !== 0) throw new Error(String(r2.total));
    });
  }

  c.section('7. 旧记录（无 expectedSourceHash）→ 人工处理');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    fs.mkdirSync(path.join(s.dataDir, 'diary-meta'), { recursive: true });
    fs.writeFileSync(outboxFile(), JSON.stringify({
      version: 1,
      items: {
        legacy1: { id: 'legacy1', op: 'append', dateKey, match: '旧记录', stage: 'body_done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      }
    }), 'utf8');
    const rep = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('action=needs_manual_replay', () => {
      if (rep.report[0]?.action !== 'needs_manual_replay') throw new Error(JSON.stringify(rep.report));
      if (listUnfinishedDiaryOps().length !== 1) throw new Error('被清');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);

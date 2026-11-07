// D1-2c 专项：meta 开启时的故障注入、metaState、积压监控。
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
const c = createChecker('D1-2c meta 故障与监控');
const dateKey = '2026-11-03';

const setup = () => {
  const root = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'diary-meta-fault-'));
  const dataDir = process.env.QQ_AGENT_DATA_DIR || path.join(root, 'data');
  try { fs.rmSync(path.join(dataDir, 'diary-meta'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(dataDir, 'diary-idempotency.json'), { force: true }); } catch { /* ignore */ }
  fs.mkdirSync(dataDir, { recursive: true });
  const diaryRoot = path.join(root, '日记');
  fs.mkdirSync(path.join(diaryRoot, '每日'), { recursive: true });
  fs.writeFileSync(path.join(diaryRoot, '每日', `${dateKey}.md`), `# ${dateKey} 周一\n\n## 记录\n\n- 心情：平静｜初始行\n`, 'utf8');
  return { root, dataDir, diaryRoot };
};
const dayDir = (s) => path.join(s.diaryRoot, '每日');
const dayFile = (s) => path.join(dayDir(s), `${dateKey}.md`);
const metaFile = (s) => path.join(s.dataDir, 'diary-meta', `${dateKey}.json`);

const runWorker = (s, { op = 'append', content = '新内容', fault = '' }) => new Promise((resolve) => {
  const out = path.join(s.root, `out-${process.hrtime.bigint()}.json`);
  const env = { ...process.env, QQ_AGENT_DATA_DIR: s.dataDir, QQ_DIARY_META_WRITE: '1' };
  if (fault) env.DIARY_FAULT = fault;
  const child = spawn(process.execPath, [WORKER, s.dataDir, s.diaryRoot, op, dateKey, content, out], {
    stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, env
  });
  child.on('exit', (code) => {
    let result = null;
    try { result = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* ignore */ }
    resolve({ code, result });
  });
});

const { listUnfinishedDiaryOps, outboxStats, listDiaryOps } = await import('../src/diary/outbox.js');
const { recoverDiaryOps } = await import('../src/diary/op.js');

try {
  c.section('1. meta 开启 + after-meta 崩溃：恢复识别已完成、不重复');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'after-meta' });
    await c.check('正文含新内容', () => { if (!fs.readFileSync(dayFile(s), 'utf8').includes('新内容')) throw new Error('正文缺'); });
    await c.check('meta 已写入且含 1 条 entry', () => {
      const m = JSON.parse(fs.readFileSync(metaFile(s), 'utf8'));
      if (!Array.isArray(m.entries) || m.entries.length !== 1) throw new Error(JSON.stringify(m));
    });
    await c.check('pending=meta_done', () => {
      const list = listUnfinishedDiaryOps();
      if (list.length !== 1 || list[0].stage !== 'meta_done') throw new Error(JSON.stringify(list));
    });
    const rep = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('恢复完成且 meta 不重复', () => {
      if (listUnfinishedDiaryOps().length !== 0) throw new Error('未清');
      const m = JSON.parse(fs.readFileSync(metaFile(s), 'utf8'));
      if (m.entries.length !== 1) throw new Error(`entries=${m.entries.length}`);
      if (!rep.report[0]?.action.startsWith('already_appended')) throw new Error(JSON.stringify(rep.report));
    });
  }

  c.section('2. meta 开启 + before-complete 崩溃：恢复完成');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'before-complete' });
    const rep = recoverDiaryOps({ dryRun: false, root: dayDir(s) });
    await c.check('恢复完成、pending 清空、meta 一条', () => {
      if (listUnfinishedDiaryOps().length !== 0) throw new Error('未清');
      const m = JSON.parse(fs.readFileSync(metaFile(s), 'utf8'));
      if (m.entries.length !== 1) throw new Error(`entries=${m.entries.length}`);
      if (!rep.report[0]?.action.startsWith('already_appended')) throw new Error(JSON.stringify(rep.report));
    });
  }

  c.section('3. metaState 记录真实状态');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    process.env.QQ_DIARY_META_WRITE = '1';
    const { write } = await import('../src/diary/writer.js');
    write({ content: '同步成功条目', day: dateKey, root: dayDir(s), source: 'test' });
    const done = listDiaryOps().find((x) => x.stage === 'completed' && x.op === 'append');
    await c.check('完成记录带 metaState=synced', () => {
      if (done?.metaState !== 'synced') throw new Error(JSON.stringify(done));
    });
  }

  c.section('4. meta 关闭时 metaState=skipped_disabled');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    process.env.QQ_DIARY_META_WRITE = '0';
    const { write } = await import('../src/diary/writer.js');
    write({ content: '未启用条目', day: dateKey, root: dayDir(s), source: 'test' });
    const done = listDiaryOps().find((x) => x.stage === 'completed' && x.match?.includes('未启用条目') === false);
    const any = listDiaryOps().filter((x) => x.stage === 'completed' && x.op === 'append');
    await c.check('完成记录带 skipped_disabled（不是 synced）', () => {
      if (!any.some((x) => x.metaState === 'skipped_disabled')) throw new Error(JSON.stringify(any));
    });
  }

  c.section('5. 积压监控 stats');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'after-prepare' });
    const st = outboxStats();
    await c.check('未完成=1、年龄≥0、阶段分布', () => {
      if (st.unfinished !== 1) throw new Error(JSON.stringify(st));
      if (st.oldestAgeMs < 0) throw new Error('年龄异常');
      if (!st.stages.prepared) throw new Error(JSON.stringify(st.stages));
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);

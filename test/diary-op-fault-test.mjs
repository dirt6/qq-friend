// D1-2b-2 专项：故障注入（SIGKILL）+ 恢复。
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
const c = createChecker('D1-2b-2 故障注入与恢复');
const dateKey = '2026-11-03';

const setup = (text = '初始行') => {
  const root = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'diary-fault-'));
  const dataDir = process.env.QQ_AGENT_DATA_DIR || path.join(root, 'data');
  try { fs.rmSync(path.join(dataDir, 'diary-meta'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(dataDir, 'diary-idempotency.json'), { force: true }); } catch { /* ignore */ }
  fs.mkdirSync(path.join(dataDir), { recursive: true });
  const diaryRoot = path.join(root, '日记');
  fs.mkdirSync(path.join(diaryRoot, '每日'), { recursive: true });
  fs.writeFileSync(path.join(diaryRoot, '每日', `${dateKey}.md`), `# ${dateKey} 周一\n\n## 记录\n\n- 心情：平静｜${text}\n`, 'utf8');
  return { root, dataDir, diaryRoot };
};
const dayFile = (s) => path.join(s.diaryRoot, '每日', `${dateKey}.md`);
const body = (s) => fs.readFileSync(dayFile(s), 'utf8');

const runWorker = (s, { op = 'append', content = '新内容', fault = '' }) => new Promise((resolve) => {
  const out = path.join(s.root, `out-${process.hrtime.bigint()}.json`);
  const env = { ...process.env, QQ_AGENT_DATA_DIR: s.dataDir, QQ_DIARY_META_WRITE: '0' };
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

const { listUnfinishedDiaryOps, outboxFile } = await import('../src/diary/outbox.js');
const { recoverDiaryOps } = await import('../src/diary/op.js');

try {
  c.section('① 登记前被强杀：正文不变、无 pending');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    const before = body(s);
    const { code } = await runWorker(s, { fault: 'before-prepare' });
    await c.check('进程被强杀', () => { if (code === 0) throw new Error('没被杀'); });
    await c.check('正文不变', () => { if (body(s) !== before) throw new Error('正文被改'); });
    await c.check('没有 pending', () => {
      if (listUnfinishedDiaryOps().length !== 0) throw new Error(String(listUnfinishedDiaryOps().length));
    });
  }

  c.section('② 登记后被强杀：pending 可见、正文不变');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    const before = body(s);
    await runWorker(s, { fault: 'after-prepare' });
    await c.check('正文不变', () => { if (body(s) !== before) throw new Error('正文被改'); });
    await c.check('pending=prepared', () => {
      const list = listUnfinishedDiaryOps();
      if (list.length !== 1 || list[0].stage !== 'prepared') throw new Error(JSON.stringify(list));
    });
    const rep = recoverDiaryOps({ dryRun: true, root: path.join(s.diaryRoot, '每日') });
    await c.check('恢复 dry-run 判未执行（not_executed）', () => {
      if (!rep.report.some((x) => x.action === 'not_executed')) {
        throw new Error(JSON.stringify(rep.report));
      }
    });
  }

  c.section('③ 正文写入前被强杀：pending 仍在、正文不变、meta 未动');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    const before = body(s);
    await runWorker(s, { fault: 'before-body' });
    await c.check('正文不变', () => { if (body(s) !== before) throw new Error('正文被改'); });
    await c.check('pending 仍在', () => {
      if (listUnfinishedDiaryOps().length !== 1) throw new Error('pending 丢了');
    });
    await c.check('meta 文件未生成（开关关闭）', () => {
      const meta = path.join(s.dataDir, 'diary-meta', `${dateKey}.json`);
      if (fs.existsSync(meta)) throw new Error('meta 被写了');
    });
  }

  c.section('④ 正文写入后被强杀：恢复识别已完成');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'after-body' });
    await c.check('正文含新内容', () => {
      if (!body(s).includes('新内容')) throw new Error(body(s));
    });
    await c.check('pending=body_done', () => {
      const list = listUnfinishedDiaryOps();
      if (list.length !== 1 || list[0].stage !== 'body_done') throw new Error(JSON.stringify(list));
    });
    const rep = recoverDiaryOps({ dryRun: false, root: path.join(s.diaryRoot, '每日') });
    await c.check('恢复判 already_appended 并完成', () => {
      const r = rep.report[0];
      if (!r || !r.action.startsWith('already_appended')) throw new Error(JSON.stringify(rep.report));
      if (listUnfinishedDiaryOps().length !== 0) throw new Error('未完成未清');
    });
    await c.check('正文没有重复追加', () => {
      const n = body(s).split('新内容').length - 1;
      if (n !== 1) throw new Error(`出现 ${n} 次`);
    });
  }

  c.section('⑤ 标记完成前被强杀：恢复完成');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { fault: 'before-complete' });
    await c.check('正文已写', () => { if (!body(s).includes('新内容')) throw new Error(body(s)); });
    const rep = recoverDiaryOps({ dryRun: false, root: path.join(s.diaryRoot, '每日') });
    await c.check('恢复完成、pending 清空', () => {
      if (!rep.report[0]?.action.startsWith('already_appended')) throw new Error(JSON.stringify(rep.report));
      if (listUnfinishedDiaryOps().length !== 0) throw new Error('未清');
    });
  }

  c.section('⑥ pending 不可写：不修改正文');
  {
    const s = setup();
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    const before = body(s);
    fs.mkdirSync(path.join(s.dataDir, 'diary-meta'), { recursive: true });
    fs.writeFileSync(outboxFile(), JSON.stringify({ version: 1, items: {} }), 'utf8');
    try { fs.chmodSync(outboxFile(), 0o444); } catch { /* ignore */ }
    const { result } = await runWorker(s, { op: 'append', content: '不该写入' });
    try { fs.chmodSync(outboxFile(), 0o666); } catch { /* ignore */ }
    await c.check('返回失败且正文不变', () => {
      if (!result || result.ok !== false) throw new Error(JSON.stringify(result));
      if (body(s) !== before) throw new Error('正文被改');
    });
  }

  c.section('⑦ remove 的登记后被强杀：恢复不误删');
  {
    const s = setup('要删的行');
    process.env.QQ_AGENT_DATA_DIR = s.dataDir;
    await runWorker(s, { op: 'remove', content: '要删的行', fault: 'after-prepare' });
    await c.check('正文未删', () => { if (!body(s).includes('要删的行')) throw new Error(body(s)); });
    await c.check('pending=prepared', () => {
      const list = listUnfinishedDiaryOps();
      if (list.length !== 1 || list[0].op !== 'remove') throw new Error(JSON.stringify(list));
    });
    const rep = recoverDiaryOps({ dryRun: false, root: path.join(s.diaryRoot, '每日') });
    await c.check('恢复不盲目重放删除（not_executed）', () => {
      const r = rep.report[0];
      if (!r || r.action !== 'not_executed') throw new Error(JSON.stringify(rep.report));
      if (!body(s).includes('要删的行')) throw new Error('被误删了');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);

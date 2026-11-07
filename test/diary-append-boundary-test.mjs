// D1-2c-2d 专项：追加同步边界（相同文本、幂等、空/标题/多段、混合分段、恢复 hash）。
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

const c = createChecker('D1-2c-2d 追加边界');
const TMP = process.env.DIARY_TEST_TMP;
const dateKey = '2026-11-03';
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'diary-op-worker.mjs');
process.env.QQ_DIARY_META_WRITE = '1';

const reset = () => {
  for (const n of ['diary-meta', 'diary-idempotency.json']) {
    try { fs.rmSync(path.join(TMP, n), { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
const setup = (lines, opts = {}) => {
  reset();
  const root = fs.mkdtempSync(path.join(TMP, 'scene-'));
  const dayDir = path.join(root, '日记', '每日');
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `${dateKey}.md`);
  if (lines !== null) fs.writeFileSync(file, lines, 'utf8');
  return { root, dayDir, file };
};
const metaFile = () => path.join(TMP, 'diary-meta', `${dateKey}.json`);
const entries = () => {
  try { return JSON.parse(fs.readFileSync(metaFile(), 'utf8')).entries || []; } catch { return []; }
};

const runWorker = (dir, { op = 'append', content = '新内容', fault = '' } = {}) => new Promise((resolve) => {
  const out = path.join(TMP, `w-${process.hrtime.bigint()}.json`);
  const fd = fs.openSync(out, 'w');
  const env = { ...process.env, QQ_AGENT_DATA_DIR: process.env.QQ_AGENT_DATA_DIR, DIARY_TEST_TMP: TMP, DIARY_TEST_GUARD: '1', DIARY_TEST_RUNNER: '1' };
  if (fault) env.DIARY_FAULT = fault;
  const child = spawn(process.execPath, [WORKER, process.env.QQ_AGENT_DATA_DIR, path.dirname(dir), op, dateKey, content, out], {
    stdio: ['ignore', fd, 'ignore'], windowsHide: true, env
  });
  child.on('exit', (code) => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    let result = null;
    try { result = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* ignore */ }
    resolve({ code, result });
  });
});

try {
  const { write } = await import('../src/diary/writer.js');
  const meta = await import('../src/diary/meta.js');
  const { listDiaryOps, listUnfinishedDiaryOps } = await import('../src/diary/outbox.js');
  const { recoverDiaryOps } = await import('../src/diary/op.js');

  c.section('1. 相同文本同一天出现多次：身份不串段');
  {
    // 短文本（<8 字）按既有规则不去重 → 会新增一条；此时 identity 不唯一，
    // 必须拒绝写 meta、保留 pending，而不是把身份算到别的段上。
    const s = setup(`# ${dateKey} 周一\n\n## 记录\n\n- 心情：平静｜重复句\n\n- 心情：平静｜重复句\n`);
    const r = write({ content: '重复句', day: dateKey, root: s.dayDir, source: 'test' });
    await c.check('短文本：hits 不唯一 → 不写 meta、pending 保留', () => {
      if (!r.pendingSync) throw new Error(JSON.stringify(r));
      if (!String(r.metaError || '').includes('不唯一')) throw new Error(JSON.stringify(r));
      if (entries().length !== 0) throw new Error(JSON.stringify(entries()));
      if (listUnfinishedDiaryOps().length !== 1) throw new Error('pending 未保留');
    });

    // 长文本（≥8 字）走既有去重：合并到已有行，不新增段落、不写 meta。
    const s2 = setup(`# ${dateKey} 周一\n\n## 记录\n\n- 心情：平静｜重复内容超过八个字\n\n- 心情：平静｜重复内容超过八个字\n`);
    const r2 = write({ content: '重复内容超过八个字', day: dateKey, root: s2.dayDir, source: 'test' });
    await c.check('长文本：merged、不新增正文/meta', () => {
      if (!r2.merged) throw new Error(JSON.stringify(r2));
      if (entries().length !== 0) throw new Error(JSON.stringify(entries()));
      const n = fs.readFileSync(s2.file, 'utf8').split('重复内容超过八个字').length - 1;
      if (n !== 2) throw new Error(String(n));
    });
  }

  c.section('2. 同一段文本重复追加：operationId 幂等');
  {
    const s = setup(null);
    const r1 = write({ content: '唯一内容甲', day: dateKey, root: s.dayDir, source: 'test' });
    const r2 = write({ content: '唯一内容甲', day: dateKey, root: s.dayDir, source: 'test' });
    await c.check('第二次被幂等跳过', () => {
      if (!r1.ok || r1.pendingSync) throw new Error(JSON.stringify(r1));
      if (!r2.skipped) throw new Error(JSON.stringify(r2));
    });
    await c.check('meta 只有一条、pending 完成记录一条', () => {
      if (entries().length !== 1) throw new Error(String(entries().length));
      const done = listDiaryOps().filter((x) => x.op === 'append' && x.stage === 'completed');
      if (done.length !== 1) throw new Error(String(done.length));
    });
  }

  c.section('3. 空日记 / 只有标题 / 多段');
  {
    const s1 = setup(null);
    write({ content: '空日记内容', day: dateKey, root: s1.dayDir, source: 'test' });
    await c.check('空日记：meta index=0 且与段落一致', () => {
      const paras = meta.splitParagraphs(fs.readFileSync(s1.file, 'utf8'));
      if (entries()[0]?.paragraphIndex !== 0 || entries()[0]?.quoteHash !== paras[0].hash) throw new Error(JSON.stringify(entries()));
    });

    const s2 = setup(`# ${dateKey} 周一\n\n## 记录\n\n`);
    write({ content: '只有标题的内容', day: dateKey, root: s2.dayDir, source: 'test' });
    await c.check('只有标题：仍能定位正文段落', () => {
      const e = entries()[0];
      const paras = meta.splitParagraphs(fs.readFileSync(s2.file, 'utf8'));
      if (!e || e.quoteHash !== paras[e.paragraphIndex].hash) throw new Error(JSON.stringify(e));
    });

    const s3 = setup(`# ${dateKey} 周一\n\n## 记录\n\n- 心情：平静｜甲\n\n- 心情：平静｜乙\n`);
    write({ content: '多段新内容', day: dateKey, root: s3.dayDir, source: 'test' });
    await c.check('多段：identity 指向包含新内容的段落', () => {
      const e = entries()[0];
      const paras = meta.splitParagraphs(fs.readFileSync(s3.file, 'utf8'));
      if (!paras[e.paragraphIndex].text.includes('多段新内容')) throw new Error(JSON.stringify(e));
    });
  }

  c.section('4-5. 标题/分隔线/空行混合：分段规则与 meta 索引一致');
  {
    const s = setup(`# T\n\n## 记录\n\n- 心情：平静｜A\n\n---\n\n- 心情：平静｜B\n\n- 心情：平静｜C\n`);
    write({ content: '混合新内容', day: dateKey, root: s.dayDir, source: 'test' });
    await c.check('splitParagraphs 跳过标题/分隔线，index 与 meta 一致', () => {
      const paras = meta.splitParagraphs(fs.readFileSync(s.file, 'utf8'));
      if (paras.some((p) => p.text.startsWith('#') || p.text.trim() === '---')) throw new Error('分段里混入标题/分隔线');
      const e = entries()[0];
      if (!paras[e.paragraphIndex].text.includes('混合新内容')) throw new Error(JSON.stringify(e));
      if (e.quoteHash !== paras[e.paragraphIndex].hash) throw new Error('quoteHash 不一致');
    });
  }

  c.section('6. 恢复时正文已变化、hash 不匹配 → 人工处理');
  {
    const s = setup(null);
    await runWorker(s.dayDir, { content: '恢复目标', fault: 'after-prepare' });
    fs.appendFileSync(s.file, '\n外部改的一行\n', 'utf8');
    const rep = recoverDiaryOps({ dryRun: false, root: s.dayDir });
    await c.check('content_changed_without_target_needs_manual', () => {
      if (rep.report[0]?.action !== 'content_changed_without_target_needs_manual') throw new Error(JSON.stringify(rep.report));
      if (listUnfinishedDiaryOps().length !== 1) throw new Error('pending 被清');
    });
  }

  c.section('7. 重复恢复：不重复写入 meta');
  {
    const s = setup(null);
    await runWorker(s.dayDir, { content: '恢复完成内容', fault: 'after-meta' });
    const before = entries().length;
    recoverDiaryOps({ dryRun: false, root: s.dayDir });
    recoverDiaryOps({ dryRun: false, root: s.dayDir });
    await c.check('meta 条数不变、pending 清空', () => {
      if (entries().length !== before) throw new Error(`${before} -> ${entries().length}`);
      if (listUnfinishedDiaryOps().length !== 0) throw new Error('未清');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);

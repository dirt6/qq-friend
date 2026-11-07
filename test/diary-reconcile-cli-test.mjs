// D1-2c-2f 专项：日记对账 CLI。
import fs from 'node:fs';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

const c = createChecker('D1-2c-2f 对账 CLI');
const TMP = process.env.DIARY_TEST_TMP;
const DATA = process.env.QQ_AGENT_DATA_DIR;
const dateKey = '2026-11-03';
process.env.QQ_DIARY_META_WRITE = '1';

const CLI = await import('../scripts/diary-reconcile.mjs');
const meta = await import('../src/diary/meta.js');
const outbox = await import('../src/diary/outbox.js');
const writer = await import('../src/diary/writer.js');

const reset = () => {
  for (const n of ['diary-meta', 'diary-idempotency.json']) {
    try { fs.rmSync(path.join(TMP, n), { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
const scene = (lines) => {
  reset();
  fs.mkdirSync(path.join(TMP, 'diary-meta'), { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP, 'scene-'));
  const dayDir = path.join(root, '日记', '每日');
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `${dateKey}.md`);
  if (lines !== null) fs.writeFileSync(file, `# ${dateKey} 周一\n\n## 记录\n\n${lines.join('\n\n')}\n`, 'utf8');
  return { root, dayDir, file };
};
const planFor = (root, date = '') => CLI.buildPlan({ date, diaryRoot: root, dataDir: DATA });
const metaPath = () => path.join(TMP, 'diary-meta', `${dateKey}.json`);
const snapshot = () => {
  const out = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { out.push(p + ':' + fs.statSync(p).size + ':' + fs.readFileSync(p, 'utf8').length); } catch { /* ignore */ } }
    }
  };
  walk(TMP);
  return out.sort().join('|');
};

try {
  c.section('1. 空数据目录');
  {
    const s = scene(null);
    const p = planFor(path.dirname(s.dayDir));
    await c.check('0 日期、0 问题、planHash 64 位', () => {
      if (p.dates.length !== 0 || p.issues.length !== 0) throw new Error(JSON.stringify(p));
      if (!/^(sha256:)?[0-9a-f]{64}$/.test(p.planHash)) throw new Error('planHash 格式');
    });
  }

  c.section('2. 正常正文与 meta');
  {
    const s = scene(['- 心情：平静｜甲段', '- 心情：平静｜乙段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 1, root: path.dirname(s.dayDir) });
    const p = planFor(path.dirname(s.dayDir));
    await c.check('0 问题', () => {
      if (p.issues.length !== 0) throw new Error(JSON.stringify(p.issues));
    });
  }

  c.section('3. pending 各阶段');
  {
    const s = scene(['- 心情：平静｜甲段']);
    for (const [stage, m] of [['prepared', '未执行甲'], ['body_done', '未执行乙'], ['meta_done', '未执行丙']]) {
      const r = outbox.prepareDiaryOp({ op: 'append', dateKey, match: m, expectedSourceHash: 'sha256:x' });
      if (stage !== 'prepared') outbox.markDiaryOpStage(r.id, stage);
    }
    const p = planFor(path.dirname(s.dayDir));
    await c.check('报告 pending 未完成/未执行（manual）', () => {
      const pend = p.issues.filter((i) => i.category.startsWith('pending_'));
      if (pend.length !== 3) throw new Error(JSON.stringify(p.issues));
      if (!pend.every((i) => i.manual)) throw new Error('不应自动修复');
    });
  }

  c.section('4. 短文本重复导致身份不唯一');
  {
    const s = scene(['- 心情：平静｜重复句', '- 心情：平静｜重复句']);
    const r = writer.write({ content: '重复句', day: dateKey, root: s.dayDir, source: 'test' });
    const p = planFor(path.dirname(s.dayDir));
    await c.check('pending 保留且被报为 manual', () => {
      if (!r.pendingSync) throw new Error(JSON.stringify(r));
      if (outbox.listUnfinishedDiaryOps().length !== 1) throw new Error('pending 未保留');
      if (!p.issues.some((i) => i.category.startsWith('pending_') && i.manual)) throw new Error(JSON.stringify(p.issues));
    });
  }

  c.section('5. 同内容多段 + 手工 pending');
  {
    const s = scene(['- 心情：平静｜同段内容甲乙', '- 心情：平静｜同段内容甲乙']);
    outbox.prepareDiaryOp({ op: 'relevel', dateKey, match: '同段内容甲乙', importance: '重要', expectedSourceHash: 'sha256:x' });
    const p = planFor(path.dirname(s.dayDir));
    await c.check('报告 pending 且不自动修复', () => {
      if (!p.issues.some((i) => i.category.startsWith('pending_') && i.manual)) throw new Error(JSON.stringify(p.issues));
      if (p.actions.some((a) => a.kind === 'complete_pending')) throw new Error('不应自动完成');
    });
  }

  c.section('6. 删除首段后的 stale 索引');
  {
    const s = scene(['- 心情：平静｜甲段', '- 心情：平静｜乙段', '- 心情：平静｜丙段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 1, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 2, root: path.dirname(s.dayDir) });
    writer.removeLine({ match: '甲段', day: dateKey, root: s.dayDir });
    const p = planFor(path.dirname(s.dayDir));
    await c.check('报告 meta_stale_index_shift（manual）', () => {
      if (!p.issues.some((i) => i.category === 'meta_stale_index_shift' && i.manual)) throw new Error(JSON.stringify(p.issues));
      if (p.actions.length !== 0) throw new Error('不应自动修复');
    });
  }

  c.section('7. 改级后的 quoteHash');
  {
    const s = scene(['- 心情：平静｜目标段', '- 心情：平静｜其他段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 1, root: path.dirname(s.dayDir) });
    writer.relevelLine({ match: '目标段', importance: '重要', day: dateKey, root: s.dayDir });
    const p = planFor(path.dirname(s.dayDir));
    await c.check('改级同步后 0 问题', () => {
      if (p.issues.length !== 0) throw new Error(JSON.stringify(p.issues));
    });
  }

  c.section('8-9. 正文外部编辑 / sourceHash 不匹配');
  {
    const s = scene(['- 心情：平静｜甲段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    fs.appendFileSync(s.file, '\n外部编辑\n', 'utf8');
    const p = planFor(path.dirname(s.dayDir));
    await c.check('报告 meta_mismatch 或 source_hash_mismatch（manual）', () => {
      if (!p.issues.some((i) => ['meta_mismatch', 'source_hash_mismatch'].includes(i.category) && i.manual)) {
        throw new Error(JSON.stringify(p.issues));
      }
    });
  }

  c.section('10. 旧格式 meta');
  {
    const s = scene(['- 心情：平静｜甲段']);
    fs.mkdirSync(path.join(TMP, 'diary-meta'), { recursive: true });
    fs.writeFileSync(metaPath(), JSON.stringify({ version: 0, legacy: true }), 'utf8');
    const p = planFor(path.dirname(s.dayDir));
    await c.check('报告 legacy_format', () => {
      if (!p.issues.some((i) => i.category === 'legacy_format')) throw new Error(JSON.stringify(p.issues));
    });
  }

  c.section('11. 孤立 meta');
  {
    const s = scene(['- 心情：平静｜甲段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    // 手工把 entry index 改成越界
    const m = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    m.entries[0].paragraphIndex = 9;
    fs.writeFileSync(metaPath(), JSON.stringify(m), 'utf8');
    const p = planFor(path.dirname(s.dayDir));
    await c.check('报告 orphan_meta', () => {
      if (!p.issues.some((i) => i.category === 'orphan_meta')) throw new Error(JSON.stringify(p.issues));
    });
  }

  c.section('12. 重复 pending');
  {
    const s = scene(['- 心情：平静｜甲段']);
    outbox.prepareDiaryOp({ op: 'append', dateKey, match: '手工甲', expectedSourceHash: 'sha256:x' });
    outbox.prepareDiaryOp({ op: 'append', dateKey, match: '手工乙', expectedSourceHash: 'sha256:x' });
    const p = planFor(path.dirname(s.dayDir));
    await c.check('两条 pending 都被报告', () => {
      const pend = p.issues.filter((i) => i.category.startsWith('pending_'));
      if (pend.length !== 2) throw new Error(JSON.stringify(p.issues));
    });
  }

  c.section('13-14. dry-run 只读：输入 hash 与目录快照不变');
  {
    const s = scene(['- 心情：平静｜甲段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    const before = snapshot();
    const p1 = planFor(path.dirname(s.dayDir));
    const p2 = planFor(path.dirname(s.dayDir));
    const after = snapshot();
    await c.check('两次 planHash 相同、目录快照一致', () => {
      if (p1.planHash !== p2.planHash) throw new Error('planHash 不稳定');
      if (before !== after) throw new Error('dry-run 产生了副作用');
      if (after.includes('.lock') || after.includes('.tmp')) throw new Error('产生了锁/tmp 文件');
    });
  }

  c.section('15. planHash 有效时执行 clear_stale');
  {
    const s = scene(['- 心情：平静｜甲段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    const m = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    m.entries[0].stale = true;
    m.entries[0].staleReason = 'test';
    fs.writeFileSync(metaPath(), JSON.stringify(m), 'utf8');
    const p = planFor(path.dirname(s.dayDir));
    await c.check('计划包含 clear_stale', () => {
      if (!p.actions.some((a) => a.kind === 'clear_stale')) throw new Error(JSON.stringify(p.actions));
    });
    const r = CLI.executePlan({ plan: p, dataDir: DATA });
    await c.check('执行后 stale 清除', () => {
      if (!r.ok || r.executed.length !== 1) throw new Error(JSON.stringify(r));
      const after = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
      if (after.entries[0].stale !== false) throw new Error('stale 未清除');
    });
  }

  c.section('16-17. planHash 过期 / 输入变化 → 拒绝');
  {
    const s = scene(['- 心情：平静｜甲段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    const p = planFor(path.dirname(s.dayDir));
    fs.appendFileSync(s.file, '\n外部改动\n', 'utf8');
    const r = CLI.executePlan({ plan: p, dataDir: DATA });
    await c.check('PLAN_STALE，不执行', () => {
      if (r.ok !== false || r.code !== 'PLAN_STALE') throw new Error(JSON.stringify(r));
    });
  }

  c.section('18. 执行失败/无需修复时保留 pending');
  {
    const s = scene(['- 心情：平静｜甲段']);
    outbox.prepareDiaryOp({ op: 'append', dateKey, match: '不会自动执行的项', expectedSourceHash: 'sha256:x' });
    const p = planFor(path.dirname(s.dayDir));
    const r = CLI.executePlan({ plan: p, dataDir: DATA });
    await c.check('not_executed 的 pending 不被清理', () => {
      if (!r.ok) throw new Error(JSON.stringify(r));
      if (outbox.listUnfinishedDiaryOps().length !== 1) throw new Error('pending 被误清');
    });
  }

  c.section('19. 两个执行并发：不重复修复');
  {
    const s = scene(['- 心情：平静｜甲段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    const m = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    m.entries[0].stale = true; m.entries[0].staleReason = 'test';
    fs.writeFileSync(metaPath(), JSON.stringify(m), 'utf8');
    const p = planFor(path.dirname(s.dayDir));
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => CLI.executePlan({ plan: p, dataDir: DATA })),
      Promise.resolve().then(() => CLI.executePlan({ plan: p, dataDir: DATA }))
    ]);
    await c.check('一个执行、另一个跳过，不重复', () => {
      const okCount = [a, b].filter((x) => x.ok && x.executed.length > 0).length;
      if (okCount !== 1) throw new Error(JSON.stringify({ a, b }));
    });
  }

  c.section('20. 参数校验');
  {
    for (const [argv, label] of [
      [['--unknown'], '未知参数'],
      [['--json', '--json'], '重复参数'],
      [['--date'], '缺少值'],
      [['--date', '2026-13-40'], '非法日期'],
      [['--confirm'], '缺 planHash'],
      [['--confirm', 'abc'], 'planHash 格式'],
      [['positional'], '位置参数']
    ]) {
      await c.check(`${label} → 拒绝`, () => {
        const r = CLI.parseReconcileArgs(argv);
        if (!r.error) throw new Error(JSON.stringify(r));
      });
    }
    await c.check('合法参数通过', () => {
      const r = CLI.parseReconcileArgs(['--date', '2026-11-03', '--json']);
      if (r.error || r.date !== '2026-11-03' || !r.json) throw new Error(JSON.stringify(r));
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);

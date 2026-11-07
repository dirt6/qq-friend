// D1-2c-2e 专项：改级 / 删除的 meta 同步（重算 quoteHash、stale 范围、人工处理）。
import fs from 'node:fs';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

const c = createChecker('D1-2c-2e 改删同步');
const TMP = process.env.DIARY_TEST_TMP;
const dateKey = '2026-11-03';
process.env.QQ_DIARY_META_WRITE = '1';

const reset = () => {
  for (const n of ['diary-meta', 'diary-idempotency.json']) {
    try { fs.rmSync(path.join(TMP, n), { recursive: true, force: true }); } catch { /* ignore */ }
  }
};
const setup = (lines) => {
  reset();
  fs.mkdirSync(path.join(TMP, 'diary-meta'), { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP, 'scene-'));
  const dayDir = path.join(root, '日记', '每日');
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `${dateKey}.md`);
  fs.writeFileSync(file, `# ${dateKey} 周一\n\n## 记录\n\n${lines.join('\n\n')}\n`, 'utf8');
  return { root, dayDir, file };
};
const metaPath = () => path.join(TMP, 'diary-meta', `${dateKey}.json`);
const entries = () => {
  try { return JSON.parse(fs.readFileSync(metaPath(), 'utf8')).entries || []; } catch { return []; }
};

try {
  const { removeLine, relevelLine } = await import('../src/diary/writer.js');
  const meta = await import('../src/diary/meta.js');
  const { listUnfinishedDiaryOps } = await import('../src/diary/outbox.js');

  c.section('1. 改级：重算 quoteHash，paragraphIndex 不变');
  {
    const s = setup(['- 心情：平静｜目标段', '- 心情：平静｜其他段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 1, root: path.dirname(s.dayDir) });
    const r = relevelLine({ match: '目标段', importance: '非常重要', day: dateKey, root: s.dayDir });
    await c.check('改级成功且 pendingSync=false', () => { if (!r.ok || r.pendingSync) throw new Error(JSON.stringify(r)); });
    await c.check('entry0 的 quoteHash 指向新正文段落、entry1 不受影响', () => {
      const paras = meta.splitParagraphs(fs.readFileSync(s.file, 'utf8'));
      const list = entries();
      const e0 = list.find((x) => x.paragraphIndex === 0);
      const e1 = list.find((x) => x.paragraphIndex === 1);
      if (e0.quoteHash !== paras[0].hash || e0.stale !== false) throw new Error(JSON.stringify(e0));
      if (!String(paras[0].text).includes('[非常重要]')) throw new Error('正文未改级');
      if (e1.quoteHash !== paras[1].hash) throw new Error('其他段被误改');
    });
  }

  c.section('2. 同内容多段改级：不唯一 → 失败、pending 保留、正文不变');
  {
    const s = setup(['- 心情：平静｜重复内容甲乙丙', '- 心情：平静｜重复内容甲乙丙']);
    const before = fs.readFileSync(s.file, 'utf8');
    const r = relevelLine({ match: '重复内容甲乙丙', importance: '重要', day: dateKey, root: s.dayDir });
    await c.check('返回失败、正文不变、无需登记 pending', () => {
      if (r.ok) throw new Error(JSON.stringify(r));
      // 匹配在锁外就不唯一 → 未开始操作，没有待补偿项
      if (listUnfinishedDiaryOps().length !== 0) throw new Error('不应产生 pending');
      if (fs.readFileSync(s.file, 'utf8') !== before) throw new Error('正文被改');
    });
  }

  c.section('3. 相似段落：match 命中多段 → 拒绝');
  {
    const s = setup(['- 心情：平静｜猫猫 一号', '- 心情：平静｜猫猫 二号']);
    const before = fs.readFileSync(s.file, 'utf8');
    const r = relevelLine({ match: '猫猫', importance: '重要', day: dateKey, root: s.dayDir });
    await c.check('不唯一 → 失败且正文不变', () => {
      if (r.ok) throw new Error(JSON.stringify(r));
      if (fs.readFileSync(s.file, 'utf8') !== before) throw new Error('正文被改');
    });
  }

  c.section('4. 删除首段：受影响条目全部 stale、索引不重排');
  {
    const s = setup(['- 心情：平静｜甲段', '- 心情：平静｜乙段', '- 心情：平静｜丙段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 1, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 2, root: path.dirname(s.dayDir) });
    const r = removeLine({ match: '甲段', day: dateKey, root: s.dayDir });
    await c.check('删除成功且 pendingSync=false', () => { if (!r.ok || r.pendingSync) throw new Error(JSON.stringify(r)); });
    await c.check('原 0/1/2 全 stale、index 不变', () => {
      const list = entries();
      if (list.length !== 3) throw new Error(String(list.length));
      if (!list.every((e) => e.stale === true && e.staleReason === 'index_shifted_after_remove')) {
        throw new Error(JSON.stringify(list));
      }
      const idx = list.map((e) => e.paragraphIndex).sort();
      if (JSON.stringify(idx) !== JSON.stringify([0, 1, 2])) throw new Error('索引被重排');
    });
  }

  c.section('5. 删除中间段：只标受影响范围（>= beforeIndex）');
  {
    const s = setup(['- 心情：平静｜甲段', '- 心情：平静｜乙段', '- 心情：平静｜丙段']);
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 0, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 1, root: path.dirname(s.dayDir) });
    meta.appendDiaryEntry(dateKey, { paragraphIndex: 2, root: path.dirname(s.dayDir) });
    removeLine({ match: '乙段', day: dateKey, root: s.dayDir });
    await c.check('entry0 不变，entry1/2 stale', () => {
      const list = entries();
      const e0 = list.find((e) => e.paragraphIndex === 0);
      const e1 = list.find((e) => e.paragraphIndex === 1);
      const e2 = list.find((e) => e.paragraphIndex === 2);
      if (e0.stale !== false) throw new Error(JSON.stringify(e0));
      if (e1.stale !== true || e2.stale !== true) throw new Error(JSON.stringify(list));
    });
  }

  c.section('6. 旧格式 meta：改级/删除同步不崩、返回 skipped');
  {
    const s = setup(['- 心情：平静｜旧格式段']);
    fs.mkdirSync(path.join(TMP, 'diary-meta'), { recursive: true });
    fs.writeFileSync(metaPath(), JSON.stringify({ version: 0, legacy: true }), 'utf8');
    const r = relevelLine({ match: '旧格式段', importance: '重要', day: dateKey, root: s.dayDir });
    await c.check('改级成功；meta 无条目 → synced 或 skipped 但不崩', () => {
      if (!r.ok) throw new Error(JSON.stringify(r));
    });
    const r2 = removeLine({ match: '旧格式段', day: dateKey, root: s.dayDir });
    await c.check('删除成功、旧格式 meta 保留（lessons: 无 entries）', () => {
      if (!r2.ok) throw new Error(JSON.stringify(r2));
      const raw = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
      if (!raw || typeof raw !== 'object') throw new Error('meta 损坏');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);

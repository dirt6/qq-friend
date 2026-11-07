// D1-2c-2b 专项：writer 生成段落身份、meta 不重读正文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}


// 隔离必须在动态 import 之前
const tmp = process.env.DIARY_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'diary-identity-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
process.env.QQ_DIARY_META_WRITE = '1';
const PROD_DATA = 'E:\\dsh\\QQ-agent\\data';
const assertTemp = (p) => {
  if (String(p).toLowerCase().startsWith(PROD_DATA.toLowerCase())) throw new Error(`写到生产路径：${p}`);
};

const c = createChecker('D1-2c-2b 追加身份');
const dateKey = '2026-11-03';
const dayRoot = path.join(tmp, '日记');
const dayDir = path.join(dayRoot, '每日');
const dayFile = path.join(dayDir, `${dateKey}.md`);
const metaFile = path.join(tmp, 'diary-meta', `${dateKey}.json`);

try {
  const { write } = await import('../src/diary/writer.js');
  const meta = await import('../src/diary/meta.js');

  c.section('1. 正常追加：identity 与正文一致');
  {
    fs.rmSync(dayRoot, { recursive: true, force: true });
    fs.rmSync(path.join(tmp, 'diary-meta'), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, 'diary-idempotency.json'), { force: true });
    fs.mkdirSync(dayDir, { recursive: true });
    const r = write({ content: '第一条内容', day: dateKey, root: dayDir, source: 'test' });
    await c.check('write 成功且 pendingSync=false', () => {
      if (!r.ok || r.pendingSync) throw new Error(JSON.stringify(r));
    });
    await c.check('meta 写到临时目录（非生产）', () => {
      assertTemp(metaFile);
      if (!fs.existsSync(metaFile)) throw new Error('meta 不存在');
    });
    await c.check('entry 的 index/quoteHash 与正文段落一致', () => {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const paras = meta.splitParagraphs(fs.readFileSync(dayFile, 'utf8'));
      const e = m.entries[0];
      if (!e || e.paragraphIndex !== 0 || e.quoteHash !== paras[0].hash) throw new Error(JSON.stringify(e));
      if (e.sourceHashAfter && !e.sourceHashAfter.startsWith('sha256:')) throw new Error('缺 sourceHashAfter');
    });
  }

  c.section('2. 相同内容重复写：merged，不新增 meta');
  {
    const before = JSON.parse(fs.readFileSync(metaFile, 'utf8')).entries.length;
    const r = write({ content: '第一条内容', day: dateKey, root: dayDir, source: 'test' });
    await c.check('第二次被幂等跳过（skipped）', () => { if (!r.skipped) throw new Error(JSON.stringify(r)); });
    await c.check('meta 条目数不变', () => {
      const after = JSON.parse(fs.readFileSync(metaFile, 'utf8')).entries.length;
      if (after !== before) throw new Error(`${before} -> ${after}`);
    });
  }

  c.section('3. 空日记/新文件：write 创建正文并写 meta');
  {
    const d2 = '2026-11-04';
    fs.rmSync(path.join(tmp, 'diary-meta', `${d2}.json`), { force: true });
    const r = write({ content: '新的一天', day: d2, root: dayDir, source: 'test' });
    await c.check('write 成功、meta 一条、index=0', () => {
      if (!r.ok || r.pendingSync) throw new Error(JSON.stringify(r));
      const m = JSON.parse(fs.readFileSync(path.join(tmp, 'diary-meta', `${d2}.json`), 'utf8'));
      if (m.entries.length !== 1 || m.entries[0].paragraphIndex !== 0) throw new Error(JSON.stringify(m.entries));
    });
  }

  c.section('4. 多段正文：identity 定位到正确段落');
  {
    const d3 = '2026-11-05';
    fs.rmSync(path.join(tmp, 'diary-meta', `${d3}.json`), { force: true });
    fs.writeFileSync(path.join(dayDir, `${d3}.md`), `# ${d3} 周一\n\n## 记录\n\n- 心情：平静｜第一段\n\n- 心情：平静｜第二段\n`, 'utf8');
    const r = write({ content: '第三段新内容', day: d3, root: dayDir, source: 'test' });
    await c.check('新段落身份指向包含新内容的段落、quoteHash 对得上', () => {
      if (!r.ok || r.pendingSync) throw new Error(JSON.stringify(r));
      const m = JSON.parse(fs.readFileSync(path.join(tmp, 'diary-meta', `${d3}.json`), 'utf8'));
      const paras = meta.splitParagraphs(fs.readFileSync(path.join(dayDir, `${d3}.md`), 'utf8'));
      const e = m.entries[0];
      if (!paras[e.paragraphIndex] || !paras[e.paragraphIndex].text.includes('第三段新内容')) {
        throw new Error(JSON.stringify(e));
      }
      if (e.quoteHash !== paras[e.paragraphIndex].hash) throw new Error('quoteHash 不匹配');
    });
  }

  c.section('5. 测试隔离：生产 data 未被触碰');
  {
    await c.check('本次所有 meta 都在临时目录', () => {
      const files = fs.readdirSync(path.join(tmp, 'diary-meta')).filter((f) => f.endsWith('.json'));
      if (!files.length) throw new Error('临时目录没有 meta');
      for (const f of files) assertTemp(path.join(tmp, 'diary-meta', f));
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);

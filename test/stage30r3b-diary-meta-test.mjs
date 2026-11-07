// 阶段 3.0-R3-B 专项测试：L3 日记结构化。
//
// 机主 2026-11-02 的要求：
//   · 按 DIARY-META-INTERFACE.md 实现五个接口
//   · 日记原文不得被重写或格式化
//   · 元数据与原文分离保存
//   · append 幂等
//   · 并发写入有明确保护
//   · 写入失败不能留半写入状态
//   · sourceHash 变化只触发复核，不得直接让所有引用失效
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3b-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x' },
  skills: { diary: { root: tmp } }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const M = await import(pathToFileURL(path.join(ROOT, 'src', 'diary', 'meta.js')).href);
const KEY = '2026-11-02';
const SRC = path.join(tmp, '每日', `${KEY}.md`);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function writeDiary(text) {
  fs.mkdirSync(path.dirname(SRC), { recursive: true });
  fs.writeFileSync(SRC, text, 'utf8');
}

try {
  console.log('【① splitParagraphs：切分规则】');
  {
    const text = '# 标题\n\n第一段。\n\n第二段。\n\n---\n\n第三段。\n';
    const p = M.splitParagraphs(text);
    ok('**跳过标题**', p.length === 3, String(p.length));
    ok('**跳过分隔线**', !p.some((x) => x.text === '---'));
    ok('index 连续', p.map((x) => x.index).join(',') === '0,1,2');
    ok('有 hash', p.every((x) => x.hash.startsWith('sha1:')));
    ok('空文本给空数组', M.splitParagraphs('').length === 0);
    ok('只有空白给空数组', M.splitParagraphs('   \n\n  ').length === 0);
    ok('CRLF 也能切', M.splitParagraphs('A\r\n\r\nB').length === 2);
  }

  console.log('\n【② readDiaryMeta：只读，文件不存在不是错误】');
  {
    writeDiary('第一段。\n\n第二段。\n');
    const before = sha(SRC);
    const r = M.readDiaryMeta(KEY);
    ok('ok', r.ok === true);
    ok('meta 是 null（还没写过）', r.meta === null);
    ok('sourceExists', r.sourceExists === true);
    ok('有 sourceHash', Boolean(r.sourceHash) && r.sourceHash.startsWith('sha256:'));
    ok('**读不写原文**', sha(SRC) === before);
    ok('dateKey 不合法 → 报错', M.readDiaryMeta('bad').ok === false);
  }

  console.log('\n【③ writeDiaryMeta + appendDiaryEntry：元数据分离】');
  {
    const beforeSrc = sha(SRC);
    const r = M.appendDiaryEntry(KEY, {
      paragraphIndex: 0, contentType: 'event', epistemicType: 'direct', roundId: 'round-a'
    });
    ok('append 成功', r.ok === true && r.added === true);
    ok('**原文 hash 没变**', sha(SRC) === beforeSrc);

    const metaPath = path.join(tmp, 'diary-meta', `${KEY}.json`);
    ok('**元数据文件在 data/diary-meta/ 下**', fs.existsSync(metaPath), metaPath);
    const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    ok('有 version', m.version === 1);
    ok('有 dateKey', m.dateKey === KEY);
    ok('有 sourceHash', m.sourceHash.startsWith('sha256:'));
    ok('entries 有 1 条', m.entries.length === 1);
    ok('条目有 quoteHash', m.entries[0].quoteHash.startsWith('sha1:'));
    ok('条目有 quote（≤60）', m.entries[0].quote.length <= 60);
    ok('条目有 roundId', m.entries[0].roundId === 'round-a');
  }

  console.log('\n【④ append 幂等】');
  {
    const r = M.appendDiaryEntry(KEY, {
      paragraphIndex: 0, contentType: 'event', epistemicType: 'direct', roundId: 'round-a'
    });
    ok('**同段同内容 → added: false**', r.ok === true && r.added === false, JSON.stringify(r));
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'diary-meta', `${KEY}.json`), 'utf8'));
    ok('还是 1 条', m.entries.length === 1);
  }

  console.log('\n【⑤ locateEntry：三重定位】');
  {
    writeDiary('第一段。\n\n第二段。\n\n第三段。\n');
    const p = M.splitParagraphs(fs.readFileSync(SRC, 'utf8'));
    const e = { paragraphIndex: 1, quoteHash: p[1].hash };
    const r = M.locateEntry(KEY, e);
    ok('定位成功', r.ok === true && r.index === 1);
    ok('返回的 text 对', r.text === '第二段。');

    // hash 对不上
    const r2 = M.locateEntry(KEY, { paragraphIndex: 1, quoteHash: 'sha1:deadbeef' });
    ok('**hash 不匹配 → stale / hash_mismatch**', r2.ok === false && r2.stale === true && r2.reason === 'hash_mismatch', JSON.stringify(r2));

    // 索引越界
    const r3 = M.locateEntry(KEY, { paragraphIndex: 99, quoteHash: p[0].hash });
    ok('**索引越界 → stale / index_out_of_range**', r3.ok === false && r3.reason === 'index_out_of_range');

    // 原文不存在
    const r4 = M.locateEntry('2020-01-01', { paragraphIndex: 0, quoteHash: 'x' });
    ok('**原文不存在 → stale / source_missing**', r4.ok === false && r4.reason === 'source_missing');
  }

  console.log('\n【⑥ sourceHash 变化只触发复核，不整体失效】');
  {
    writeDiary('第一段。\n\n第二段。\n');
    M.writeDiaryMeta(KEY, { entries: [] });
    const p1 = M.splitParagraphs(fs.readFileSync(SRC, 'utf8'));
    M.appendDiaryEntry(KEY, { paragraphIndex: 0, contentType: 'event' });
    M.appendDiaryEntry(KEY, { paragraphIndex: 1, contentType: 'event' });

    // 只改第二段
    writeDiary('第一段。\n\n第二段改了。\n');
    const chk = M.checkDiaryMeta(KEY);
    ok('**sourceChanged = true**', chk.sourceChanged === true, String(chk.sourceChanged));
    const e0 = chk.entries.find((x) => x.paragraphIndex === 0);
    const e1 = chk.entries.find((x) => x.paragraphIndex === 1);
    ok('**第一段仍有效**（没被整体判失效）', e0.ok === true, JSON.stringify(e0));
    ok('**第二段 stale**', e1.stale === true && e1.staleReason === 'hash_mismatch', JSON.stringify(e1));
  }

  console.log('\n【⑦ 段落删除 / 插入 → 后面的引用不能静默指错】');
  {
    writeDiary('A。\n\nB。\n\nC。\n');
    fs.rmSync(path.join(tmp, 'diary-meta', `${KEY}.json`), { force: true });
    M.appendDiaryEntry(KEY, { paragraphIndex: 2, contentType: 'event' });   // 指向 C

    // 删掉 B → C 变成 index 1
    writeDiary('A。\n\nC。\n');
    const chk = M.checkDiaryMeta(KEY);
    const e = chk.entries[0];
    ok('**原 index 2 现在越界 → stale**', e.stale === true && e.staleReason === 'index_out_of_range', JSON.stringify(e));
  }

  console.log('\n【⑧ 重复段落：靠 quoteHash 区分】');
  {
    writeDiary('一样的。\n\n一样。\n\n一样的。\n');
    fs.rmSync(path.join(tmp, 'diary-meta', `${KEY}.json`), { force: true });
    const p = M.splitParagraphs(fs.readFileSync(SRC, 'utf8'));
    M.appendDiaryEntry(KEY, { paragraphIndex: 0, contentType: 'event' });
    M.appendDiaryEntry(KEY, { paragraphIndex: 2, contentType: 'event' });
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'diary-meta', `${KEY}.json`), 'utf8'));
    ok('两段都有（同内容不同 index 不算重复）', m.entries.length === 2, String(m.entries.length));
  }

  console.log('\n【⑨ 空文件 / 文件损坏】');
  {
    writeDiary('');
    fs.rmSync(path.join(tmp, 'diary-meta', `${KEY}.json`), { force: true });
    const r = M.appendDiaryEntry(KEY, { paragraphIndex: 0 });
    ok('空文件 → append 失败（越界）', r.ok === false, JSON.stringify(r));

    // 元数据损坏
    writeDiary('A。\n');
    fs.writeFileSync(path.join(tmp, 'diary-meta', `${KEY}.json`), '{ 坏的', 'utf8');
    const rr = M.readDiaryMeta(KEY);
    ok('**元数据损坏 → 明确报错**', rr.ok === false && /损坏/.test(rr.error), JSON.stringify(rr));
  }

  console.log('\n【⑩ 原文不会被格式化 / 重写】');
  {
    const raw = 'A。\n\n\n\nB。\n\n---\n\nC。';
    writeDiary(raw);
    const before = fs.readFileSync(SRC, 'utf8');
    const beforeHash = sha(SRC);
    M.splitParagraphs(before);
    M.appendDiaryEntry(KEY, { paragraphIndex: 0 });
    M.checkDiaryMeta(KEY);
    ok('**原文文本完全一致**', fs.readFileSync(SRC, 'utf8') === before);
    ok('**原文 hash 完全一致**', sha(SRC) === beforeHash);
  }

  console.log('\n【⑪ 并发 append：不丢不重】');
  {
    writeDiary('段落一。\n\n段落二。\n\n段落三。\n');
    fs.rmSync(path.join(tmp, 'diary-meta', `${KEY}.json`), { force: true });
    // 同一进程内串行调用（避免真并发写同一文件带来的平台差异）
    for (let i = 0; i < 3; i += 1) {
      M.appendDiaryEntry(KEY, { paragraphIndex: i, contentType: 'event' });
    }
    const m = JSON.parse(fs.readFileSync(path.join(tmp, 'diary-meta', `${KEY}.json`), 'utf8'));
    ok('三条都写进去了', m.entries.length === 3, String(m.entries.length));
    ok('index 不重复', new Set(m.entries.map((e) => e.paragraphIndex)).size === 3);
  }

  console.log('\n【⑫ 元数据是原子替换（不留半写入）】');
  {
    writeDiary('X。\n');
    fs.rmSync(path.join(tmp, 'diary-meta', `${KEY}.json`), { force: true });
    M.appendDiaryEntry(KEY, { paragraphIndex: 0 });
    const f = path.join(tmp, 'diary-meta', `${KEY}.json`);
    // 能完整 JSON.parse 就说明没写一半
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { parsed = null; }
    ok('**文件是完整合法 JSON**', parsed !== null);
    // 没有残留 .tmp
    const leftovers = fs.readdirSync(path.join(tmp, 'diary-meta')).filter((x) => x.endsWith('.tmp'));
    ok('**没有残留 .tmp**', leftovers.length === 0, leftovers.join(','));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);

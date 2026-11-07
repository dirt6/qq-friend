// 阶段 3.0-R3-C 专项测试：定位边界与迁移验证。
//
// 机主 2026-11-02 的要求：
//   · paragraphIndex 辅助定位，逐条验证 quoteHash
//   · **只有唯一且验证通过的定位才返回有效位置**
//   · 找不到 / 重复且无法消歧 / 哈希不匹配 → 标 stale
//   · **禁止根据旧索引、相似文本或模型猜测重新绑定**
//   · 覆盖：段落插入、删除、重排、重复段落、引用内容变化、文件损坏、空文件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3c-'));
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
const KEY = '2026-11-05';
const SRC = path.join(tmp, '每日', `${KEY}.md`);
const META = path.join(tmp, 'diary-meta', `${KEY}.json`);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function write(text) {
  fs.mkdirSync(path.dirname(SRC), { recursive: true });
  fs.writeFileSync(SRC, text, 'utf8');
}
function reset() {
  try { fs.rmSync(META, { force: true }); } catch { /* ignore */ }
}

try {
  console.log('【① 段落插入：后面的 index 整体后移 → 旧引用不能静默指错】');
  {
    write('A。\n\nB。\n\nC。\n');
    reset();
    M.appendDiaryEntry(KEY, { paragraphIndex: 1, contentType: 'event' });   // 指向 B

    // 在 A 后面插入 X
    write('A。\n\nX。\n\nB。\n\nC。\n');
    const chk = M.checkDiaryMeta(KEY);
    const e = chk.entries[0];
    // 原 index 1 现在是 X，hash 对不上 → stale
    ok('**插入段落 → hash_mismatch stale**', e.stale === true && e.staleReason === 'hash_mismatch', JSON.stringify(e));
    ok('**没有静默改指到新位置的 B**', e.ok === false);
  }

  console.log('\n【② 段落重排：内容还在但位置变了 → stale，不猜】');
  {
    write('A。\n\nB。\n\nC。\n');
    reset();
    M.appendDiaryEntry(KEY, { paragraphIndex: 0, contentType: 'event' });   // 指向 A

    // 重排：A 换到末尾
    write('B。\n\nC。\n\nA。\n');
    const chk = M.checkDiaryMeta(KEY);
    const e = chk.entries[0];
    ok('**重排后 stale**', e.stale === true, JSON.stringify(e));
    // A 现在还在文件里（index 2），但**不能自动绑定**
    ok('**虽然 A 还在文件里，也不自动重新绑定**', e.ok === false);
  }

  console.log('\n【③ 段落删除：后面的越界 → index_out_of_range】');
  {
    write('A。\n\nB。\n\nC。\n');
    reset();
    M.appendDiaryEntry(KEY, { paragraphIndex: 2, contentType: 'event' });   // 指向 C
    write('A。\n\nC。\n');   // 删 B，C 变 index 1
    const chk = M.checkDiaryMeta(KEY);
    ok('**越界 stale**', chk.entries[0].stale === true && chk.entries[0].staleReason === 'index_out_of_range', JSON.stringify(chk.entries[0]));
  }

  console.log('\n【④ 重复段落：index 唯一锚点 + hash 双重确认】');
  {
    write('一样的。\n\n一样。\n\n一样的。\n');
    reset();
    const p = M.splitParagraphs(fs.readFileSync(SRC, 'utf8'));
    ok('**第 0 段和第 2 段 hash 相同**', p[0].hash === p[2].hash);
    M.appendDiaryEntry(KEY, { paragraphIndex: 0, contentType: 'event' });
    M.appendDiaryEntry(KEY, { paragraphIndex: 2, contentType: 'event' });
    const chk = M.checkDiaryMeta(KEY);
    ok('两条都有效', chk.entries.every((e) => e.ok));
    ok('index 不同', chk.entries[0].paragraphIndex === 0 && chk.entries[1].paragraphIndex === 2);

    // 删掉中间那段 → 第 2 段变成第 1 段
    write('一样的。\n\n一样的。\n');
    const chk2 = M.checkDiaryMeta(KEY);
    const e0 = chk2.entries.find((x) => x.paragraphIndex === 0);
    const e2 = chk2.entries.find((x) => x.paragraphIndex === 2);
    ok('**原 index 0 仍有效**（0 还是 0）', e0.ok === true, JSON.stringify(e0));
    ok('**原 index 2 越界 stale**', e2.stale === true && e2.staleReason === 'index_out_of_range', JSON.stringify(e2));
  }

  console.log('\n【⑤ 引用内容变化：hash_mismatch】');
  {
    write('原始段落。\n');
    reset();
    M.appendDiaryEntry(KEY, { paragraphIndex: 0, contentType: 'event' });
    write('改过的段落。\n');
    const chk = M.checkDiaryMeta(KEY);
    ok('**hash_mismatch**', chk.entries[0].staleReason === 'hash_mismatch', JSON.stringify(chk.entries[0]));
    ok('sourceChanged = true', chk.sourceChanged === true);
  }

  console.log('\n【⑥ 文件损坏 / 缺失 / 空】');
  {
    write('A。\n');
    reset();
    M.appendDiaryEntry(KEY, { paragraphIndex: 0 });

    // 原文删掉
    fs.rmSync(SRC, { force: true });
    const chk = M.checkDiaryMeta(KEY);
    ok('**原文缺失 → source_missing**', chk.entries[0].staleReason === 'source_missing', JSON.stringify(chk.entries[0]));
    ok('sourceExists = false', chk.sourceExists === false);

    // 空文件
    write('');
    const chk2 = M.checkDiaryMeta(KEY);
    ok('**空文件 → index_out_of_range**', chk2.entries[0].stale === true, JSON.stringify(chk2.entries[0]));

    // 元数据损坏
    write('A。\n');
    fs.writeFileSync(META, '{ 坏的', 'utf8');
    const rr = M.readDiaryMeta(KEY);
    ok('**元数据损坏 → 明确报错**', rr.ok === false && /损坏/.test(rr.error), JSON.stringify(rr));
  }

  console.log('\n【⑦ 唯一性：只有验证通过才返回 ok】');
  {
    write('A。\n\nB。\n\nC。\n');
    const p = M.splitParagraphs(fs.readFileSync(SRC, 'utf8'));

    // 正确的条目
    ok('index + hash 都对 → ok', M.locateEntry(KEY, { paragraphIndex: 1, quoteHash: p[1].hash }).ok === true);
    // index 对但 hash 是别的段的
    ok('**index 对、hash 错 → stale**', M.locateEntry(KEY, { paragraphIndex: 1, quoteHash: p[0].hash }).stale === true);
    // hash 对但 index 是别的段
    ok('**hash 对、index 错 → stale**', M.locateEntry(KEY, { paragraphIndex: 0, quoteHash: p[1].hash }).stale === true);
    // 没有 hash
    ok('**没有 quoteHash → stale**', M.locateEntry(KEY, { paragraphIndex: 0, quoteHash: '' }).stale === true);
  }

  console.log('\n【⑧ 源级：没有「按相似文本重新绑定」的代码】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'diary', 'meta.js'), 'utf8');
    ok('**没有 similarity / 相似度**', !/similarity|相似度/.test(src));
    ok('**没有 fuzzy / 模糊匹配**', !/fuzzy|levenshtein/i.test(src));
    ok('locateEntry 只按 index + hash', /paras\[idx\]/.test(src) && /p\.hash !== wantHash/.test(src));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);

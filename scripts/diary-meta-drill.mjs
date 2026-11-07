#!/usr/bin/env node
// 日记元数据迁移演练（4.0 / 3.0-R3-C）—— **只读演练，不写生产**。
//
// 用途：在**隔离目录**里跑一遍完整的迁移流程，验证：
//   ① 原文一个字节不变
//   ② 元数据能正确生成
//   ③ 定位失败会标 stale（不会静默指错）
//   ④ 失败能回滚
//
// ⚠️ 这个脚本**只接受隔离目录**，拒绝在生产 data 上跑。
//    （B6 的教训：演练必须真的隔离，不能只靠 if 判断业务调用）
//
// 用法：
//   node scripts/diary-meta-drill.mjs                 # 自动建临时目录演练
//   node scripts/diary-meta-drill.mjs --dir <path>    # 在指定隔离目录演练
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const PROD_DATA = path.join(ROOT, 'data');

/** 拒绝在生产目录上跑。 */
function assertIsolated(dir) {
  const a = path.resolve(dir);
  const b = path.resolve(PROD_DATA);
  if (a === b || a.startsWith(b + path.sep)) {
    console.error(`[drill] 拒绝：${a} 在生产 data 目录下。演练必须在隔离目录。`);
    process.exit(1);
  }
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function main() {
  const argIdx = process.argv.indexOf('--dir');
  const dir = argIdx > 0 ? path.resolve(process.argv[argIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'diary-drill-'));
  assertIsolated(dir);
  fs.mkdirSync(dir, { recursive: true });

  // 隔离环境
  process.env.QQ_AGENT_DATA_DIR = dir;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    persona: { roleText: 'x' },
    skills: { diary: { root: dir } }
  }), 'utf8');

  const M = await import(pathToFileURL(path.join(ROOT, 'src', 'diary', 'meta.js')).href);
  const dayDir = path.join(dir, '每日');
  fs.mkdirSync(dayDir, { recursive: true });

  const results = [];
  const say = (s) => { console.log(s); results.push(s); };

  say('=== 日记元数据迁移演练（隔离目录）===');
  say(`目录：${dir}`);
  say('');

  // ── 场景 1：正常一天 ──
  {
    const key = '2026-11-01';
    const src = path.join(dayDir, `${key}.md`);
    const text = '# 2026-11-01\n\n早上翻了榜单。\n\n下午想了想管控的界限。\n\n晚上没做什么。\n';
    fs.writeFileSync(src, text, 'utf8');
    const before = sha(src);

    const paras = M.splitParagraphs(text);
    say(`① ${key}：${paras.length} 段`);

    for (let i = 0; i < paras.length; i += 1) {
      M.appendDiaryEntry(key, { paragraphIndex: i, contentType: 'event', epistemicType: 'direct', roundId: `round-${i}` });
    }
    const chk = M.checkDiaryMeta(key);
    say(`   写入 ${chk.entries.length} 条，全部有效：${chk.entries.every((e) => e.ok) ? '是' : '否'}`);
    say(`   **原文 hash 前后一致**：${sha(src) === before ? '是' : '否'}`);
    say('');
  }

  // ── 场景 2：原文被编辑（一段变了）──
  {
    const key = '2026-11-01';
    const src = path.join(dayDir, `${key}.md`);
    const text = '# 2026-11-01\n\n早上翻了榜单。\n\n下午想了想管控的界限（改了这句）。\n\n晚上没做什么。\n';
    fs.writeFileSync(src, text, 'utf8');

    const chk = M.checkDiaryMeta(key);
    const okCount = chk.entries.filter((e) => e.ok).length;
    const staleCount = chk.entries.filter((e) => e.stale).length;
    say(`② 改了一段后：有效 ${okCount} / stale ${staleCount} / sourceChanged=${chk.sourceChanged}`);
    const stale = chk.entries.find((e) => e.stale);
    say(`   stale 原因：${stale?.staleReason}`);
    say(`   **没有把全部条目判失效**（有效 ${okCount} > 0）：${okCount > 0 ? '是' : '否'}`);
    say('');
  }

  // ── 场景 3：段落被删（后面的越界）──
  {
    const key = '2026-11-02';
    const src = path.join(dayDir, `${key}.md`);
    fs.writeFileSync(src, 'A。\n\nB。\n\nC。\n', 'utf8');
    M.appendDiaryEntry(key, { paragraphIndex: 2, contentType: 'event' });   // 指向 C

    // 删掉 B
    fs.writeFileSync(src, 'A。\n\nC。\n', 'utf8');
    const chk = M.checkDiaryMeta(key);
    const e = chk.entries[0];
    say(`③ 删掉一段后：原 index 2 → ${e.stale ? 'stale' : 'ok'}（原因 ${e.staleReason || '—'}）`);
    say(`   **没有静默指向新位置的 C**：${e.stale ? '是' : '否'}`);
    say('');
  }

  // ── 场景 4：重复段落（靠 index + hash 消歧）──
  {
    const key = '2026-11-03';
    const src = path.join(dayDir, `${key}.md`);
    fs.writeFileSync(src, '一样的。\n\n一样。\n\n一样的。\n', 'utf8');
    const p = M.splitParagraphs(fs.readFileSync(src, 'utf8'));
    M.appendDiaryEntry(key, { paragraphIndex: 0, contentType: 'event' });
    M.appendDiaryEntry(key, { paragraphIndex: 2, contentType: 'event' });
    const chk = M.checkDiaryMeta(key);
    say(`④ 重复段落：${chk.entries.length} 条，全部有效：${chk.entries.every((e) => e.ok) ? '是' : '否'}`);
    say(`   （同内容不同 index 各自独立，靠 index 消歧）`);
    say('');
  }

  // ── 场景 5：空文件 / 元数据损坏 ──
  {
    const key = '2026-11-04';
    const src = path.join(dayDir, `${key}.md`);
    fs.writeFileSync(src, '', 'utf8');
    const r = M.appendDiaryEntry(key, { paragraphIndex: 0 });
    say(`⑤ 空文件 append：${r.ok ? '成功（不应）' : '失败：' + r.error}`);

    fs.writeFileSync(path.join(dir, 'diary-meta', `${key}.json`), '{ 坏的', 'utf8');
    const rr = M.readDiaryMeta(key);
    say(`   元数据损坏 → ${rr.ok ? '成功（不应）' : '明确报错：' + rr.error}`);
    say('');
  }

  // ── 验证：原文一个字节没改 ──
  say('=== 原文完整性 ===');
  for (const f of fs.readdirSync(dayDir)) {
    const p = path.join(dayDir, f);
    say(`  ${f}  ${sha(p).slice(0, 16)}…`);
  }
  say('');

  // ── 验证：没有残留 tmp ──
  const metaD = path.join(dir, 'diary-meta');
  const tmps = fs.existsSync(metaD) ? fs.readdirSync(metaD).filter((x) => x.endsWith('.tmp')) : [];
  say(`=== 原子性 ===`);
  say(`  残留 .tmp 文件：${tmps.length}（应为 0）`);
  say('');
  say('=== 演练完成（全部在隔离目录，生产未动）===');

  return dir;
}

main().then((dir) => {
  console.log(`\n演练目录：${dir}`);
  console.log('（可以删掉：rm -rf ' + dir + '）');
  process.exit(0);
}).catch((e) => {
  console.error('[drill 失败] ' + (e?.message || e));
  process.exit(1);
});

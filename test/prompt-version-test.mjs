// 提示词指纹的回归测试（2026-10-29 加）。
//
// 为什么值得测：这套东西只在出事时才有用 —— 如果它悄悄写坏了/版本算错，
// 排查时会拿着错的指纹去对错误的时间线，比没有更糟。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolationRoot, isolationEnv, cleanupIsolation, assertIsolatedPaths } from './_isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 4.0 P1：先隔离 DATA_DIR，再动态 import 业务模块。
let OWN_ISO = '';
if (process.env.QQ_AGENT_TEST_ISOLATION !== '1' || !process.env.QQ_AGENT_DATA_DIR) {
  const iso = createIsolationRoot('prompt-version-');
  OWN_ISO = iso.root;
  Object.assign(process.env, isolationEnv(iso));
}
const DATA = process.env.QQ_AGENT_DATA_DIR;
assertIsolatedPaths({ dataDir: DATA, diaryRoot: process.env.QQ_AGENT_DIARY_ROOT });
const TURNS = path.join(DATA, 'prompt-archive', 'turns.ndjson');

const {
  hashOf, promptJsVersion, learnedTemplateVersion,
  recordTurn, recentTurns, snapshotEnabled, saveSnapshot
} = await import('../src/prompt-version.js');

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
}

console.log('【hash】');
ok('同一内容哈希稳定', hashOf('abc') === hashOf('abc'));
ok('不同内容哈希不同', hashOf('abc') !== hashOf('abd'));
ok('长度固定 12', hashOf('abc').length === 12);
ok('null/undefined 不炸', typeof hashOf(null) === 'string' && typeof hashOf(undefined) === 'string');
ok('空串也有值', hashOf('').length === 12);

console.log('\n【版本】');
ok('promptJs 版本是 12 位十六进制', /^[0-9a-f]{12}$/.test(promptJsVersion()), promptJsVersion());
ok('learnedTemplate 版本是 12 位', /^[0-9a-f]{12}$/.test(learnedTemplateVersion()));
ok('两个版本不相同（来源分开）', promptJsVersion() !== learnedTemplateVersion());

console.log('\n【记录】');
const before = recentTurns(100000).length;
recordTurn({ chat: 'test:unit', backend: 'test', persona: hashOf('x'), learnedIds: ['l-1', 'l-2'] });
const after = recentTurns(100000).length;
ok('recordTurn 追加一行', after === before + 1, `${before} -> ${after}`);

const last = recentTurns(1)[0];
ok('能读回最后一行', !!last);
ok('时间戳是 ISO', !!last && /^\d{4}-\d{2}-\d{2}T/.test(last.at), last?.at);
ok('chat / backend / learnedIds 都对',
  last?.chat === 'test:unit' && last?.backend === 'test' && Array.isArray(last?.learnedIds) && last.learnedIds.length === 2);

console.log('\n【快照默认关闭】');
ok('默认不开快照', snapshotEnabled() === false);
const snap = saveSnapshot('这是不该被落盘的测试内容');
ok('默认不写快照文件', snap === '');
ok('data/prompt-archive/snapshots 没有被创建出测试文件',
  !fs.existsSync(path.join(DATA, 'prompt-archive', 'snapshots'))
  || fs.readdirSync(path.join(DATA, 'prompt-archive', 'snapshots')).filter((f) => f.includes('不该被落盘')).length === 0);

// 隔离根内不需要删除测试行；临时根统一清理。
ok('测试行只写入隔离 turns', recentTurns(100000).some((t) => t.chat === 'test:unit'));
try { if (OWN_ISO) { const cr = cleanupIsolation(OWN_ISO); if (!cr.ok) { fail += 1; console.error(`[isolation] 清理失败：${cr.error}`); } } }
catch (e) { fail += 1; console.error(`[isolation] 清理异常：${String(e?.message ?? e)}`); }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);

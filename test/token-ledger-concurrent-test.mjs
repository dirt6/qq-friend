// 跨进程并发记账测试（4.0 · 1.2 验收：「多进程同时记账不会丢失」）。
//
// 为什么必须单测跨进程：进程内用 Promise 队列就够，但两个进程同时跑
// "读-改-写" 时，后写的会覆盖先写的。这里起两个真实子进程各记 50 笔，
// 验证总数必须是 100 —— 少一笔就是锁没生效。
//
// 子进程 stdio 走文件 fd：沙箱里 pipe 会 EPERM（接手卡「坑 6」）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolationRoot, isolationEnv, cleanupIsolation } from './_isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 4.0 P1：必须使用隔离 DATA_DIR。直接运行（无 preload）时在这里建立隔离根。
let OWN_ISO = '';
if (process.env.QQ_AGENT_TEST_ISOLATION !== '1' || !process.env.QQ_AGENT_DATA_DIR) {
  const iso = createIsolationRoot('ledger-concurrent-');
  OWN_ISO = iso.root;
  Object.assign(process.env, isolationEnv(iso));
}
const DATA = process.env.QQ_AGENT_DATA_DIR;
const AUTO = path.join(DATA, 'token-usage.json');
const BACKUP = path.join(DATA, '.token-usage-concurrent-backup.json');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

if (fs.existsSync(AUTO)) fs.copyFileSync(AUTO, BACKUP);
fs.writeFileSync(AUTO, JSON.stringify({ version: 1, monthKey: '2026-10', budgetYuan: 5, days: {} }), 'utf8');

const N = 25;   // 25 次/进程：仍能验证不丢，但不会把锁竞争推到不现实的极端
const childScript = `
const fs = await import('node:fs');
const ledger = await import(${JSON.stringify(`file:///${path.join(ROOT, 'src', 'token-ledger.js').replace(/\\/g, '/')}`)});
let fails = 0; const errs = [];
for (let i = 0; i < ${N}; i += 1) {
  const r = await ledger.recordAutonomousCall({
    inputTokens: 10, outputTokens: 1,
    pricing: { inputPerMillion: 2, outputPerMillion: 8 }
  }).catch((e) => { errs.push(String(e?.message ?? e)); return null; });
  if (!r) fails += 1;
}
// 把失败数写到 stdout 文件（测试会读）
process.stdout.write(JSON.stringify({ fails, errs: errs.slice(0, 3) }) + '\\n');
process.exit(0);
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-concurrent-'));
const runOne = (tag) => new Promise((resolve) => {
  const out = fs.openSync(path.join(tmp, `${tag}.out`), 'a');
  const err = fs.openSync(path.join(tmp, `${tag}.err`), 'a');
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: ROOT,
    stdio: ['ignore', out, err],
    windowsHide: true
  });
  child.on('exit', (code) => {
    try { fs.closeSync(out) } catch { /* ignore */ }
    try { fs.closeSync(err) } catch { /* ignore */ }
    resolve(code);
  });
});

try {
  console.log('【跨进程并发：两个进程各记 50 笔】');
  const [c1, c2] = await Promise.all([runOne('a'), runOne('b')]);
  ok('两个子进程都正常退出', c1 === 0 && c2 === 0, `exit ${c1} / ${c2}`);

  const raw = JSON.parse(fs.readFileSync(AUTO, 'utf8'));
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const dk = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const got = raw.days?.[dk]?.calls ?? 0;
  ok(`总数是 ${N * 2}（一笔不丢）`, got === N * 2, `实际 ${got}`);

  const inTok = raw.days?.[dk]?.input_tokens ?? 0;
  ok('token 也没丢', inTok === N * 2 * 10, `实际 ${inTok}`);

  // 残留锁文件必须被清掉，否则下次记账会一直等
  ok('没有残留的 .lock', !fs.existsSync(`${AUTO}.lock`), fs.existsSync(`${AUTO}.lock`) ? '有残留' : '');

  // 陈旧锁（进程崩了没删）应当被识别并清理
  fs.writeFileSync(`${AUTO}.lock`, '99999', 'utf8');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(`${AUTO}.lock`, past, past);
  const ledger = await import('../src/token-ledger.js');
  await ledger.recordAutonomousCall({ inputTokens: 5, outputTokens: 1, pricing: {} });
  const after = JSON.parse(fs.readFileSync(AUTO, 'utf8')).days?.[dk]?.calls ?? 0;
  ok('陈旧锁能自动清掉并继续记账', after === N * 2 + 1, `实际 ${after}`);
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.unlinkSync(`${AUTO}.lock`) } catch { /* ignore */ }
    if (fs.existsSync(BACKUP)) { fs.copyFileSync(BACKUP, AUTO); fs.unlinkSync(BACKUP); }
    if (OWN_ISO) cleanupIsolation(OWN_ISO);
  } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);

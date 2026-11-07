// 自设醒来时间：临时文件，验证范围/到期/不再限制每天次数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-wake-'));
process.env.IDLE_WAKE_FILE = path.join(tmp, 'wake.json');
const mod = await import('../src/idle-wake.js');
const { setSelfWake, readSelfWake, consumeSelfWake } = mod;
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const now = new Date('2026-11-05T12:00:00+08:00').getTime();
const a = setSelfWake({ afterMinutes: 60, reason: '等回话', now });
ok('设置 60 分钟后', a.ok === true && readSelfWake(now)?.due === false);
ok('到期后 due', readSelfWake(now + 61 * 60e3)?.due === true);
ok('消费到期', consumeSelfWake(now + 61 * 60e3)?.reason === '等回话');
ok('范围拒绝', setSelfWake({ afterMinutes: 10, now }).ok === false);

// 取消每日次数上限：连续改期都应成功（counts 只用于观察）
let allOk = true;
for (let i = 0; i < 8; i += 1) {
  const r = setSelfWake({ afterMinutes: 30 + i, reason: `第 ${i + 1} 次`, now: now + i * 60e3 });
  if (r.ok !== true) allOk = false;
}
const last = readSelfWake(now + 10 * 60e3);
ok('每天改期不再有 4 次上限', allOk === true, JSON.stringify(last?.counts));
ok('次数仍被记录（只观察）', Number(last?.counts?.['2026-11-05'] || 0) >= 8);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nIdle wake: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);

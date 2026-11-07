// 自我记忆：只注入空闲经历摘要，不注入本子/日记正文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSelfMemorySection } from '../src/self-memory.js';
import { createIdleGoalLog } from '../src/idle-goal-log.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-memory-'));
const logFile = path.join(tmp, 'log.json');
const log = createIdleGoalLog({ file: logFile, now: () => Date.now() });
log.append({ type: 'free_think', action: 'chat', title: '找老大', ok: true, done: true, summary: '问了在忙吗', next: '等他回' });
log.append({ type: 'free_think', action: 'sleep', ok: true, done: false, reason: '太晚' });
log.append({ type: 'free_think', action: 'write_notebook', title: '写本子', ok: true, done: true, summary: '记了一段' });
log.append({ type: 'free_think', action: 'browse', title: '逛小黑盒', ok: true, done: true });
log.append({ type: 'free_think', action: 'diary', title: '整理日记', ok: true, done: true });

const s = buildSelfMemorySection({ logFile, now: Date.now(), recentIdle: 5 });
ok('包含空闲经历', s.includes('你醒着的时候'));
ok('包含具体动作', s.includes('找老大') && s.includes('睡觉'));
ok('包含下一步', s.includes('等他回'));
ok('说明是自己做的', s.includes('不是脚本'));
const s3 = buildSelfMemorySection({ logFile, now: Date.now() });
ok('默认最多 3 条', (s3.match(/^- /gm) || []).length === 3, String((s3.match(/^- /gm) || []).length));
ok('默认只带最近 3 条', s3.includes('写本子') && s3.includes('逛小黑盒') && !s3.includes('找老大'));
ok('不含本子正文', !s.includes('小鲸鱼的本子'));

const empty = buildSelfMemorySection({ logFile: path.join(tmp, 'none.json') });
ok('空数据返回空串', empty === '');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nSelf memory: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);

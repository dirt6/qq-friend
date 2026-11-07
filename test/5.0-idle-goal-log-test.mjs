// 空闲运行账本：next 字段、recentActions 映射、损坏降级。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdleGoalLog } from '../src/idle-goal-log.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-goal-log-'));
const file = path.join(tmp, 'log.json');
const log = createIdleGoalLog({ file, now: () => 1000 });

const e1 = log.append({ type: 'advance_goal', title: '接星图', goalId: 'g1', action: 'browse', ok: true, done: true, next: '明天把投影补上', summary: '看了点资料' });
ok('记录 next', e1.next === '明天把投影补上');
ok('已落盘', fs.existsSync(file));

const e2 = log.append({ type: 'advance_goal', title: '接星图', goalId: 'g1', action: 'sleep', ok: true, done: false, reason: '太晚' });
ok('sleep 不推进', e2.done === false);

const ra = log.recentActions({ limit: 10 });
ok('recentActions 映射成功', ra[0].result === 'success' && ra[0].goalId === 'g1');
ok('recentActions 失败项', ra[1].result === 'failed');

const re = createIdleGoalLog({ file, now: () => 2000 });
ok('重启后读回 next', (re.recent({ limit: 5 }).find((x) => x.next) || {}).next === '明天把投影补上');

fs.writeFileSync(file, '{ broken', 'utf8');
const broken = createIdleGoalLog({ file });
ok('损坏时降级为空账本', broken.recent({ limit: 5 }).length === 0 && broken.status().healthy === false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nIdle goal log: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);

// 空闲定时器：用极小窗口/假 runner 验证每轮只跑已注册活动；静默时段仍由 think 自己决定睡不睡。
import assert from 'node:assert/strict';
import { createIdleScheduler } from '../src/idle-scheduler.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const calls = [];
const s = createIdleScheduler({ enabled: true, intervalMs: 3 * 3600e3, windowMs: 30 * 60e3, activities: ['xhh_browse', 'unknown'], runner: async (id) => { calls.push(id); return { ok: true, id }; } });
const st = s.status();
ok('状态包含 3h/30min 语义', st.intervalMinutes === 180 && st.windowMinutes === 30, JSON.stringify(st));
const r = await s.runOnce();
ok('跑已注册活动', r.ok === true && calls.includes('xhh_browse'));
ok('未知活动拒绝', r.results.some((x) => x.activity === 'unknown' && x.ok === false));
const disabled = createIdleScheduler({ enabled: false });
const d = await disabled.runOnce();
ok('禁用不跑', d.ok === false && d.reason === 'disabled');

// 静默时段：不再强制只睡；think 照跑，并告诉它现在是静默时间
const quietCalls = [];
const night = createIdleScheduler({
  enabled: true, activities: ['think', 'sleep'],
  now: () => new Date('2026-11-06T02:30:00+08:00').getTime(),
  runner: async (id, opts) => { quietCalls.push({ id, quiet: opts?.quiet }); return { ok: true, id }; }
});
const q = await night.runOnce();
ok('静默时段跑 think 而不是强制 sleep', q.ok === true && quietCalls.some((c) => c.id === 'think'), JSON.stringify(quietCalls));
ok('runner 收到 quiet 标记', quietCalls.every((c) => c.quiet === true));
ok('静默时段结果带 quiet', q.quiet === true && q.results.every((x) => x.quiet === true));

// 只注册 sleep 时仍然直接睡
const onlySleep = createIdleScheduler({
  enabled: true, activities: ['sleep'],
  runner: async (id) => ({ ok: true, id })
});
const os = await onlySleep.runOnce();
ok('只注册 sleep 时直接睡', os.ok === true && os.results[0].activity === 'sleep');

console.log(`\nIdle scheduler: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);

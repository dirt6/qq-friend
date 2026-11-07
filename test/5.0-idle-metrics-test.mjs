// R10：空闲指标聚合（纯逻辑，不读盘、不发消息）。
import { buildIdleMetrics } from '../src/idle-metrics.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const now = new Date('2026-11-05T21:00:00+08:00').getTime();
const h = 3600e3;
const entries = [
  { at: now - 30 * h, action: 'sleep', ok: true, done: false, title: '' },
  { at: now - 27 * h, action: 'chat', ok: true, done: true, title: '找老大', summary: '在忙吗' },
  { at: now - 24 * h, action: 'browse', ok: true, done: true, title: '逛小黑盒' },
  { at: now - 20 * h, action: 'share', ok: true, done: true, title: '分享' },
  { at: now - 15 * h, action: 'write_notebook', ok: true, done: true, title: '写本子' },
  { at: now - 10 * h, action: 'comment', ok: false, done: false, title: 'B站评论' },
  { at: now - 8 * h, action: 'reply', ok: true, done: true, title: 'B站回复' },
  { at: now - 2 * h, action: 'none', ok: true, done: false, title: '' },
  // 窗口外（10 天前）不应计入
  { at: now - 10 * 24 * h, action: 'chat', ok: true, done: true, title: '旧记录' }
];
const m = buildIdleMetrics({
  entries, now, windowDays: 7, pendingActive: 2, pendingAsked: 5,
  usageDays: {
    '2026-10-27': { calls: 1, input_tokens: 100, output_tokens: 10, estimated_cost_yuan: 0.01 },
    '2026-10-30': { calls: 3, input_tokens: 300, output_tokens: 30, estimated_cost_yuan: 0.02 },
    '2026-11-04': { calls: 2, input_tokens: 200, output_tokens: 20, estimated_cost_yuan: 0.03 }
  }
});
ok('窗口内轮次', m.rounds === 8, String(m.rounds));
ok('主动聊天计 1', m.activeMessages === 1);
ok('分享计 1', m.shares === 1);
ok('写日记/本子计 1', m.writes === 1);
ok('评论失败不计成功', m.comments === 0);
ok('回复成功计 1', m.replies === 1);
ok('安静跳过计 2', m.quietSkips === 2, String(m.quietSkips));
ok('完成数 5', m.done === 5, String(m.done));
ok('失败数 1', m.failed === 1);
ok('动作分布含 browse', m.actions.browse === 1);
ok('待办指标', m.pending.active === 2 && m.pending.askedTotal === 5);
ok('成本只算窗口内', m.cost.calls === 5 && m.cost.inputTokens === 500, JSON.stringify(m.cost));
ok('最近标题回退到动作', m.last === 'none', JSON.stringify(m.last));

const empty = buildIdleMetrics({ entries: [], now, usageDays: {} });
ok('空数据不报错', empty.ok === true && empty.rounds === 0 && empty.cost.yuan === 0);

console.log(`\nIdle metrics: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);

// R9：记忆治理只读视图（纯逻辑）。
import { buildGovernanceView } from '../src/memory-governance-view.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const now = new Date('2026-11-05T21:00:00+08:00').getTime();

const learned = [
  { id: 'l1', status: 'verified', sourceDay: '2026-11-01', updatedAt: '2026-11-01T10:00:00Z', correction: { count: 1 } },
  { id: 'l2', status: 'pending', sourceDay: '2026-11-03', updatedAt: '2026-11-03T10:00:00Z' },
  { id: 'l3', status: 'stable', sourceDay: '2026-11-04', updatedAt: '2026-11-04T10:00:00Z' },
  { id: 'l4', status: 'archived', sourceDay: '2026-11-04', updatedAt: '2026-11-02T10:00:00Z', corrections: 2 }
];
const pending = [
  { id: 'p1', status: 'pending', expiresAt: '2026-11-10T00:00:00Z' },
  { id: 'p2', status: 'waiting', expiresAt: '' },
  { id: 'p3', status: 'expired' },
  { id: 'p4', status: 'pending', expiresAt: '2026-11-01T00:00:00Z' }
];
const v = buildGovernanceView({ learned, pending, hubStats: { learned: 4 }, now, recentLimit: 2 });

ok('按状态计数', v.learned.byStatus.verified === 1 && v.learned.byStatus.pending === 1 && v.learned.byStatus.stable === 1);
ok('纠正过 2 条', v.learned.corrections === 2, String(v.learned.corrections));
ok('来源天数 3', v.learned.sourceDays === 3, String(v.learned.sourceDays));
ok('最近变更按时间倒序', v.learned.recent.length === 2 && v.learned.recent[0].id === 'l3', JSON.stringify(v.learned.recent));
ok('待办状态统计', v.pending.byStatus.pending === 2 && v.pending.byStatus.waiting === 1 && v.pending.byStatus.expired === 1);
ok('过期含“到点未清”的 1 条', v.pending.expired === 2, String(v.pending.expired));
ok('hub 统计原样带出', v.hub && v.hub.learned === 4);
ok('空数据不报错', buildGovernanceView({}).ok === true);

console.log(`\nMemory governance view: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);

// Token 替换语义专项测试（2026-11-03）
//
// 覆盖机主要求的三种情况 + 有界队列 + 边界。
// 全部在内存里构造，不碰生产数据。
import {
  addUsage,
  negateUsage,
  pushConflict,
  sameUsage,
  USAGE_CONFLICT_MAX
} from '../src/dsh-gateway.js';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push({ name, detail }); console.log(`✗ ${name}${detail ? ' -> ' + detail : ''}`); }
}

const U = (i, o, t) => ({ input: i, output: o, cacheRead: 0, cacheWrite: 0, total: t });

// ══════════════════════════════════════════════════════════════
// ① 基础工具函数
// ══════════════════════════════════════════════════════════════
{
  const a = U(100, 20, 120);
  ok('negateUsage 全部取负', JSON.stringify(negateUsage(a)) === JSON.stringify({ input: -100, output: -20, cacheRead: 0, cacheWrite: 0, total: -120 }), JSON.stringify(negateUsage(a)));
  ok('negateUsage(null) 返回 null', negateUsage(null) === null);
  ok('negateUsage 处理 null 字段', JSON.stringify(negateUsage({ input: null, output: 5, cacheRead: null, cacheWrite: null, total: 5 })) === JSON.stringify({ input: 0, output: -5, cacheRead: 0, cacheWrite: 0, total: -5 }));

  const sum = addUsage(a, negateUsage(a));
  ok('a + (-a) === 0', sum.input === 0 && sum.output === 0 && sum.total === 0, JSON.stringify(sum));

  ok('sameUsage 相同返回 true', sameUsage(a, { ...a }));
  ok('sameUsage 不同返回 false', !sameUsage(a, U(100, 21, 121)));
  ok('sameUsage(null, null) === true', sameUsage(null, null));
  ok('sameUsage(a, null) === false', !sameUsage(a, null));
}

// ══════════════════════════════════════════════════════════════
// ② 模拟 applyEvent 的三种情况（不依赖内部 state，自己实现同样的逻辑验证）
// ══════════════════════════════════════════════════════════════

// 复刻 applyEvent 的 step 级逻辑（纯函数形式，便于测）
function applyStepUsage(st, { turn, step, usage, seq }) {
  const key = turn + ':' + step;
  const prev = st.usageByStep.get(key);
  if (!prev) {
    st.usageByStep.set(key, usage);
    st.usageSteps.push({ turn, step, seq });
    st.usage = addUsage(st.usage, usage);
    return 'inserted';
  }
  if (sameUsage(prev, usage)) return 'idempotent';
  st.usage = addUsage(st.usage, negateUsage(prev));
  st.usage = addUsage(st.usage, usage);
  st.usageByStep.set(key, usage);
  pushConflict(st, {
    key, turn, step,
    replacedAt: new Date().toISOString(),
    source: 'step_end',
    oldUsage: { ...prev },
    newUsage: { ...usage }
  });
  return 'replaced';
}

function newState() {
  return {
    usage: null,
    usageByStep: new Map(),
    usageSteps: [],
    usageConflicts: [],
    usageConflictDropped: 0,
    usageConflictDroppedFirstAt: null,
    usageConflictDroppedLastAt: null
  };
}

// 2.1 不同键 → 独立记录
{
  const st = newState();
  const r1 = applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  const r2 = applyStepUsage(st, { turn: 1, step: 2, usage: U(50, 10, 60), seq: 2 });
  ok('不同键：都 inserted', r1 === 'inserted' && r2 === 'inserted', r1 + '/' + r2);
  ok('不同键：累加', st.usage.input === 150 && st.usage.total === 180, JSON.stringify(st.usage));
  ok('不同键：无冲突', st.usageConflicts.length === 0);
}

// 2.2 相同键 + 相同 usage → 幂等跳过
{
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  const r = applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 2 });
  ok('**相同键相同 usage → idempotent**', r === 'idempotent', r);
  ok('**幂等：总量不变**', st.usage.input === 100 && st.usage.total === 120, JSON.stringify(st.usage));
  ok('**幂等：不产生冲突记录**', st.usageConflicts.length === 0, String(st.usageConflicts.length));
}

// 2.3 相同键 + 不同 usage → **替换**
{
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  const r = applyStepUsage(st, { turn: 1, step: 1, usage: U(150, 30, 180), seq: 2 });
  ok('**相同键不同 usage → replaced**', r === 'replaced', r);
  ok('**替换：用新值（150）不是旧值（100）**', st.usage.input === 150, String(st.usage.input));
  ok('**替换：总量 180 不是 120**', st.usage.total === 180, String(st.usage.total));
  ok('**替换：不是累加（300）**', st.usage.total !== 300, String(st.usage.total));
  ok('替换：产生 1 条冲突记录', st.usageConflicts.length === 1, String(st.usageConflicts.length));
  const c = st.usageConflicts[0];
  ok('冲突记录含 key', c.key === '1:1', c.key);
  ok('冲突记录含 oldUsage', c.oldUsage?.input === 100, JSON.stringify(c.oldUsage));
  ok('冲突记录含 newUsage', c.newUsage?.input === 150, JSON.stringify(c.newUsage));
  ok('冲突记录含 replacedAt', typeof c.replacedAt === 'string' && c.replacedAt.includes('T'), c.replacedAt);
  ok('冲突记录含 source', c.source === 'step_end', c.source);
}

// 2.4 同键三次不同 → 用最后一个，冲突 2 条
{
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  applyStepUsage(st, { turn: 1, step: 1, usage: U(150, 30, 180), seq: 2 });
  applyStepUsage(st, { turn: 1, step: 1, usage: U(200, 40, 240), seq: 3 });
  ok('**三次不同：用最后一个（200）**', st.usage.input === 200, String(st.usage.input));
  ok('**三次不同：总量 240**', st.usage.total === 240, String(st.usage.total));
  ok('三次不同：冲突 2 条', st.usageConflicts.length === 2, String(st.usageConflicts.length));
}

// 2.5 乱序到达（先 step2 后 step1）
{
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 2, usage: U(50, 10, 60), seq: 1 });
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 2 });
  ok('**乱序：都记录**', st.usage.input === 150, String(st.usage.input));
  ok('乱序：总量对', st.usage.total === 180, String(st.usage.total));
  ok('乱序：无冲突', st.usageConflicts.length === 0);
}

// 2.6 异常中断（只有一半）：已收到的保留
{
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  // 第二个 step 只到一半，没有 usage
  ok('**中断：已收到的保留**', st.usage.total === 120, String(st.usage.total));
  ok('中断：不崩', st.usageByStep.size === 1);
}

// 2.7 恢复：同键同 usage 再来一次（模拟重放）不重复累计
{
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 2 });  // 重放
  ok('**重放：不重复累计**', st.usage.total === 120, String(st.usage.total));
}

// ══════════════════════════════════════════════════════════════
// ③ 有界队列（100 条）
// ══════════════════════════════════════════════════════════════
{
  const st = newState();
  st.usageConflicts = [];
  // 推 150 条
  for (let i = 0; i < 150; i++) {
    pushConflict(st, { key: 'k' + i, oldUsage: U(i, 0, i), newUsage: U(i + 1, 0, i + 1) });
  }
  ok('**上限 100：队列长度不超**', st.usageConflicts.length === USAGE_CONFLICT_MAX, String(st.usageConflicts.length));
  ok('**上限 100：dropped = 50**', st.usageConflictDropped === 50, String(st.usageConflictDropped));
  ok('**保留了最新的**', st.usageConflicts[st.usageConflicts.length - 1].key === 'k149', st.usageConflicts[st.usageConflicts.length - 1].key);
  ok('**最旧的被丢了**', !st.usageConflicts.some((c) => c.key === 'k0'));
  ok('**记录了首次丢弃时间**', Boolean(st.usageConflictDroppedFirstAt), String(st.usageConflictDroppedFirstAt));
  ok('**记录了最近丢弃时间**', Boolean(st.usageConflictDroppedLastAt), String(st.usageConflictDroppedLastAt));
}

// 3.1 刚好 100 条不丢
{
  const st = newState();
  for (let i = 0; i < 100; i++) pushConflict(st, { key: 'k' + i });
  ok('刚好 100 条：不丢', st.usageConflictDropped === 0, String(st.usageConflictDropped));
  ok('刚好 100 条：长度 100', st.usageConflicts.length === 100, String(st.usageConflicts.length));
}

// 3.2 边界：pusConflict(null) 不崩
{
  let crashed = false;
  try { pushConflict(null, { k: 1 }); } catch { crashed = true; }
  ok('pushConflict(null) 不崩', !crashed);
}

// ══════════════════════════════════════════════════════════════
// ④ 和 DSH 的 addReplacing 语义对比
// ══════════════════════════════════════════════════════════════
//
// DSH 的 addReplacing(totals, previous, buckets)：
//   如果 previous 存在 → totals - previous + buckets
//   否则 → totals + buckets
//
// 我们的替换逻辑等价于：
//   if (prev) { usage = usage - prev + new } else { usage = usage + new }
{
  // 模拟 DSH 的行为
  function dshAddReplacing(totals, previous, buckets) {
    let t = totals ? { ...totals } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    if (previous) {
      t = { ...t, input: t.input - previous.input, output: t.output - previous.output, total: t.total - previous.total };
    }
    t = { ...t, input: t.input + buckets.input, output: t.output + buckets.output, total: t.total + buckets.total };
    return t;
  }

  // 我们的
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  applyStepUsage(st, { turn: 1, step: 1, usage: U(150, 30, 180), seq: 2 });
  const ours = st.usage;

  // DSH 的同样输入
  let dsh = dshAddReplacing(null, null, U(100, 20, 120));
  dsh = dshAddReplacing(dsh, U(100, 20, 120), U(150, 30, 180));

  ok('**和 DSH addReplacing 结果一致**', JSON.stringify(ours) === JSON.stringify(dsh), JSON.stringify(ours) + ' vs ' + JSON.stringify(dsh));
  ok('对比：都是 150', ours.input === 150 && dsh.input === 150);
  ok('对比：都是 180', ours.total === 180 && dsh.total === 180);
}

// 4.1 多 step 混合 + 一个替换，对比 DSH
{
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  applyStepUsage(st, { turn: 1, step: 2, usage: U(50, 10, 60), seq: 2 });
  applyStepUsage(st, { turn: 1, step: 1, usage: U(120, 25, 145), seq: 3 });  // step1 替换
  const ours = st.usage;

  function dshAddReplacing(totals, previous, buckets) {
    let t = totals ? { ...totals } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    if (previous) t = { ...t, input: t.input - previous.input, output: t.output - previous.output, total: t.total - previous.total };
    t = { ...t, input: t.input + buckets.input, output: t.output + buckets.output, total: t.total + buckets.total };
    return t;
  }
  let dsh = dshAddReplacing(null, null, U(100, 20, 120));
  dsh = dshAddReplacing(dsh, null, U(50, 10, 60));
  dsh = dshAddReplacing(dsh, U(100, 20, 120), U(120, 25, 145));

  ok('多 step + 替换：和 DSH 一致', JSON.stringify(ours) === JSON.stringify(dsh), JSON.stringify(ours) + ' vs ' + JSON.stringify(dsh));
  ok('多 step + 替换：step1=120, step2=50 → 170', ours.input === 170, String(ours.input));
}

// ══════════════════════════════════════════════════════════════
// ⑤ 负数保护：替换后不能出现负总量
// ══════════════════════════════════════════════════════════════
{
  const st = newState();
  applyStepUsage(st, { turn: 1, step: 1, usage: U(100, 20, 120), seq: 1 });
  applyStepUsage(st, { turn: 1, step: 1, usage: U(10, 2, 12), seq: 2 });  // 更小的值
  ok('**替换成更小的值：结果 12 不是 -108**', st.usage.total === 12, String(st.usage.total));
  ok('替换成更小的值：input=10', st.usage.input === 10, String(st.usage.input));
  ok('替换成更小的值：没出现负数', st.usage.input >= 0 && st.usage.total >= 0, JSON.stringify(st.usage));
}

// ══════════════════════════════════════════════════════════════
// 汇总
// ══════════════════════════════════════════════════════════════
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ' -> ' + f.detail : ''}`);
  process.exit(1);
}

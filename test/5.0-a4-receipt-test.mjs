// 5.0-A4 Decision Receipt 专项。无生产数据、无执行。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChecker } from './_harness.mjs';
import { createDecisionReceipt, canTransitionExecution, stableReceiptId } from '../src/autonomous/receipt.js';

const c = createChecker('5.0-A4 Receipt');
const src = fs.readFileSync(new URL('../src/autonomous/receipt.js', import.meta.url), 'utf8');
const purpose = { ok: true, candidates: [{ candidateId: 'p1', title: '整理计划', kind: 'advance_goal', confidence: 0.8 }], noAction: false, reason: 'has_candidates', uncertainties: [] };
const closure = { ok: true, decision: 'close', reason: 'user_thanks', unresolvedRequests: [], uncertainties: [] };
const activity = {
  ok: true, decision: 'selected', selectedActivity: { type: 'advance_goal', title: '整理计划', candidateId: 'p1', priority: 70, risk: 'low', sourceGoalIds: ['g1'], sourcePendingIds: [], budgetEstimate: { cost: 2, tokens: 2500, actions: 2 } },
  sourcePurposeIds: ['p1'], sourceGoalIds: ['g1'], sourcePendingIds: [], reason: 'selected_advance_goal',
  rejectedAlternatives: [{ candidateId: 'p2', type: 'interest_exploration', title: '兴趣', reason: 'lower_priority' }],
  risk: 'low', budgetEstimate: { cost: 2, tokens: 2500, actions: 2 }, needsConfirmation: false, uncertainties: []
};
const base = { now: '2026-11-04T15:00:00Z', purpose, closure, activity };
const run = (x) => createDecisionReceipt(x);

try {
  c.section('1. 构建与字段完整性');
  await c.check('完整 A1/A2/A3 → 回执，状态 decision_recorded', () => {
    const r = run(base);
    assert.equal(r.ok, true);
    assert.equal(r.receipt.status, 'decision_recorded');
    assert.equal(r.receipt.activity.selectedActivity.type, 'advance_goal');
    assert.deepEqual(r.receipt.sourceGoalIds, ['g1']);
    assert.deepEqual(r.receipt.sourcePurposeIds, ['p1']);
    assert.equal(r.receipt.execution.state, 'decision_recorded');
    assert.equal(r.receipt.execution.authorized, false);
  });
  await c.check('回执包含 rejected/risk/budget/uncertainty/时间/版本', () => {
    const r = run(base);
    assert.equal(r.receipt.createdAt, '2026-11-04T15:00:00.000Z');
    assert.equal(r.receipt.version, '5.0-A4');
    assert.equal(r.receipt.activity.rejectedAlternatives[0].reason, 'lower_priority');
    assert.equal(r.receipt.risk, 'low');
    assert.equal(r.receipt.budgetEstimate.cost, 2);
    assert.ok(Array.isArray(r.receipt.uncertainties));
  });
  await c.check('wait/no_action 不伪造 selectedActivity', () => {
    const r = run({ ...base, activity: { ...activity, decision: 'wait', selectedActivity: null, sourceGoalIds: [], sourcePendingIds: [], reason: 'all_candidates_rejected' } });
    assert.equal(r.receipt.activity.selectedActivity, null);
    assert.equal(r.receipt.activity.decision, 'wait');
    assert.equal(r.receipt.execution.state, 'decision_recorded');
  });
  await c.check('多候选保留候选 ID 与拒绝原因', () => {
    const r = run(base);
    assert.deepEqual(r.receipt.purpose.candidateIds, ['p1']);
    assert.equal(r.receipt.activity.rejectedAlternatives.length, 1);
  });

  c.section('2. 重复/稳定 ID');
  await c.check('同一决策重复生成 → duplicate=true，不产生第二份回执', () => {
    const a = run(base);
    const b = run({ ...base, existingReceipts: [a.receipt] });
    assert.equal(b.duplicate, true);
    assert.equal(b.receiptId, a.receiptId);
    assert.equal(b.receipt, a.receipt);
  });
  await c.check('相同内容不同时间 → 同一 receiptId（内容稳定）', () => {
    const a = run(base);
    const b = run({ ...base, now: '2026-11-04T16:00:00Z' });
    assert.equal(a.receiptId, b.receiptId);
    assert.notEqual(a.receipt.createdAt, b.receipt.createdAt);
  });
  await c.check('不同活动 → 不同 receiptId', () => {
    const a = run(base);
    const b = run({ ...base, activity: { ...activity, selectedActivity: { ...activity.selectedActivity, type: 'interest_exploration' }, sourceGoalIds: [] } });
    assert.notEqual(a.receiptId, b.receiptId);
  });
  await c.check('stableReceiptId 对 key 顺序稳定', () => {
    assert.equal(stableReceiptId({ a: 1, b: 2 }), stableReceiptId({ b: 2, a: 1 }));
  });

  c.section('3. 缺失/非法/时间');
  await c.check('缺 purpose/closure/activity → MISSING_INPUT', () => {
    for (const k of ['purpose', 'closure', 'activity']) {
      const x = { ...base }; delete x[k];
      const r = run(x);
      assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_INPUT');
    }
  });
  await c.check('A1/A2/A3 ok=false → INPUT_FAILED', () => {
    const r = run({ ...base, purpose: { ok: false, code: 'INVALID_INPUT', error: 'x' } });
    assert.equal(r.ok, false); assert.equal(r.code, 'INPUT_FAILED');
  });
  await c.check('缺/非法 now → MISSING_TIME', () => {
    for (const now of [undefined, 'bad']) {
      const r = run({ ...base, now });
      assert.equal(r.ok, false); assert.equal(r.code, 'MISSING_TIME');
    }
  });
  await c.check('非法 input → INVALID_INPUT', () => {
    for (const x of [null, [], { ...base, existingReceipts: {} }]) {
      const r = run(x); assert.equal(r.ok, false); assert.equal(r.code, 'INVALID_INPUT');
    }
  });

  c.section('4. 执行状态契约');
  await c.check('回执不含 executedActivity / 执行结果字段', () => {
    const r = run(base);
    const s = JSON.stringify(r.receipt);
    assert.ok(!s.includes('executedActivity'));
    assert.ok(!s.includes('"result"'));
    assert.equal(r.receipt.execution.state, 'decision_recorded');
  });
  await c.check('状态迁移：decision→authorized/started/succeeded；禁止跳跃', () => {
    assert.equal(canTransitionExecution('decision_recorded', 'authorized'), true);
    assert.equal(canTransitionExecution('decision_recorded', 'started'), false);
    assert.equal(canTransitionExecution('authorized', 'started'), true);
    assert.equal(canTransitionExecution('started', 'succeeded'), true);
    assert.equal(canTransitionExecution('started', 'unknown'), true);
    assert.equal(canTransitionExecution('succeeded', 'started'), false);
    assert.equal(canTransitionExecution('unknown', 'started'), false);
  });
  await c.check('输入不可变（深比较）', () => {
    const x = JSON.parse(JSON.stringify(base));
    const before = JSON.stringify(x);
    run(x);
    assert.equal(JSON.stringify(x), before);
  });
  await c.check('源码无 I/O/模型/发送/系统时钟/随机', () => {
    assert.ok(!/from ['"]node:|require\(|fetch\(|Date\.now|Math\.random|sendMessage|writeFile|appendFile|readFile/.test(src));
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
}
process.exit(c.finish() ? 0 : 1);

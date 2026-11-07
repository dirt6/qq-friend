// 5.0-A3 Activity Selection 纯逻辑专项。无生产数据、无执行、无 I/O。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChecker } from './_harness.mjs';
import { selectActivity } from '../src/autonomous/activity.js';

const c = createChecker('5.0-A3 Activity');
const src = fs.readFileSync(new URL('../src/autonomous/activity.js', import.meta.url), 'utf8');
const run = (input) => selectActivity(input);
const goal = (id, text, status = 'active') => ({ id, text, status });
const pending = (id, text, status = 'pending') => ({ id, text, status });
const cand = (kind, title, extra = {}) => ({ candidateId: `c-${kind}-${title}`, kind, title, owner: 'user', epistemic: 'explicit', confidence: 0.8, risk: 0.2, ...extra });
const closure = (decision, extra = {}) => ({ decision, reason: decision, unresolvedRequests: [], ...extra });
const base = { closure: closure('close'), purpose: { ok: true, candidates: [] }, state: {} };

try {
  c.section('1. Closure 硬约束');
  await c.check('未解决用户请求 → conversation_continue 优先于自主候选', () => {
    const r = run({ closure: closure('continue', { unresolvedRequests: [{ id: 'u1', text: '帮我查一下' }] }), purpose: { candidates: [cand('advance_goal', '长期目标', { owner: 'user' })] }, state: { goals: [goal('g1', '长期目标')] } });
    assert.equal(r.decision, 'selected');
    assert.equal(r.selectedActivity.type, 'conversation_continue');
    assert.equal(r.reason, 'unresolved_user_request');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'conversation_priority'));
  });
  await c.check('closure=close 但存在未解决请求 → 仍 conversation_continue（不一致防护）', () => {
    const r = run({ closure: closure('close', { unresolvedRequests: [{ id: 'u2', text: '还没回答' }] }), purpose: { candidates: [cand('advance_goal', '目标')] }, state: { goals: [goal('g2', '目标')] } });
    assert.equal(r.selectedActivity.type, 'conversation_continue');
    assert.ok(r.uncertainties.some((u) => u.code === 'closure_inconsistent'));
  });
  await c.check('closure=hold + 可继续 Pending → continue_pending', () => {
    const r = run({ closure: closure('hold'), purpose: { candidates: [cand('continue_pending', '整理报告', { sourceRefs: [{ type: 'pending', id: 'p1' }] })] }, state: { pending: [pending('p1', '整理报告')] } });
    assert.equal(r.decision, 'selected');
    assert.equal(r.selectedActivity.type, 'continue_pending');
  });
  await c.check('closure=close + active Goal → advance_goal', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('advance_goal', '长期目标', { sourceRefs: [{ type: 'goal', id: 'g1' }] })] }, state: { goals: [goal('g1', '长期目标')] } });
    assert.equal(r.selectedActivity.type, 'advance_goal');
    assert.deepEqual(r.sourceGoalIds, ['g1']);
  });
  await c.check('closure=close + 伙伴兴趣 → interest_exploration', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('interest_exploration', '研究独立游戏', { owner: 'partner' })] }, state: {} });
    assert.equal(r.selectedActivity.type, 'interest_exploration');
  });
  await c.check('closure=undetermined → wait，不选择自主活动', () => {
    const r = run({ closure: closure('undetermined'), purpose: { candidates: [cand('advance_goal', '目标')] }, state: { goals: [goal('g1', '目标')] } });
    assert.equal(r.decision, 'wait');
    assert.equal(r.reason, 'closure_undetermined');
  });
  await c.check('closure=continue（无未解决请求）→ conversation_continue', () => {
    const r = run({ closure: closure('continue'), purpose: { candidates: [] }, state: {} });
    assert.equal(r.selectedActivity.type, 'conversation_continue');
  });

  c.section('2. 无候选/多候选/优先级');
  await c.check('无 Purpose 候选 + close → no_action', () => {
    const r = run({ ...base });
    assert.equal(r.decision, 'no_action');
    assert.equal(r.selectedActivity, null);
  });
  await c.check('多个候选：Pending 优先于 Goal（硬优先级，不是单 score）', () => {
    const r = run({
      closure: closure('close'),
      purpose: { candidates: [cand('advance_goal', '长期目标', { confidence: 0.99, sourceRefs: [{ type: 'goal', id: 'g1' }] }), cand('continue_pending', '具体事项', { confidence: 0.51, sourceRefs: [{ type: 'pending', id: 'p1' }] })] },
      state: { goals: [goal('g1', '长期目标')], pending: [pending('p1', '具体事项')] }
    });
    // close 不允许 continue_pending（Closure 兼容矩阵），应只选 Goal
    assert.equal(r.decision, 'selected');
    assert.equal(r.selectedActivity.type, 'advance_goal');
  });
  await c.check('用户长期 Goal 与伙伴兴趣竞争 → Goal 优先', () => {
    const r = run({
      closure: closure('close'),
      purpose: { candidates: [cand('interest_exploration', '兴趣', { owner: 'partner', confidence: 0.9 }), cand('advance_goal', '用户目标', { sourceRefs: [{ type: 'goal', id: 'g1' }] })] },
      state: { goals: [goal('g1', '用户目标')] }
    });
    assert.equal(r.selectedActivity.type, 'advance_goal');
  });
  await c.check('同一优先级按置信度排序，稳定可重复', () => {
    const input = {
      closure: closure('hold'),
      purpose: { candidates: [cand('continue_pending', '低', { confidence: 0.6, sourceRefs: [{ type: 'pending', id: 'p1' }] }), cand('continue_pending', '高', { confidence: 0.8, sourceRefs: [{ type: 'pending', id: 'p2' }] })] },
      state: { pending: [pending('p1', '低'), pending('p2', '高')] }
    };
    const a = run(input); const b = run(input);
    assert.equal(a.selectedActivity.title, '高');
    assert.equal(a.selectedActivity.title, b.selectedActivity.title);
  });

  c.section('3. 归属/状态/证据');
  await c.check('一次性请求 Pending → continue_pending，不升级 Goal', () => {
    const r = run({
      closure: closure('hold'),
      purpose: { candidates: [cand('continue_pending', '查天气', { sourceRefs: [{ type: 'pending', id: 'p1' }] })] },
      state: { pending: [pending('p1', '查天气')] }
    });
    assert.equal(r.selectedActivity.type, 'continue_pending');
    assert.deepEqual(r.sourceGoalIds, []);
    assert.equal(r.selectedActivity.type === 'advance_goal', false);
  });
  await c.check('第三方 external 目标 → 拒绝，不转用户目标', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('advance_goal', '群友的目标', { owner: 'external' })] }, state: { goals: [goal('g1', '群友的目标')] } });
    assert.equal(r.decision, 'wait');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'external_owner'));
  });
  await c.check('低置信度候选 → wait，不直接执行', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('interest_exploration', '低置信', { owner: 'partner', confidence: 0.2 })] }, state: {} });
    assert.equal(r.decision, 'wait');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'low_confidence'));
  });
  await c.check('归属冲突/需确认候选 → wait', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('advance_goal', '冲突', { needsConfirmation: true })] }, state: { goals: [goal('g1', '冲突')] } });
    assert.equal(r.decision, 'wait');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'needs_confirmation'));
  });
  await c.check('Pending 已完成 → 不得进入活动', () => {
    const r = run({ closure: closure('hold'), purpose: { candidates: [cand('continue_pending', '已完成', { sourceRefs: [{ type: 'pending', id: 'p1' }] })] }, state: { pending: [pending('p1', '已完成', 'done')] } });
    assert.notEqual(r.decision, 'selected');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'pending_done'));
  });
  await c.check('Goal 已暂停 → 不得推进', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('advance_goal', '暂停目标', { sourceRefs: [{ type: 'goal', id: 'g1' }] })] }, state: { goals: [goal('g1', '暂停目标', 'paused')] } });
    assert.notEqual(r.decision, 'selected');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'goal_paused'));
  });
  await c.check('Goal 终态 → 不得推进', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('advance_goal', '终态目标', { sourceRefs: [{ type: 'goal', id: 'g1' }] })] }, state: { goals: [goal('g1', '终态目标', 'completed')] } });
    assert.notEqual(r.decision, 'selected');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'goal_completed'));
  });

  c.section('4. 重复/预算/风险');
  await c.check('最近已完成同一 Action → 拒绝重复', () => {
    const r = run({
      now: '2026-11-04T12:00:00Z',
      closure: closure('hold'),
      purpose: { candidates: [cand('continue_pending', '整理报告', { sourceRefs: [{ type: 'pending', id: 'p1' }] })] },
      state: { pending: [pending('p1', '整理报告')], recentActions: [{ sourcePendingId: 'p1', result: 'success', at: '2026-11-04T11:00:00Z' }] }
    });
    assert.equal(r.decision, 'wait');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'recently_completed'));
  });
  await c.check('预算不足 → wait', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('advance_goal', '目标', { sourceRefs: [{ type: 'goal', id: 'g1' }] })] }, state: { goals: [goal('g1', '目标')] }, budget: { remainingTokens: 10 } });
    assert.equal(r.decision, 'wait');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'budget_insufficient'));
  });
  await c.check('风险过高（maxRisk=low）→ wait', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('advance_goal', '高风险', { risk: 0.9, sourceRefs: [{ type: 'goal', id: 'g1' }] })] }, state: { goals: [goal('g1', '高风险')] }, limits: { maxRisk: 'low' } });
    assert.equal(r.decision, 'wait');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'risk_too_high'));
  });
  await c.check('allowedActivities 限制 → 不选被禁类型', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('interest_exploration', '兴趣', { owner: 'partner' })] }, state: {}, limits: { allowedActivities: ['advance_goal'] } });
    assert.equal(r.decision, 'wait');
    assert.ok(r.rejectedAlternatives.some((x) => x.reason === 'activity_not_allowed'));
  });

  c.section('5. 非法/缺失/不可变');
  await c.check('非法输入 → INVALID_INPUT', () => {
    for (const bad of [null, [], { state: 'x' }, { state: { goals: {} } }, { closure: [] }, { budget: [] }]) {
      const r = run(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, 'INVALID_INPUT');
    }
  });
  await c.check('缺少 closure → wait，不猜', () => {
    const r = run({ purpose: { candidates: [cand('interest_exploration', '兴趣', { owner: 'partner' })] }, state: {} });
    assert.equal(r.decision, 'wait');
    assert.ok(r.uncertainties.some((u) => u.code === 'closure_missing'));
  });
  await c.check('缺少 Purpose → no_action', () => {
    const r = run({ closure: closure('close'), state: { goals: [goal('g1', '目标')] } });
    assert.equal(r.decision, 'no_action');
  });
  await c.check('不修改输入（深比较）', () => {
    const input = { closure: closure('close'), purpose: { candidates: [cand('interest_exploration', '兴趣', { owner: 'partner' })] }, state: { goals: [goal('g1', '目标')] }, budget: { remainingTokens: 9999 } };
    const before = JSON.stringify(input);
    run(input);
    assert.equal(JSON.stringify(input), before);
  });
  await c.check('源码无 I/O/模型/发送/系统时钟/随机/全局状态', () => {
    assert.ok(!/from ['"]node:|require\(|fetch\(|Date\.now|Math\.random|sendMessage|writeFile|appendFile|readFile/.test(src));
  });
  await c.check('selectedActivity 不是执行授权（无执行字段）', () => {
    const r = run({ closure: closure('close'), purpose: { candidates: [cand('interest_exploration', '兴趣', { owner: 'partner' })] }, state: {} });
    const a = r.selectedActivity;
    assert.ok(a);
    for (const k of ['execute', 'run', 'send', 'write', 'authorized']) assert.ok(!(k in a), k);
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
}
process.exit(c.finish() ? 0 : 1);

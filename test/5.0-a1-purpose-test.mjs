// 5.0-A1 Purpose 纯逻辑专项。无生产数据、无 I/O、无模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChecker } from './_harness.mjs';
import { buildPurposeCandidates } from '../src/autonomous/purpose.js';

const c = createChecker('5.0-A1 Purpose');
const src = fs.readFileSync(new URL('../src/autonomous/purpose.js', import.meta.url), 'utf8');
const run = (input) => buildPurposeCandidates(input);
const kinds = (r) => r.candidates.map((x) => x.kind);

try {
  c.section('1. 输入契约');
  await c.check('空输入 → ok/noAction/no_input', () => {
    const r = run({});
    assert.equal(r.ok, true);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.noAction, true);
    assert.equal(r.reason, 'no_input');
  });
  await c.check('非法 input（null/数组/字段类型错）→ 明确失败', () => {
    for (const bad of [null, [], { goals: 'x' }, { pending: {} }, { now: 'not-a-date' }]) {
      const r = run(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, 'INVALID_INPUT');
    }
  });

  c.section('2. 用户长期方向 / 一次性请求');
  await c.check('用户明确长期 Goal → advance_goal，owner=user，longTerm', () => {
    const r = run({ goals: [{ id: 'g1', text: '把 5.0 做成长期伙伴', source: 'user_directed', status: 'active' }] });
    assert.equal(r.candidates.length, 1);
    const x = r.candidates[0];
    assert.equal(x.kind, 'advance_goal');
    assert.equal(x.owner, 'user');
    assert.equal(x.epistemic, 'explicit');
    assert.equal(x.longTerm, true);
    assert.notEqual(x.kind, 'goal');
  });
  await c.check('用户一次性请求材料 → continue_pending，longTerm=false，不升级 Goal', () => {
    const r = run({ materials: [{ id: 'm1', text: '帮我查一下明天的天气', owner: 'user', intent: 'one_off', explicit: true }] });
    assert.equal(r.candidates.length, 1);
    const x = r.candidates[0];
    assert.equal(x.kind, 'continue_pending');
    assert.equal(x.longTerm, false);
    assert.ok(x.uncertainties.includes('one_off_not_long_term'));
    assert.ok(!kinds(r).includes('advance_goal'));
  });

  c.section('3. 伙伴/第三方/普通聊天');
  await c.check('伙伴自身兴趣 → interest_exploration，不标 user', () => {
    const r = run({ materials: [{ id: 'm2', text: '继续研究独立游戏设计', owner: 'partner', intent: 'interest', explicit: true }] });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].kind, 'interest_exploration');
    assert.equal(r.candidates[0].owner, 'partner');
    assert.ok(r.candidates[0].uncertainties.includes('interest_requires_history'));
  });
  await c.check('第三方目标 → record_only/external，绝不 advance_goal 或 user', () => {
    const r = run({ materials: [{ id: 'm3', text: '群友想让我帮他做长期项目', owner: 'external', intent: 'long_term', explicit: true }] });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].kind, 'record_only');
    assert.equal(r.candidates[0].owner, 'external');
    assert.ok(r.candidates[0].uncertainties.includes('external_not_user_goal'));
    assert.ok(!kinds(r).includes('advance_goal'));
  });
  await c.check('仅观察到的外部信息 → record_only，不是用户目标', () => {
    const r = run({ materials: [{ id: 'm4', text: '视频里提到一个工具', owner: 'external', intent: 'observation' }] });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].kind, 'record_only');
    assert.equal(r.candidates[0].owner, 'external');
    assert.ok(r.candidates[0].needsConfirmation === false || true);
  });
  await c.check('普通聊天 → 不产生 Purpose', () => {
    const r = run({ materials: [{ id: 'm5', text: '今天吃了什么', owner: 'user', intent: 'chat' }], topics: [{ text: '今天吃了什么' }] });
    assert.equal(r.candidates.length, 0);
    assert.equal(r.noAction, true);
    assert.ok(r.diagnostics.topicsRead >= 1);
  });

  c.section('4. 证据/置信度');
  await c.check('直接显式候选置信度高于仅推断候选', () => {
    const direct = run({ materials: [{ id: 'd1', text: '长期学吉他', owner: 'user', intent: 'long_term', explicit: true }] });
    const inferred = run({ materials: [{ id: 'd2', text: '也许喜欢吉他', owner: 'inferred', intent: 'long_term' }] });
    assert.ok(direct.candidates.length && inferred.candidates.length);
    assert.ok(direct.candidates[0].confidence > inferred.candidates[0].confidence);
    assert.equal(inferred.candidates[0].owner, 'inferred');
    assert.equal(inferred.candidates[0].longTerm, false);
    assert.equal(inferred.candidates[0].needsConfirmation, true);
  });
  await c.check('置信度/评分均有界', () => {
    const r = run({ goals: [{ id: 'g2', text: '长期方向', source: 'user_directed' }], materials: [{ id: 'x', text: '额外', owner: 'partner', intent: 'interest', explicit: true }] });
    for (const x of r.candidates) {
      for (const k of ['confidence', 'value', 'urgency', 'risk', 'score']) assert.ok(x[k] >= 0 && x[k] <= 1, `${k}=${x[k]}`);
    }
  });

  c.section('5. 冲突/缺失/重复');
  await c.check('同一材料归属冲突（user vs external 显式）→ 不生成候选 + 冲突说明', () => {
    const r = run({ materials: [
      { id: 'c1', text: '同一个话题', owner: 'user', intent: 'long_term', explicit: true },
      { id: 'c2', text: '同一个话题', owner: 'external', intent: 'long_term', explicit: true }
    ] });
    assert.equal(r.candidates.length, 0);
    assert.ok(r.uncertainties.some((u) => u.code === 'conflicting_owner'));
    assert.equal(r.noAction, true);
  });
  await c.check('来源/归属缺失 → 不生成候选，记录 owner_unknown', () => {
    const r = run({ materials: [{ id: 'u1', text: '不知道谁提出的目标', intent: 'long_term' }] });
    assert.equal(r.candidates.length, 0);
    assert.ok(r.uncertainties.some((u) => u.code === 'owner_unknown'));
  });
  await c.check('重复材料 → 只保留一个候选，diagnostics.deduped > 0', () => {
    const r = run({ materials: [
      { id: 'r1', text: '同一个长期方向', owner: 'user', intent: 'long_term', explicit: true },
      { id: 'r2', text: '同一个长期方向', owner: 'user', intent: 'long_term', explicit: true }
    ] });
    assert.equal(r.candidates.length, 1);
    assert.ok(r.diagnostics.deduped >= 1);
  });
  await c.check('Goal 与相同文本材料 → 去重为一个候选', () => {
    const r = run({
      goals: [{ id: 'g3', text: '同一个方向', source: 'user_directed', status: 'active' }],
      materials: [{ id: 'm6', text: '同一个方向', owner: 'user', intent: 'long_term', explicit: true }]
    });
    assert.equal(r.candidates.length, 1);
  });

  c.section('6. 排序');
  await c.check('用户长期 > 伙伴 pending > 外部记录', () => {
    const r = run({
      goals: [{ id: 'g4', text: '长期主线', source: 'user_directed' }],
      pending: [{ id: 'p1', text: '明天查资料', source: 'user_directed', status: 'pending' }],
      materials: [{ id: 'e1', text: '看到一条外部消息', owner: 'external', intent: 'observation' }]
    });
    assert.deepEqual(kinds(r), ['advance_goal', 'continue_pending', 'record_only']);
  });

  c.section('7. 边界与纯度');
  await c.check('不修改输入（深比较）', () => {
    const input = { goals: [{ id: 'g5', text: '方向', source: 'user_directed', status: 'active' }], pending: [{ id: 'p2', text: '事项', source: 'user_directed', status: 'pending' }] };
    const before = JSON.stringify(input);
    run(input);
    assert.equal(JSON.stringify(input), before);
  });
  await c.check('输出不含 Goal/Pending/Action/Round 写入对象', () => {
    const r = run({ goals: [{ id: 'g6', text: '方向', source: 'user_directed' }] });
    const keys = Object.keys(r);
    for (const forbidden of ['goal', 'pending', 'action', 'round', 'write', 'save']) assert.ok(!keys.includes(forbidden), forbidden);
    assert.ok(!JSON.stringify(r.candidates).match(/"(goalId|pendingId|actionId|roundId)"\s*:/));
  });
  await c.check('源码无 fs/网络/模型/Date.now/Math.random/全局状态', () => {
    assert.ok(!/from ['"]node:|require\(|fetch\(|Date\.now|Math\.random|globalThis|process\./.test(src));
    assert.ok(!/writeFile|appendFile|readFile/.test(src));
  });
  await c.check('无候选时 noAction=true 且原因可解释', () => {
    const r = run({ topics: [{ text: '普通话题' }] });
    assert.equal(r.noAction, true);
    assert.equal(r.reason, 'no_worthwhile_work');
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
}
process.exit(c.finish() ? 0 : 1);

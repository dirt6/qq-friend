// 5.0 跨批次集成：A1→A2→A3→A4→B→C→D；只读 Store，无生产数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChecker } from './_harness.mjs';
import { createIsolationRoot, cleanupIsolation } from './_isolation.mjs';
import { buildPurposeCandidates } from '../src/autonomous/purpose.js';
import { assessConversationClosure } from '../src/autonomous/closure.js';
import { selectActivity } from '../src/autonomous/activity.js';
import { createDecisionReceipt } from '../src/autonomous/receipt.js';
import { buildContinuityContext } from '../src/autonomous/continuity.js';
import { decideShare } from '../src/autonomous/sharing.js';
import { governMemory, canReadDomain } from '../src/autonomous/memory-governance.js';

const c = createChecker('5.0 跨批次集成');
const iso = createIsolationRoot('5.0-integration-');
const readonlyStore = {
  root: iso.root,
  writes: 0,
  write() { this.writes += 1; throw new Error('readonly store: write forbidden'); },
  read() { return []; }
};
try {
  c.section('1. 一次性请求全链路');
  {
    const purpose = buildPurposeCandidates({
      materials: [{ id: 'm1', text: '帮我查一下明天天气', owner: 'user', intent: 'one_off', explicit: true }]
    });
    const closure = assessConversationClosure({ messages: [{ role: 'user', text: '我先说一件事' }, { role: 'assistant', text: '我在听' }] });
    const activity = selectActivity({
      closure,
      purpose,
      state: { pending: [{ id: 'p1', text: '帮我查一下明天天气', status: 'pending' }] }
    });
    const receipt = createDecisionReceipt({ now: '2026-11-04T15:00:00Z', purpose, closure, activity });
    await c.check('A1 一次性 longTerm=false，未产生 Goal', () => {
      assert.equal(purpose.candidates[0].kind, 'continue_pending');
      assert.equal(purpose.candidates[0].longTerm, false);
      assert.equal(activity.selectedActivity.type, 'continue_pending');
      assert.deepEqual(activity.sourceGoalIds, []);
    });
    await c.check('A3 选择后 A4 仅是 decision_recorded，不授权/不执行', () => {
      assert.equal(receipt.receipt.status, 'decision_recorded');
      assert.equal(receipt.receipt.execution.authorized, false);
      assert.equal(receipt.receipt.execution.state, 'decision_recorded');
      assert.equal(readonlyStore.writes, 0);
    });
  }

  c.section('2. 第三方目标不得成为用户目标');
  {
    const purpose = buildPurposeCandidates({ materials: [{ id: 'm2', text: '群友的长期项目', owner: 'external', intent: 'long_term', explicit: true }] });
    const closure = assessConversationClosure({ messages: [{ role: 'user', text: '谢谢' }] });
    const activity = selectActivity({ closure, purpose, state: { goals: [{ id: 'g1', text: '群友的长期项目', status: 'active' }] } });
    const receipt = createDecisionReceipt({ now: '2026-11-04T15:00:00Z', purpose, closure, activity });
    await c.check('A1 owner=external/record_only；A3 不选 advance_goal；回执不写 Goal', () => {
      assert.equal(purpose.candidates[0].owner, 'external');
      assert.equal(purpose.candidates[0].kind, 'record_only');
      assert.notEqual(activity.selectedActivity?.type, 'advance_goal');
      assert.deepEqual(receipt.receipt.sourceGoalIds, []);
    });
  }

  c.section('3. close + active Goal');
  {
    const purpose = buildPurposeCandidates({ goals: [{ id: 'g1', text: '长期学吉他', source: 'user_directed', status: 'active' }] });
    const closure = assessConversationClosure({ messages: [{ role: 'user', text: '谢谢' }] });
    const activity = selectActivity({ closure, purpose, state: { goals: [{ id: 'g1', text: '长期学吉他', status: 'active' }] } });
    const receipt = createDecisionReceipt({ now: '2026-11-04T15:00:00Z', purpose, closure, activity });
    await c.check('A3 选 advance_goal；A4 仍不授权执行', () => {
      assert.equal(activity.selectedActivity.type, 'advance_goal');
      assert.deepEqual(receipt.receipt.sourceGoalIds, ['g1']);
      assert.equal(receipt.receipt.execution.authorized, false);
    });
  }

  c.section('4. Closure 不错误控制自主生命周期');
  {
    const noPurpose = { ok: true, candidates: [], noAction: true };
    const close = assessConversationClosure({ messages: [{ role: 'user', text: '谢谢' }] });
    const hold = assessConversationClosure({ messages: [{ role: 'user', text: '我先说一件事' }, { role: 'assistant', text: '我在听' }] });
    const pendingPurpose = buildPurposeCandidates({ materials: [{ id: 'm3', text: '继续整理报告', owner: 'user', intent: 'one_off', explicit: true }] });
    await c.check('close 无候选 → no_action，不强行自主活动', () => {
      const r = selectActivity({ closure: close, purpose: noPurpose, state: {} });
      assert.equal(r.decision, 'no_action');
    });
    await c.check('hold + Pending → 仍可继续已有事项', () => {
      const r = selectActivity({ closure: hold, purpose: pendingPurpose, state: { pending: [{ id: 'p3', text: '继续整理报告', status: 'pending' }] } });
      assert.equal(r.selectedActivity.type, 'continue_pending');
    });
  }

  c.section('5. B 重复/恢复');
  {
    const r = buildContinuityContext({ pending: [{ id: 'p1', text: '整理报告', status: 'pending' }], actions: [{ actionId: 'a1', state: 'success', targetPendingId: 'p1' }] });
    await c.check('成功 Action 不重复，duplicate tick 不产生候选', () => {
      assert.ok(!r.resumeCandidates.some((x) => x.sourceId === 'p1'));
      assert.ok(r.completedItems.some((x) => x.sourceId === 'p1'));
      assert.equal(buildContinuityContext({ tickId: 't1', processedTicks: ['t1'] }).duplicateTick, true);
    });
  }

  c.section('6. C 分享与 A2 分工');
  {
    const share = decideShare({
      now: '2026-11-04T15:00:00Z',
      discovery: { title: '新工具', summary: '有用', source: 'example.com', reliability: 0.9, relevance: 0.9, value: 0.8 },
      conversation: { closureDecision: 'close' }, recentShares: []
    });
    const dup = decideShare({
      now: '2026-11-04T15:00:00Z',
      discovery: { title: '新工具', summary: '有用', source: 'example.com', reliability: 0.9, relevance: 0.9, value: 0.8 },
      conversation: { closureDecision: 'close' }, recentShares: [{ fingerprint: share.fingerprint, source: 'example.com', at: '2026-11-04T14:00:00Z' }]
    });
    await c.check('share_now 仍 sendAuthorized=false；重复发现只记录', () => {
      assert.equal(share.decision, 'share_now');
      assert.equal(share.sendAuthorized, false);
      assert.equal(dup.decision, 'record_only');
    });
  }

  c.section('7. D 治理 + 只读 Store');
  {
    const read = canReadDomain({ requester: 'autonomous', domain: 'diary', purpose: '延续话题' });
    const write = governMemory({ intents: [{ id: 'i1', domain: 'learned', content: '用户喜欢猫', source: 'chat:1', owner: 'user', epistemicType: 'explicit', evidence: ['m1'] }] });
    const correction = governMemory({ existing: [{ id: 'e1', domain: 'learned', content: '旧', version: 1, explicitCorrected: true }], intents: [{ id: 'c1', domain: 'learned', op: 'correct', correctsId: 'e1', content: '新', source: 'chat:2', owner: 'inferred', epistemicType: 'observed', evidence: ['m2'] }] });
    await c.check('读取经 Hub/Core；写入只路由不落盘；纠正保护', () => {
      assert.equal(read.ok, true);
      assert.equal(write.accepted[0].routedTo, 'learned');
      assert.equal(correction.accepted.length, 0);
      assert.equal(readonlyStore.writes, 0);
      assert.throws(() => readonlyStore.write(), /readonly/);
      readonlyStore.writes = 0; // 仅清掉上面故意探测的一次，模块本身未写
    });
  }

  c.section('8. 无生产写入');
  await c.check('全程未调用 Store 写方法，测试根仅临时目录', () => {
    assert.equal(readonlyStore.writes, 0);
    assert.ok(iso.root.includes('5.0-integration-'));
    assert.ok(!iso.root.toLowerCase().includes('qq-agent\\data'));
  });
  await c.check('模块源码无 fs/网络/发送', () => {
    for (const f of ['purpose.js', 'closure.js', 'activity.js', 'receipt.js', 'continuity.js', 'sharing.js', 'memory-governance.js']) {
      const s = fs.readFileSync(new URL(`../src/autonomous/${f}`, import.meta.url), 'utf8');
      assert.ok(!/from ['"]node:|require\(|fetch\(|sendMessage|writeFile|readFile/.test(s), f);
    }
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  cleanupIsolation(iso.root);
}
process.exit(c.finish() ? 0 : 1);

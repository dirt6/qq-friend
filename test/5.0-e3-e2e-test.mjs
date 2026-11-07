// 5.0-E3 隔离端到端演练：临时 store + Fake executor，无生产。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
import { createExecutionStore } from '../src/autonomous/execution-store.js';
import { createCoordinator, planHashOf } from '../src/autonomous/coordinator.js';
import { buildPurposeCandidates } from '../src/autonomous/purpose.js';
import { assessConversationClosure } from '../src/autonomous/closure.js';

const c = createChecker('5.0-E3 E2E');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-e2e-'));
const now = '2026-11-04T16:30:00Z';
const nowMs = Date.parse(now);
const purpose = buildPurposeCandidates({ goals: [{ id: 'g1', text: '长期目标', source: 'user_directed', status: 'active' }] });
const closure = assessConversationClosure({ messages: [{ role: 'user', text: '谢谢' }] });
const state = { goals: [{ id: 'g1', text: '长期目标', status: 'active' }] };
const auth = (r, over = {}) => ({ receiptId: r.receiptId, planHash: planHashOf(r), authorizedBy: 'owner', expiresAt: '2026-11-04T18:00:00Z', ...over });
let calls = 0;
let store;
let co;
const fresh = (name) => createExecutionStore({ file: path.join(dir, name) });

try {
  c.section('1. 正常链路');
  store = fresh('normal.json');
  co = createCoordinator({ store, now: () => nowMs, timeoutMs: 200, execute: async () => { calls += 1; return { ok: true, result: 'done' }; } });
  await c.check('A1→A2→A3→A4→授权→执行→succeeded', async () => {
    const r = await co.run({ tickId: 'n1', purposeInput: { goals: [{ id: 'g1', text: '长期目标', source: 'user_directed', status: 'active' }] }, closureInput: { messages: [{ role: 'user', text: '谢谢' }] }, activityState: state, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r.state, 'succeeded');
    assert.equal(calls, 1);
    assert.equal(r.receipt.activity.selectedActivity.type, 'advance_goal');
  });
  await c.check('同 receipt 重复 tick 不重复执行', async () => {
    const r = await co.run({ tickId: 'n1', purpose, closure, activityState: state, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r.executed, false);
    assert.equal(calls, 1);
  });

  c.section('2. 进程恢复/unknown/超时');
  await c.check('started 后进程重启 → recover 转 unknown，不自动完成', async () => {
    const s = fresh('recover.json');
    const p = buildPurposeCandidates({ goals: [{ id: 'g1', text: '长期目标', source: 'user_directed' }] });
    const rc = await import('../src/autonomous/receipt.js').then((m) => m.createDecisionReceipt({ now, purpose: p, closure, activity: { ok: true, decision: 'selected', selectedActivity: { type: 'advance_goal', title: 'x', sourceGoalIds: ['g1'] }, sourceGoalIds: ['g1'], rejectedAlternatives: [] } }));
    await s.recordReceipt(rc.receipt, { now: nowMs });
    await s.apply(rc.receipt.receiptId, { eventId: 'start', to: 'authorized', reason: 'authorization_valid', now: nowMs });
    await s.apply(rc.receipt.receiptId, { eventId: 'run', to: 'started', reason: 'start', now: nowMs });
    const rec = await s.recover({ now: nowMs + 1000 });
    assert.deepEqual(rec.recovered, [rc.receipt.receiptId]);
    assert.equal((await s.get(rc.receipt.receiptId)).state, 'unknown');
  });
  await c.check('executor timeout → unknown，重复 run 不执行', async () => {
    const s = fresh('timeout.json');
    const co2 = createCoordinator({ store: s, now: () => nowMs, timeoutMs: 30, execute: () => new Promise(() => {}) });
    const r = await co2.run({ tickId: 'to', purpose, closure, activityState: state, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r.state, 'unknown');
    const r2 = await co2.run({ tickId: 'to2', purpose, closure, activityState: state, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r2.executed, false);
  });

  c.section('3. 授权失败/篡改');
  await c.check('过期/plan 篡改 → 不执行', async () => {
    const s = fresh('auth.json');
    const co3 = createCoordinator({ store: s, now: () => nowMs, execute: async () => ({ ok: true }) });
    const expired = await co3.run({ tickId: 'a1', purpose, closure, activityState: state, authorizationFactory: (rc) => auth(rc, { expiresAt: '2026-11-04T15:00:00Z' }) });
    assert.equal(expired.executed, false);
    const tampered = await co3.run({ tickId: 'a2', purpose, closure, activityState: state, authorizationFactory: (rc) => auth(rc, { planHash: 'bad' }) });
    assert.equal(tampered.executed, false);
  });
  await c.check('pause 后不执行', async () => {
    const s = fresh('paused.json');
    await s.pause('maintenance');
    const co4 = createCoordinator({ store: s, now: () => nowMs, execute: async () => { calls += 1; return { ok: true }; } });
    const r = await co4.run({ tickId: 'p', purpose, closure, activityState: state, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r.executed, false);
    assert.equal(r.reason, 'paused');
  });

  c.section('4. 失败/分享/记忆');
  await c.check('executor 抛错 → failed；不自动重试', async () => {
    const s = fresh('failed.json');
    let n = 0;
    const co5 = createCoordinator({ store: s, now: () => nowMs, execute: async () => { n += 1; throw new Error('boom'); } });
    const r = await co5.run({ tickId: 'f', purpose, closure, activityState: state, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r.state, 'unknown');
    assert.equal(n, 1);
  });
  await c.check('share_now 不发送；memory 只路由', async () => {
    const s = fresh('share-mem.json');
    const co6 = createCoordinator({ store: s, now: () => nowMs });
    const r = await co6.run({
      tickId: 'sm', purpose: { ok: true, candidates: [] }, closure,
      activity: { ok: true, decision: 'no_action', selectedActivity: null },
      sharingInput: { discovery: { title: '发现', summary: '内容', source: 'x', reliability: 0.9, relevance: 0.9, value: 0.8 }, conversation: { closureDecision: 'close' }, recentShares: [] },
      memoryInput: { intents: [{ id: 'i', domain: 'learned', content: 'x', source: 'chat:1', owner: 'user', epistemicType: 'explicit', evidence: ['m'] }] }
    });
    assert.equal(r.sharing.sendAuthorized, false);
    assert.equal(r.memory.accepted[0].routedTo, 'learned');
    assert.equal(r.executed, false);
  });
  await c.check('对话继续 → 不触发自主执行', async () => {
    const s = fresh('conv.json');
    const co7 = createCoordinator({ store: s, now: () => nowMs, execute: async () => { calls += 1; return { ok: true }; } });
    const r = await co7.run({ tickId: 'c', purpose, closure: { ...closure, decision: 'continue', unresolvedRequests: [{ id: 'u', text: '问题' }] }, activityState: state });
    assert.equal(r.executed, false);
    assert.equal(r.reason, 'conversation_not_autonomous_execution');
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(c.finish() ? 0 : 1);

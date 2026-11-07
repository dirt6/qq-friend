// 5.0-E2 协调器专项：临时状态文件 + Fake executor，无生产。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
import { createExecutionStore } from '../src/autonomous/execution-store.js';
import { createCoordinator, planHashOf } from '../src/autonomous/coordinator.js';
import { buildPurposeCandidates } from '../src/autonomous/purpose.js';
import { assessConversationClosure } from '../src/autonomous/closure.js';

const c = createChecker('5.0-E2 Coordinator');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-coord-'));
const file = path.join(dir, 'exec.json');
const now = '2026-11-04T16:00:00Z';
const purpose = buildPurposeCandidates({ goals: [{ id: 'g1', text: '长期目标', source: 'user_directed', status: 'active' }] });
const closure = assessConversationClosure({ messages: [{ role: 'user', text: '谢谢' }] });
const activityState = { goals: [{ id: 'g1', text: '长期目标', status: 'active' }] };
let calls = 0;
let store = createExecutionStore({ file });
const coordinator = createCoordinator({ store, now: () => Date.parse(now), timeoutMs: 200, execute: async () => { calls += 1; return { ok: true, result: 'ok' }; } });
const auth = (r, over = {}) => ({ receiptId: r.receiptId, planHash: planHashOf(r), authorizedBy: 'owner', expiresAt: '2026-11-04T17:00:00Z', ...over });

try {
  c.section('1. 授权闸门');
  await c.check('无授权 → 只 decision_recorded，不执行', async () => {
    const r = await coordinator.run({ tickId: 't0', purpose, closure, activityState });
    assert.equal(r.state, 'decision_recorded');
    assert.equal(r.executed, false);
    assert.equal(calls, 0);
  });
  await c.check('授权 plan 不匹配 → 不执行', async () => {
    const r = await coordinator.run({ tickId: 't1', purpose, closure, activityState, authorization: { receiptId: 'rcpt:fake', planHash: 'bad', authorizedBy: 'owner', expiresAt: '2026-11-04T17:00:00Z' } });
    assert.equal(r.executed, false);
    assert.equal(calls, 0);
  });
  await c.check('授权过期 → 不执行', async () => {
    const r = await coordinator.run({ tickId: 't2', purpose, closure, activityState, authorizationFactory: (rc) => auth(rc, { expiresAt: '2026-11-04T15:00:00Z' }) });
    assert.equal(r.executed, false);
    assert.equal(calls, 0);
  });
  await c.check('有效授权 → 执行一次并 persisted succeeded', async () => {
    const r = await coordinator.run({ tickId: 't3', purpose, closure, activityState, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r.state, 'succeeded');
    assert.equal(r.executed, true);
    assert.equal(calls, 1);
    const rec = await store.get(r.receipt.receiptId);
    assert.equal(rec.state, 'succeeded');
    assert.equal(rec.history.some((h) => h.to === 'started'), true);
  });

  c.section('2. 幂等/暂停/unknown');
  await c.check('同一 receipt 已完成 → 重复 run 不重复执行', async () => {
    const first = await coordinator.run({ tickId: 't4', purpose, closure, activityState, authorizationFactory: (rc) => auth(rc) });
    const second = await coordinator.run({ tickId: 't4', purpose, closure, activityState, authorizationFactory: (rc) => auth(rc) });
    assert.equal(second.executed, false);
    assert.equal(calls, 1, `first=${first.state}`);
  });
  await c.check('pause → 已授权但未 started/未执行', async () => {
    const s2 = createExecutionStore({ file: path.join(dir, 'paused.json') });
    await s2.pause('maintenance');
    const co = createCoordinator({ store: s2, now: () => Date.parse(now), execute: async () => { calls += 1; return { ok: true }; } });
    const r = await co.run({ tickId: 'tp', purpose, closure, activityState, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r.executed, false);
    assert.equal(r.reason, 'paused');
  });
  await c.check('executor timeout → unknown，不自动 failed/succeeded', async () => {
    const s3 = createExecutionStore({ file: path.join(dir, 'unknown.json') });
    const co = createCoordinator({ store: s3, now: () => Date.parse(now), timeoutMs: 50, execute: () => new Promise(() => {}) });
    const r = await co.run({ tickId: 'tu', purpose, closure, activityState, authorizationFactory: (rc) => auth(rc) });
    assert.equal(r.state, 'unknown');
    const again = await co.run({ tickId: 'tu2', purpose, closure, activityState, authorizationFactory: (rc) => auth(rc) });
    assert.equal(again.executed, false);
    assert.equal(again.state, 'unknown');
  });

  c.section('3. 分享/记忆/对话');
  await c.check('share_now 只产生分享决策，不发送', async () => {
    const sharingInput = { discovery: { title: '发现', summary: '内容', source: 'x', reliability: 0.9, relevance: 0.9, value: 0.8 }, conversation: { closureDecision: 'close' }, recentShares: [] };
    const s4 = createExecutionStore({ file: path.join(dir, 'share.json') });
    const co = createCoordinator({ store: s4, now: () => Date.parse(now) });
    const r = await co.run({ tickId: 'ts', purpose: { ok: true, candidates: [] }, closure, activity: { ok: true, decision: 'no_action', selectedActivity: null }, sharingInput });
    assert.equal(r.sharing.decision, 'share_now');
    assert.equal(r.sharing.sendAuthorized, false);
    assert.equal(r.executed, false);
  });
  await c.check('memory 只路由，不写 store/领域', async () => {
    const s5 = createExecutionStore({ file: path.join(dir, 'mem.json') });
    const co = createCoordinator({ store: s5 });
    const r = await co.run({ tickId: 'tm', purpose: { ok: true, candidates: [] }, closure, activity: { ok: true, decision: 'no_action', selectedActivity: null }, memoryInput: { intents: [{ id: 'i', domain: 'learned', content: 'x', source: 'chat:1', owner: 'user', epistemicType: 'explicit', evidence: ['m'] }] } });
    assert.equal(r.memory.accepted[0].routedTo, 'learned');
    assert.equal(calls, 1); // 之前的执行计数未再增加
  });
  await c.check('conversation_continue 不作为自主执行', async () => {
    const s6 = createExecutionStore({ file: path.join(dir, 'conv.json') });
    const co = createCoordinator({ store: s6, now: () => Date.parse(now), execute: async () => { calls += 1; return { ok: true }; } });
    const closeWithUnresolved = { ...closure, decision: 'continue', unresolvedRequests: [{ id: 'u', text: '问题' }] };
    const r = await co.run({ tickId: 'tc', purpose, closure: closeWithUnresolved, activityState });
    assert.equal(r.executed, false);
    assert.equal(r.reason, 'conversation_not_autonomous_execution');
  });

  c.section('4. 无生产路径');
  await c.check('store 文件在临时目录，非生产 data', () => {
    assert.ok(file.startsWith(os.tmpdir()));
    assert.ok(!file.toLowerCase().includes('qq-agent\\data'));
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(c.finish() ? 0 : 1);

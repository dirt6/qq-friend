// 5.0-E5 P0–P2 授权/结果/执行器闸门专项。仅临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
import { createAuthorizationService } from '../src/autonomous/authorization.js';
import { classifyExecutionOutcome } from '../src/autonomous/execution-result.js';
import { validateExecution } from '../src/autonomous/executor-gate.js';
import { createExecutionStore } from '../src/autonomous/execution-store.js';
import { createCoordinator, planHashOf } from '../src/autonomous/coordinator.js';

const c = createChecker('5.0-E5 Security');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-sec-'));
const nowMs = Date.parse('2026-11-05T01:00:00Z');
const key = 'k'.repeat(64);
const key2 = 'j'.repeat(64);
const token = (svc, over = {}) => svc.sign({
  receiptId: 'rcpt:1', planHash: 'plan1', actionType: 'advance_goal', target: 'g1',
  params: { a: 1 }, authorizedBy: 'owner', issuedAt: '2026-11-05T00:59:00Z',
  expiresAt: '2026-11-05T02:00:00Z', nonce: 'n-000000000000001', ...over
});

try {
  c.section('1. HMAC 授权');
  await c.check('签名/验签 + 绑定字段通过', () => {
    const svc = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs });
    const t = token(svc);
    const r = svc.verify(t, { expected: { receiptId: 'rcpt:1', planHash: 'plan1', actionType: 'advance_goal', target: 'g1', params: { a: 1 }, scope: 'execute' } });
    assert.equal(r.ok, true);
  });
  await c.check('篡改 payload/参数/目标/动作 → 拒绝', () => {
    const svc = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs });
    const t = token(svc);
    assert.equal(svc.verify({ ...t, payload: { ...t.payload, target: 'other' } }, { expected: { target: 'other' } }).ok, false);
    assert.equal(svc.verify(t, { expected: { params: { a: 2 } } }).ok, false);
    assert.equal(svc.verify(t, { expected: { actionType: 'other' } }).ok, false);
    assert.equal(svc.verify({ ...t, sig: 'bad' }).ok, false);
  });
  await c.check('过期/未来签发/未知 key/密钥轮换 → 拒绝', () => {
    const svc = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs });
    assert.equal(svc.verify(token(svc, { expiresAt: '2026-11-05T00:00:00Z' })).ok, false);
    assert.equal(svc.verify(token(svc, { issuedAt: '2026-11-05T03:00:00Z' })).ok, false);
    const svc2 = createAuthorizationService({ keys: { k2: key2 }, keyId: 'k2', now: () => nowMs });
    assert.equal(svc2.verify(token(svc)).ok, false);
  });
  await c.check('重放/重复消费 → 拒绝', () => {
    const svc = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs });
    const t = token(svc);
    assert.equal(svc.verify(t).ok, true);
    assert.equal(svc.verify(t).ok, false);
    assert.equal(svc.verify(t).error, 'replayed');
  });
  await c.check('撤销后拒绝', () => {
    const svc = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs });
    const t = token(svc);
    svc.revokeToken(t);
    assert.equal(svc.verify(t).ok, false);
  });
  await c.check('nonce 持久化跨实例防重放', () => {
    const f = path.join(dir, 'nonce.json');
    const s1 = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs, nonceFile: f });
    const t = token(s1, { nonce: 'n-000000000000002' });
    assert.equal(s1.verify(t).ok, true);
    const s2 = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs, nonceFile: f });
    assert.equal(s2.verify(t).ok, false);
  });
  await c.check('损坏 nonce ledger → fail-closed', () => {
    const f = path.join(dir, 'bad.json'); fs.writeFileSync(f, '{bad');
    assert.throws(() => createAuthorizationService({ keys: { k1: key }, keyId: 'k1', nonceFile: f }), /corrupt/);
  });

  c.section('2. 执行结果语义');
  await c.check('throw/timeout/无 outcome → unknown（不能推断无副作用）', () => {
    assert.equal(classifyExecutionOutcome(null, { threw: true }).state, 'unknown');
    assert.equal(classifyExecutionOutcome(null, { timedOut: true }).state, 'unknown');
    assert.equal(classifyExecutionOutcome(null).state, 'unknown');
  });
  await c.check('明确 sideEffect=none 的失败 → failed；发生副作用或未知 → unknown', () => {
    assert.equal(classifyExecutionOutcome({ ok: false, sideEffect: 'none' }).state, 'failed');
    assert.equal(classifyExecutionOutcome({ ok: false, sideEffect: 'occurred' }).state, 'unknown');
    assert.equal(classifyExecutionOutcome({ ok: false }).state, 'unknown');
  });
  await c.check('ok=true → succeeded', () => assert.equal(classifyExecutionOutcome({ ok: true }).state, 'succeeded'));

  c.section('3. 执行器独立闸门');
  const tools = { advance_goal: { schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false }, tokens: 100, maxRuns: 1 } };
  const authPayload = { actionType: 'advance_goal', target: 'g1', params: { a: 1 } };
  await c.check('白名单/目标/参数/Schema 通过', () => {
    assert.equal(validateExecution({ activity: {}, plan: { tool: 'advance_goal', target: 'g1', params: { a: 1 } }, authorization: authPayload, tools }).ok, true);
  });
  await c.check('未知工具/未知参数/目标/参数不符 → 拒绝', () => {
    assert.equal(validateExecution({ plan: { tool: 'shell' }, authorization: authPayload, tools }).ok, false);
    assert.equal(validateExecution({ plan: { tool: 'advance_goal', target: 'g1', params: { a: 1, b: 2 } }, authorization: { ...authPayload, params: { a: 1, b: 2 } }, tools }).ok, false);
    assert.equal(validateExecution({ plan: { tool: 'advance_goal', target: 'other', params: { a: 1 } }, authorization: authPayload, tools }).ok, false);
    assert.equal(validateExecution({ plan: { tool: 'advance_goal', target: 'g1', params: { a: 2 } }, authorization: authPayload, tools }).ok, false);
  });
  await c.check('暂停/预算/次数 → 拒绝', () => {
    const plan = { tool: 'advance_goal', target: 'g1', params: { a: 1 } };
    assert.equal(validateExecution({ plan, authorization: authPayload, tools, paused: true }).ok, false);
    assert.equal(validateExecution({ plan, authorization: authPayload, tools, budget: { remainingTokens: 1 } }).ok, false);
    assert.equal(validateExecution({ plan, authorization: authPayload, tools, runs: 1 }).ok, false);
  });

  c.section('4. 协调器集成');
  await c.check('服务验签 + gate 成功执行一次', async () => {
    const svc = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs });
    const store = createExecutionStore({ file: path.join(dir, 'co.json') });
    let n = 0;
    const co = createCoordinator({ store, now: () => nowMs, execute: async ({ plan }) => { n += 1; assert.equal(plan.tool, 'advance_goal'); return { ok: true, sideEffect: 'occurred' }; } });
    const purpose = { ok: true, candidates: [{ candidateId: 'p1', kind: 'advance_goal', title: 'g1', owner: 'user', confidence: 0.9 }] };
    const closure = { ok: true, decision: 'close', reason: 'x', unresolvedRequests: [] };
    const r = await co.run({
      tickId: 'sec', purpose, closure,
      activity: { ok: true, decision: 'selected', selectedActivity: { type: 'advance_goal', title: 'g1', candidateId: 'p1' }, sourceGoalIds: ['g1'], rejectedAlternatives: [] },
      authorizationService: svc,
      authorizationFactory: (rc) => svc.sign({ receiptId: rc.receiptId, planHash: planHashOf(rc), actionType: 'advance_goal', target: 'g1', params: { a: 1 }, authorizedBy: 'owner', expiresAt: '2026-11-05T02:00:00Z', nonce: 'n-000000000000009' }),
      executionPlan: { tool: 'advance_goal', target: 'g1', params: { a: 1 } }, tools
    });
    assert.equal(r.state, 'succeeded', JSON.stringify({ state: r.state, reason: r.reason, executed: r.executed }));
    assert.equal(n, 1);
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(c.finish() ? 0 : 1);

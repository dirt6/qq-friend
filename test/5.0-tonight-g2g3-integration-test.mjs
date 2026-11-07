// 5.0 今晚：G2 learned 经 Coordinator、G3 QQ 经统一授权/action-executor 的隔离测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutionStore } from '../src/autonomous/execution-store.js';
import { createCoordinator, planHashOf } from '../src/autonomous/coordinator.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2g3-tonight-'));
process.env.QQ_AGENT_DATA_DIR = path.join(dir, 'data');
let pass = 0; let fail = 0;
async function check(name, fn) { try { await fn(); pass += 1; console.log(`OK    ${name}`); } catch (e) { fail += 1; console.log(`FAIL  ${name}: ${e?.message || e}`); } }

const { createLearnedAdapter } = await import('../src/autonomous/learned-adapter.js');
const { createActionExecutor } = await import('../src/autonomous/action-executor.js');
const { createQQAdapter } = await import('../src/autonomous/qq-adapter.js');
const { createAuthorizationService } = await import('../src/autonomous/authorization.js');
const learnedAdapter = createLearnedAdapter();
const executionFile = path.join(dir, 'exec.json');
const store = createExecutionStore({ file: executionFile });
const actionExecutor = createActionExecutor({ learnedAdapter });
const coordinator = createCoordinator({ store, execute: actionExecutor.execute, now: () => Date.now(), timeoutMs: 1000 });
const expiry = () => new Date(Date.now() + 3600e3).toISOString();
const auth = (rec) => ({ receiptId: rec.receiptId, planHash: planHashOf(rec), actionType: 'memory_maintenance', target: '整理记忆', params: {}, authorizedBy: 'owner', expiresAt: expiry() });
const activity = { ok: true, decision: 'memory_maintenance', selectedActivity: { type: 'memory_maintenance', title: '整理记忆', risk: 'low' } };
const purpose = { ok: true, candidates: [] };
const closure = { ok: true, decision: 'close' };
const plan = {
  kind: 'learned', tool: 'memory_maintenance', target: '整理记忆', params: {},
  intents: [{ id: 'i1', domain: 'learned', content: '用户喜欢在安静时写代码', source: 'autonomous', owner: 'user', epistemicType: 'direct' }],
  accepted: [{ intentId: 'i1', status: 'accepted' }]
};
const tools = { memory_maintenance: { schema: { type: 'object' }, maxRuns: 1 } };

await check('G2 经 Coordinator 真实写入 learned', async () => {
  const r = await coordinator.run({ tickId: 'g2-1', purpose, closure, activity, executionPlan: plan, tools, authorizationFactory: auth });
  assert.equal(r.state, 'succeeded', JSON.stringify(r));
  const item = learnedAdapter.list().find((x) => String(x.text).includes('安静时写代码'));
  assert.ok(item);
  assert.equal(item.origin.kind, 'autonomous');
});

await check('G2 同 tick/同 receipt 不重复写', async () => {
  const before = learnedAdapter.list().length;
  const r = await coordinator.run({ tickId: 'g2-1', purpose, closure, activity, executionPlan: plan, tools, authorizationFactory: auth });
  assert.equal(r.executed, false);
  assert.equal(learnedAdapter.list().length, before);
});

await check('G2 暂停时 Coordinator 不写入', async () => {
  const s = createExecutionStore({ file: path.join(dir, 'paused.json') });
  await s.pause('maintenance');
  const co = createCoordinator({ store: s, execute: actionExecutor.execute, now: () => Date.now() });
  const r = await co.run({ tickId: 'g2-paused', purpose, closure, activity, executionPlan: plan, tools, authorizationFactory: auth });
  assert.equal(r.executed, false);
  assert.equal(r.reason, 'paused');
});

await check('G2 领域抛错 → UNKNOWN，不出现 succeeded', async () => {
  const s = createExecutionStore({ file: path.join(dir, 'unknown.json') });
  const bad = createActionExecutor({ learnedAdapter: { upsert: async () => { throw new Error('disk fail'); } } });
  const co = createCoordinator({ store: s, execute: bad.execute, now: () => Date.now() });
  const p = { ...plan, intents: [{ ...plan.intents[0], id: 'i2', content: '一条会失败的自主记忆' }], accepted: [{ intentId: 'i2', status: 'accepted' }] };
  const r = await co.run({ tickId: 'g2-unknown', purpose, closure, activity, executionPlan: p, tools, authorizationFactory: auth });
  assert.equal(r.state, 'unknown', JSON.stringify(r));
});

// G3：真实 SendQueue 形状的 fake sender
let sendCalls = 0;
const fakeSender = {
  async sendTextBatch(chatKey, messages) { sendCalls += 1; return { sent: [{ text: messages[0], messageId: 9001 }], failed: [] }; }
};
const target = '1846383180';
const qqAdapter = createQQAdapter({ sender: fakeSender, target, journalFile: path.join(dir, 'send.json') });
const key = 'k'.repeat(40);
const authService = createAuthorizationService({ keys: { k1: key }, keyId: 'k1' });
const qqExecutor = createActionExecutor({ qqAdapter, authorizationService: authService });
const text = '今晚的发现';
const receipt = { receiptId: 'rcpt:g3-1' };
function shareToken(over = {}) {
  const rid = String(over.receiptId || receipt.receiptId);
  return authService.sign({ receiptId: rid, planHash: rid, actionType: 'qq.send', target, params: { text }, authorizedBy: 'owner', expiresAt: expiry(), scope: 'send', nonce: `n-${Math.random()}-${Date.now()}`, ...over });
}
const qqPlan = (token) => ({ kind: 'qq', decision: { decision: 'share_now' }, target, text, shareAuthorization: token });

await check('G3 经 sendShare/executor 发送成功并写 receipt 级 journal', async () => {
  const r = await qqExecutor.execute({ receipt, activity: { type: 'interest_exploration' }, plan: qqPlan(shareToken()) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.state, 'sent');
  assert.equal(sendCalls, 1);
});

await check('G3 nonce 重放被拒绝，不重复发送', async () => {
  const token = shareToken();
  const a = await qqExecutor.execute({ receipt, activity: { type: 'interest_exploration' }, plan: qqPlan(token) });
  assert.equal(a.ok, true);
  const b = await qqExecutor.execute({ receipt, activity: { type: 'interest_exploration' }, plan: qqPlan(token) });
  assert.equal(b.ok, false);
  assert.match(b.error, /authorization_replayed/);
});

await check('G3 文本被改 → 授权参数不匹配', async () => {
  const token = shareToken();
  const p = { ...qqPlan(token), text: '被篡改的文本' };
  const r = await qqExecutor.execute({ receipt, activity: { type: 'interest_exploration' }, plan: p });
  assert.equal(r.ok, false);
  assert.match(r.error, /authorization_binding_mismatch:params/);
});

await check('G3 目标被替换 → 目标未授权', async () => {
  const token = shareToken();
  const p = { ...qqPlan(token), target: '999999' };
  const r = await qqExecutor.execute({ receipt, activity: { type: 'interest_exploration' }, plan: p });
  assert.equal(r.ok, false);
  assert.match(r.error, /target_not_whitelisted/);
});

await check('G3 发送异常 → UNKNOWN，不再发送', async () => {
  let calls = 0;
  const badSender = { async sendTextBatch() { calls += 1; throw new Error('socket hang up'); } };
  const badQQ = createQQAdapter({ sender: badSender, target, journalFile: path.join(dir, 'unknown-send.json') });
  const ex = createActionExecutor({ qqAdapter: badQQ, authorizationService: authService });
  const r1 = await ex.execute({ receipt: { receiptId: 'rcpt:g3-u' }, activity: { type: 'interest_exploration' }, plan: qqPlan(shareToken({ receiptId: 'rcpt:g3-u' })) });
  assert.equal(r1.unknown, true, JSON.stringify(r1));
  const r2 = await ex.execute({ receipt: { receiptId: 'rcpt:g3-u' }, activity: { type: 'interest_exploration' }, plan: qqPlan(shareToken({ receiptId: 'rcpt:g3-u' })) });
  assert.equal(r2.unknown, true);
  assert.equal(calls, 1);
});

await check('G3 paused 时 executor 拒绝', async () => {
  const ex = createActionExecutor({ qqAdapter, authorizationService: authService, paused: () => true });
  const r = await ex.execute({ receipt, activity: { type: 'interest_exploration' }, plan: qqPlan(shareToken()) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'paused');
});

const { createAutonomousRuntime } = await import('../src/autonomous/runtime.js');
const runtime = createAutonomousRuntime({ file: path.join(dir, 'runtime.json'), learnedAdapter, paused: true });
await check('Runtime 默认 paused，拒绝执行', async () => {
  const r = await runtime.run({ tickId: 'rt0', purpose, closure, activity, executionPlan: plan, tools, authorizationFactory: auth });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'PAUSED');
});
await check('Runtime G2 默认 disabled', async () => {
  await runtime.setPaused(false);
  const r = await runtime.run({ tickId: 'rt1', purpose, closure, activity, executionPlan: plan, tools, authorizationFactory: auth });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'G2_DISABLED');
});
await check('Runtime 显式启用 G2 后可执行，G3 仍 disabled', async () => {
  runtime.setEnabled('g2', true);
  const r = await runtime.run({ tickId: 'rt2', purpose, closure, activity, executionPlan: { ...plan, intents: [{ ...plan.intents[0], id: 'rt-i1', content: '运行入口写下的自主记忆' }], accepted: [{ intentId: 'rt-i1', status: 'accepted' }] }, tools, authorizationFactory: auth });
  assert.equal(r.ok, true, JSON.stringify(r));
  const q = await runtime.run({ tickId: 'rt3', purpose, closure, activity: { ...activity, selectedActivity: { ...activity.selectedActivity, type: 'interest_exploration', title: '分享' } }, executionPlan: { kind: 'qq', tool: 'interest_exploration', target: '分享', params: {} }, tools, authorizationFactory: (rec) => auth(rec) });
  assert.equal(q.ok, false);
  assert.equal(q.reason, 'G3_DISABLED');
});

await check('G3 经 Runtime+Coordinator 完成两阶段授权并发送', async () => {
  let calls = 0;
  const s = { async sendTextBatch() { calls += 1; return { sent: [{ messageId: 7001 }] }; } };
  const target3 = '1846383180';
  const qa = createQQAdapter({ sender: s, target: target3, journalFile: path.join(dir, 'runtime-g3-send.json') });
  const rt = createAutonomousRuntime({ file: path.join(dir, 'runtime-g3-exec.json'), stateFile: path.join(dir, 'runtime-g3-state.json'), qqAdapter: qa, authorizationService: authService, learnedAdapter });
  await rt.setPaused(false); rt.setEnabled('g3', true);
  const text3 = 'Runtime 经 Coordinator 的分享';
  const activity3 = { ok: true, decision: 'interest_exploration', selectedActivity: { type: 'interest_exploration', title: '分享', risk: 'low' } };
  const plan3 = { kind: 'qq', tool: 'interest_exploration', target: '分享', qqTarget: target3, params: { text: text3 }, decision: { decision: 'share_now' }, text: text3 };
  const tools3 = { interest_exploration: { schema: { type: 'object' } } };
  const first = await rt.run({ tickId: 'rg3-1', purpose, closure, activity: activity3, executionPlan: plan3, tools: tools3 });
  assert.equal(first.ok, true, JSON.stringify(first));
  const rid = first.receipt.receiptId;
  const share = authService.sign({ receiptId: rid, planHash: rid, actionType: 'qq.send', target: target3, params: { text: text3 }, authorizedBy: 'owner', expiresAt: expiry(), scope: 'send', nonce: `n-${Math.random()}-${Date.now()}` });
  const coordAuth = authService.sign({ receiptId: rid, planHash: planHashOf(first.receipt), actionType: 'interest_exploration', target: '分享', params: { text: text3 }, authorizedBy: 'owner', expiresAt: expiry(), nonce: `n-${Math.random()}-${Date.now()}`, scope: 'execute' });
  const second = await rt.run({ tickId: 'rg3-1', purpose, closure, activity: activity3, executionPlan: { ...plan3, shareAuthorization: share }, tools: tools3, authorization: coordAuth });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(calls, 1);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nG2/G3 tonight integration: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
